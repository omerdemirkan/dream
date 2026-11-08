import { appendFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import type { Harness } from "@dream/domain"
import { NodeServices } from "@effect/platform-node"
import { DateTime, Effect, Option } from "effect"
import * as TurnUsage from "../src/harness/TurnUsage.ts"
import { tempDir } from "./support.ts"

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

/** A `finish` part as `HarnessAgent` streams it (from a Claude Code turn against the fake Messages API). */
const finish = (input: number, cacheRead: number, cacheWrite: number, output: number, costUsd?: number) => ({
  type: "finish",
  finishReason: "stop",
  rawFinishReason: "stop",
  totalUsage: {
    inputTokens: input + cacheRead + cacheWrite,
    inputTokenDetails: { noCacheTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    outputTokens: output,
    outputTokenDetails: { textTokens: output, reasoningTokens: undefined },
    totalTokens: input + cacheRead + cacheWrite + output
  },
  ...(costUsd === undefined ? {} : { providerMetadata: { "claude-code": { costUsd, sessionId: "session-1" } } })
})

const step = (input: number, output: number) => ({
  type: "finish-step",
  usage: { inputTokens: input, inputTokenDetails: {}, outputTokens: output, outputTokenDetails: {} }
})

const tally = (...streams: ReadonlyArray<ReadonlyArray<{ readonly type: string }>>) =>
  streams.reduce((before, parts) => TurnUsage.endStream(parts.reduce(TurnUsage.observe, before)), TurnUsage.emptyTally)

describe("the turn's streams", () => {
  it("adds up the totals of every stream", () => {
    const counted = tally(
      [{ type: "start" }, step(11_100, 10), finish(200, 20_000, 2_000, 20, 0.1)],
      [step(11_100, 10), finish(100, 10_000, 1_000, 10, 0.12)]
    )
    assert.deepStrictEqual(Option.getOrThrow(TurnUsage.agentTokens(counted)), {
      input: 300,
      cacheRead: 30_000,
      cacheWrite: 3_000,
      output: 30
    })
    assert.strictEqual(counted.claudeCostUsd, 0.12)
    assert.strictEqual(counted.claudeSessionId, "session-1")
  })

  it("counts a stream's steps when it ended without finishing", () => {
    const counted = tally([finish(100, 0, 0, 10)], [step(500, 5), step(700, 7), { type: "error" }])
    assert.deepStrictEqual(Option.getOrThrow(TurnUsage.agentTokens(counted)), {
      input: 1_300,
      cacheRead: 0,
      cacheWrite: 0,
      output: 22
    })
  })

  it("has nothing when no stream said anything", () => {
    assert.isTrue(Option.isNone(TurnUsage.agentTokens(tally([{ type: "start" }, { type: "error" }]))))
  })
})

describe("subagents' files", () => {
  it("counts each message of a Claude Code subagent transcript once", () => {
    const read = TurnUsage.fromClaudeTranscript(fixture("claude-subagent-transcript.jsonl"))
    assert.deepStrictEqual(read.tokens, { input: 6, cacheRead: 600_000, cacheWrite: 60_000, output: 6_000 })
    assert.strictEqual(read.responses, 2)
    assert.strictEqual(read.lastId, "msg_fake_30")

    // A message with two content blocks is two entries; the second, read later, isn't counted again.
    const entry = (id: string) =>
      JSON.stringify({
        type: "assistant",
        message: { id, usage: { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 } }
      })
    const first = TurnUsage.fromClaudeTranscript(`${entry("a")}\n${entry("a")}\n`)
    assert.strictEqual(first.responses, 1)
    const later = TurnUsage.fromClaudeTranscript(`${entry("a")}\n${entry("b")}\n`, first.lastId)
    assert.strictEqual(later.responses, 1)
    assert.deepStrictEqual(later.tokens, { input: 1, cacheRead: 2, cacheWrite: 0, output: 3 })
  })

  it("counts a Codex root thread's subagents' responses, not its own", () => {
    const read = TurnUsage.fromCodexRollout(
      fixture("codex-rollout-subagent.jsonl"),
      "01a1b1c8-1737-7c11-8e98-d4c156889386"
    )
    assert.deepStrictEqual(read.tokens, { input: 10_000, cacheRead: 40_000, cacheWrite: 0, output: 5_000 })
    assert.strictEqual(read.responses, 1)
    assert.strictEqual(TurnUsage.fromCodexRollout(fixture("codex-rollout-subagent.jsonl"), "another").responses, 0)
  })
})

type SettleOptions = { readonly sessionId?: string; readonly resumed?: boolean; readonly startedAt?: DateTime.Utc }

const settled = (dir: string, harness: Harness, counted: TurnUsage.Tally, options: SettleOptions = {}) =>
  TurnUsage.settle({
    harness,
    home: dir,
    stateDir: join(dir, "state"),
    tally: counted,
    sessionId: Option.fromUndefinedOr(options.sessionId ?? "session-1"),
    resumed: options.resumed ?? false,
    startedAt: options.startedAt ?? DateTime.makeUnsafe(0)
  }).pipe(Effect.provide(NodeServices.layer))

const settle = (dir: string, harness: Harness, counted: TurnUsage.Tally, options: SettleOptions = {}) =>
  settled(dir, harness, counted, options).pipe(Effect.map((result) => Option.getOrUndefined(result.usage)))

describe("settling a turn", () => {
  it.effect("adds Claude Code subagents' new messages, and the rise in cost", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const subagents = join(dir, ".claude", "projects", "-home-user-project", "session-1", "subagents")
      mkdirSync(subagents, { recursive: true })
      const transcript = fixture("claude-subagent-transcript.jsonl")
      const lines = transcript.trimEnd().split("\n")
      const half = lines.slice(0, 2).join("\n")
      writeFileSync(join(subagents, "agent-a1.jsonl"), `${half}\n`)

      const first = yield* settle(dir, "claude-code", tally([finish(200, 20_000, 2_000, 20, 0.5)]))
      assert.deepStrictEqual(first, {
        tokens: { input: 203, cacheRead: 320_000, cacheWrite: 32_000, output: 3_020 },
        costUsd: 0.5,
        subagents: "included"
      })

      // The subagent went on after the turn; the next turn counts the rest, and only the cost it added.
      appendFileSync(join(subagents, "agent-a1.jsonl"), `${lines.slice(2).join("\n")}\n`)
      const second = yield* settle(dir, "claude-code", tally([finish(100, 10_000, 1_000, 10, 0.8)]), {
        resumed: true
      })
      assert.deepStrictEqual(second?.tokens, { input: 103, cacheRead: 310_000, cacheWrite: 31_000, output: 3_010 })
      assert.closeTo(second?.costUsd ?? 0, 0.3, 1e-9)

      // Nothing new: the agent's own tokens only.
      const third = yield* settle(dir, "claude-code", tally([finish(100, 0, 0, 10, 0.9)]), { resumed: true })
      assert.deepStrictEqual(third?.tokens, { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 })
    })
  )

  it.effect("doesn't guess the cost of a resumed session it has no earlier cost for", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const usage = yield* settle(dir, "claude-code", tally([finish(100, 0, 0, 10, 12.5)]), { resumed: true })
      assert.deepStrictEqual(usage, {
        tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 },
        subagents: "included"
      })
      const next = yield* settle(dir, "claude-code", tally([finish(100, 0, 0, 10, 12.75)]), { resumed: true })
      assert.strictEqual(next?.costUsd, 0.25)
    })
  )

  it.effect("adds Codex subagents' responses from rollouts changed since the last turn", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const root = "01a1b1c8-1737-7c11-8e98-d4c156889386"
      const sessions = join(dir, ".codex", "sessions", "2026", "11", "06")
      mkdirSync(sessions, { recursive: true })
      // A rollout from before dreamd kept a ledger isn't counted.
      const old = join(sessions, "rollout-2026-11-01T10-00-00-01a1b1c0-0000-7000-8000-000000000000.jsonl")
      writeFileSync(old, fixture("codex-rollout-subagent.jsonl"))
      utimesSync(old, new Date("2026-11-01T10:00:00Z"), new Date("2026-11-01T10:00:00Z"))
      writeFileSync(
        join(sessions, "rollout-2026-11-06T16-54-02-01a1b1c8-179e-7820-acd5-51393209dc06.jsonl"),
        fixture("codex-rollout-subagent.jsonl")
      )
      const startedAt = DateTime.makeUnsafe("2026-11-06T16:50:00Z")
      const usage = yield* settle(dir, "codex", tally([finish(1_200, 1_800, 0, 30)]), { sessionId: root, startedAt })
      assert.deepStrictEqual(usage, {
        tokens: { input: 11_200, cacheRead: 41_800, cacheWrite: 0, output: 5_030 },
        subagents: "included"
      })
      const next = yield* settle(dir, "codex", tally([finish(400, 600, 0, 10)]), { sessionId: root, startedAt })
      assert.deepStrictEqual(next?.tokens, { input: 400, cacheRead: 600, cacheWrite: 0, output: 10 })
    })
  )

  it.effect("says subagents are left out when it can't tell which session to read", () =>
    Effect.gen(function* () {
      const usage = yield* TurnUsage.settle({
        harness: "codex",
        home: tempDir(),
        stateDir: join(tempDir(), "state"),
        tally: tally([finish(400, 600, 0, 10)]),
        sessionId: Option.none(),
        resumed: false,
        startedAt: DateTime.makeUnsafe(0)
      }).pipe(Effect.provide(NodeServices.layer))
      assert.strictEqual(Option.getOrThrow(usage.usage).subagents, "excluded")
    })
  )

  it.effect("reports nothing for a turn that said nothing", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* settle(tempDir(), "claude-code", TurnUsage.emptyTally))
    })
  )
})

describe("where the turn's tokens went", () => {
  const entry = (
    id: string,
    at: string,
    usage: { input: number; cacheRead: number; cacheWrite: number; output: number; hour?: number },
    model = "claude-sonnet-5-5"
  ) =>
    JSON.stringify({
      type: "assistant",
      timestamp: at,
      message: {
        id,
        model,
        usage: {
          input_tokens: usage.input,
          cache_read_input_tokens: usage.cacheRead,
          cache_creation_input_tokens: usage.cacheWrite,
          output_tokens: usage.output,
          cache_creation: {
            ephemeral_5m_input_tokens: usage.cacheWrite - (usage.hour ?? 0),
            ephemeral_1h_input_tokens: usage.hour ?? 0
          }
        }
      }
    })

  it("prices each model call by its model's family, and an hour's cache write at twice input", () => {
    const { steps } = TurnUsage.claudeSteps(fixture("claude-subagent-transcript.jsonl"))
    assert.strictEqual(steps.length, 2)
    // Opus: (3 + 1.25 × 30,000) × $4 + 300,000 × $0.20 + 3,000 × $20, per million.
    assert.closeTo(steps[0]!.cost, 0.270012, 1e-9)
    assert.strictEqual(steps[0]!.context, 330_003)

    const [hour] = TurnUsage.claudeSteps(
      entry(
        "a",
        "2026-11-07T21:00:00Z",
        { input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0, hour: 1_000_000 },
        "claude-opus-5-5"
      )
    ).steps
    assert.closeTo(hour!.cost, 8, 1e-9)
    const [unknown] = TurnUsage.claudeSteps(
      entry("b", "2026-11-07T21:00:00Z", { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 }, "<synthetic>")
    ).steps
    assert.isFalse(unknown!.priced)
  })

  it("tells a session re-sent after its cache lapsed from one that grew or compacted", () => {
    const at = (minute: number) => `2026-11-07T21:${String(minute).padStart(2, "0")}:00Z`
    const { steps } = TurnUsage.claudeSteps(
      [
        entry("a", at(0), { input: 0, cacheRead: 10_000, cacheWrite: 90_000, output: 100 }),
        // Grew by what the last step said and a tool result: written once, as it should be.
        entry("b", at(1), { input: 0, cacheRead: 100_000, cacheWrite: 10_000, output: 100 }),
        // Ten minutes on a build: the whole session goes again.
        entry("c", at(11), { input: 0, cacheRead: 0, cacheWrite: 112_000, output: 100 }),
        // A compaction right after: a fresh summary, not a lapsed cache.
        entry("d", at(12), { input: 0, cacheRead: 0, cacheWrite: 30_000, output: 100 })
      ].join("\n")
    )
    const spent = TurnUsage.spend(steps)
    assert.strictEqual(spent.steps, 4)
    assert.strictEqual(spent.peakContext, 112_000)
    // Step c sent 110,000 of its 112,000 again: that share of its write.
    assert.closeTo(spent.recached, (110_000 * 1.25 * 2) / 1e6, 1e-9)
    assert.deepStrictEqual(spent.last, { context: 30_000, at: Date.parse(at(12)) })

    // The first step of a later turn, from where the session's last one left off.
    const later = TurnUsage.spend(
      TurnUsage.claudeSteps(
        entry("e", "2026-11-07T23:00:00Z", { input: 0, cacheRead: 0, cacheWrite: 31_000, output: 10 })
      ).steps,
      spent.last
    )
    assert.closeTo(later.recached, (30_000 * 1.25 * 2) / 1e6, 1e-9)
  })

  it.effect(
    "names each session, counts only the agent's own steps since the last turn, and remembers where it left off",
    () =>
      Effect.gen(function* () {
        const dir = tempDir()
        const project = join(dir, ".claude", "projects", "-home-user-project")
        const subagents = join(project, "session-1", "subagents")
        mkdirSync(subagents, { recursive: true })
        writeFileSync(
          join(project, "session-1.jsonl"),
          `${[
            entry(
              "old",
              "2026-11-06T10:00:00Z",
              { input: 0, cacheRead: 50_000, cacheWrite: 1_000, output: 10 },
              "claude-opus-5-5"
            ),
            entry(
              "own",
              "2026-11-07T21:00:00Z",
              { input: 0, cacheRead: 51_000, cacheWrite: 1_000, output: 10 },
              "claude-opus-5-5"
            )
          ].join("\n")}\n`
        )
        writeFileSync(join(subagents, "agent-a1.jsonl"), fixture("claude-subagent-transcript.jsonl"))
        writeFileSync(
          join(subagents, "agent-a1.meta.json"),
          JSON.stringify({
            agentType: "general-purpose",
            description: "Build the engine",
            model: "opus",
            effort: "high"
          })
        )
        const startedAt = DateTime.makeUnsafe("2026-11-06T12:00:00Z")
        const first = yield* settled(dir, "claude-code", tally([finish(0, 51_000, 1_000, 10)]), { startedAt })
        assert.isTrue(first.priced)
        assert.deepStrictEqual(
          first.sessions.map(({ own, description, model, effort, steps, peakContext }) => ({
            own,
            description,
            model,
            effort,
            steps,
            peakContext
          })),
          [
            {
              own: true,
              description: undefined,
              model: "claude-opus-5-5",
              effort: undefined,
              steps: 1,
              peakContext: 52_000
            },
            {
              own: false,
              description: "Build the engine",
              model: "opus",
              effort: "high",
              steps: 2,
              peakContext: 330_003
            }
          ]
        )
        // The agent's own transcript isn't added to the ledger's tokens: its tokens come from the stream.
        assert.deepStrictEqual(Option.getOrThrow(first.usage).tokens, {
          input: 6,
          cacheRead: 651_000,
          cacheWrite: 61_000,
          output: 6_010
        })

        // An hour asleep later, the next turn's first step writes the session again.
        appendFileSync(
          join(project, "session-1.jsonl"),
          `${entry("cold", "2026-11-07T22:30:00Z", { input: 0, cacheRead: 0, cacheWrite: 53_000, output: 10 }, "claude-opus-5-5")}\n`
        )
        const second = yield* settled(dir, "claude-code", tally([finish(0, 0, 53_000, 10)]), { resumed: true })
        assert.strictEqual(second.sessions.length, 1)
        assert.closeTo(second.sessions[0]!.recached, (52_000 * 1.25 * 4) / 1e6, 1e-9)
      })
  )

  it.effect("splits a Codex turn into the root thread and its subagents, in relative units", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const root = "01a1b1c8-1737-7c11-8e98-d4c156889386"
      const sessions = join(dir, ".codex", "sessions", "2026", "11", "06")
      mkdirSync(sessions, { recursive: true })
      // The subagent's rollout repeats the root's step it forked from; the root's own rollout has it too.
      const text = fixture("codex-rollout-subagent.jsonl")
      writeFileSync(join(sessions, "rollout-2026-11-06T16-54-02-01a1b1c8-179e-7820-acd5-51393209dc06.jsonl"), text)
      writeFileSync(
        join(sessions, `rollout-2026-11-06T16-50-00-${root}.jsonl`),
        text
          .split("\n")
          .filter((line) => line.includes(`"thread_id":"${root}"`))
          .join("\n") + "\n"
      )
      const result = yield* settled(dir, "codex", tally([finish(400, 600, 0, 10)]), {
        sessionId: root,
        startedAt: DateTime.makeUnsafe("2026-11-06T16:50:00Z")
      })
      assert.isFalse(result.priced)
      const steps = (own: boolean) =>
        result.sessions.filter((session) => session.own === own).map((session) => session.steps)
      assert.deepStrictEqual(steps(true), [1])
      assert.deepStrictEqual(steps(false), [1])
      // Subagents' tokens for the ledger are as before.
      assert.deepStrictEqual(Option.getOrThrow(result.usage).tokens, {
        input: 10_400,
        cacheRead: 40_600,
        cacheWrite: 0,
        output: 5_010
      })
    })
  )
})
