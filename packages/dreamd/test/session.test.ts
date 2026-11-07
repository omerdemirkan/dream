import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { renderGuidanceNote } from "@dream/agent-context"
import { assert, describe, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Option } from "effect"
import * as Session from "../src/harness/Session.ts"
import { tempDir } from "./support.ts"

const skill = { name: "dream", description: "The dream CLI", content: "Use dream." }
const v1 = Session.guidanceOf("Prompt one.", skill)

const resumeFrom = (data: Record<string, string>) =>
  ({ type: "resume-session", harnessId: "x", specificationVersion: "harness-v1", data }) as const

const claude: Session.SavedSession = {
  harness: "claude-code",
  sessionId: "dream-prj_test",
  resumeFrom: resumeFrom({ claudeSessionId: "c1" }),
  guidance: v1
}
const codex: Session.SavedSession = {
  harness: "codex",
  sessionId: "dream-prj_test",
  resumeFrom: resumeFrom({ threadId: "t1" }),
  guidance: v1
}

const carry = (session: Session.SavedSession, guidance: Session.Guidance) =>
  Session.carryOver(session, guidance, { newSessionId: "dream-prj_test-2", handoff: Effect.succeed("HANDOFF") })

const line = (role: string, text: string) =>
  JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } })

describe("guidance", () => {
  it("is a hash of the prompt and of the skill, each on its own", () => {
    const prompt = Session.guidanceOf("Prompt two.", skill)
    const body = Session.guidanceOf("Prompt one.", { ...skill, content: "Use dream better." })
    assert.strictEqual(prompt.skill, v1.skill)
    assert.notStrictEqual(prompt.prompt, v1.prompt)
    assert.strictEqual(body.prompt, v1.prompt)
    assert.notStrictEqual(body.skill, v1.skill)
  })
})

describe("carryOver", () => {
  it.effect("leaves a session on the same guidance alone", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* carry(claude, v1)))
      assert.isTrue(Option.isNone(yield* carry(codex, v1)))
    })
  )

  it.effect("Claude Code keeps its conversation, with a note saying what changed", () =>
    Effect.gen(function* () {
      const v2 = Session.guidanceOf("Prompt two.", skill)
      const next = Option.getOrThrow(yield* carry(claude, v2))
      assert.deepStrictEqual(next, {
        ...claude,
        guidance: v2,
        preamble: renderGuidanceNote({ prompt: true, skill: false })
      })
      assert.notInclude(next.preamble ?? "", "skill")
    })
  )

  it.effect("Claude Code: a session saved before guidance was kept is told both changed", () =>
    Effect.gen(function* () {
      const { guidance: _, ...old } = claude
      const next = Option.getOrThrow(yield* carry(old, v1))
      assert.strictEqual(next.preamble, renderGuidanceNote({ prompt: true, skill: true }))
      assert.strictEqual(next.sessionId, claude.sessionId)
      assert.deepStrictEqual(next.resumeFrom, claude.resumeFrom)
    })
  )

  it.effect("Claude Code: a note still waiting makes the next one cover everything", () =>
    Effect.gen(function* () {
      const waiting = { ...claude, preamble: renderGuidanceNote({ prompt: false, skill: true }) }
      const next = Option.getOrThrow(yield* carry(waiting, Session.guidanceOf("Prompt two.", skill)))
      assert.strictEqual(next.preamble, renderGuidanceNote({ prompt: true, skill: true }))
    })
  )

  it.effect("Codex starts a new conversation with the handoff", () =>
    Effect.gen(function* () {
      const v2 = Session.guidanceOf("Prompt one.", { ...skill, description: "The dream CLI, revised" })
      const next = Option.getOrThrow(yield* carry(codex, v2))
      assert.deepStrictEqual(next, {
        harness: "codex",
        sessionId: "dream-prj_test-2",
        guidance: v2,
        preamble: "HANDOFF"
      })
    })
  )

  it.effect("Codex: a handoff still waiting is kept for the conversation after it", () =>
    Effect.gen(function* () {
      const waiting = { ...codex, preamble: "OLD HANDOFF" }
      const next = Option.getOrThrow(yield* carry(waiting, Session.guidanceOf("Prompt two.", skill)))
      assert.strictEqual(next.preamble, "OLD HANDOFF")
      assert.isUndefined(next.resumeFrom)
    })
  )

  it.effect("a conversation that hasn't started just takes the guidance", () =>
    Effect.gen(function* () {
      const fresh = { harness: "codex", sessionId: "dream-prj_test" } as const
      assert.deepStrictEqual(Option.getOrThrow(yield* carry(fresh, v1)), { ...fresh, guidance: v1 })
    })
  )

  it("restart keeps the guidance and any preamble, and drops the conversation", () => {
    const next = Session.restart({ ...codex, preamble: "P" }, "new")
    assert.deepStrictEqual(next, { harness: "codex", sessionId: "new", guidance: v1, preamble: "P" })
    assert.deepStrictEqual(Session.delivered(next), { harness: "codex", sessionId: "new", guidance: v1 })
  })
})

describe("the Codex handoff", () => {
  it("quotes the last exchanges, without what Codex adds to the conversation", () => {
    const rollout = [
      JSON.stringify({ type: "session_meta", payload: { id: "t1" } }),
      line("developer", "Old instructions"),
      line("user", "<environment_context>\n  <cwd>/home/user/project</cwd>\n</environment_context>"),
      line("user", "It's Friday.\n\nWhat woke you:\n\nThey said: build a podcast"),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count" } }),
      line("assistant", "Building it."),
      "not json",
      line("user", "It's Saturday.\n\nWhat woke you:\n\nThey said: make it weekly")
    ].join("\n")
    assert.deepStrictEqual(Session.recentExchanges(rollout), [
      { from: "dream", text: "It's Friday.\n\nWhat woke you:\n\nThey said: build a podcast" },
      { from: "you", text: "Building it." },
      { from: "dream", text: "It's Saturday.\n\nWhat woke you:\n\nThey said: make it weekly" }
    ])
  })

  it("keeps to the last messages, each cut short, within a budget", () => {
    const rollout = Array.from({ length: 30 }, (_, i) => line("assistant", `${i} ${"x".repeat(5_000)}`)).join("\n")
    const recent = Session.recentExchanges(rollout)
    assert.isAtMost(recent.length, 12)
    assert.isTrue(recent.at(-1)?.text.startsWith("29 "))
    assert.isTrue(recent.every(({ text }) => text.length <= 2_010))
    assert.isAtMost(
      recent.reduce((sum, { text }) => sum + text.length, 0),
      12_100
    )
  })

  it.effect("reads the old thread's rollout, and says where it is", () =>
    Effect.gen(function* () {
      const codexHome = join(tempDir(), ".codex")
      const day = join(codexHome, "sessions", "2026", "11", "07")
      mkdirSync(day, { recursive: true })
      const file = join(day, "rollout-2026-11-07T01-00-00-t1.jsonl")
      writeFileSync(file, `${line("user", "REMEMBER: apple")}\n${line("assistant", "Remembered.")}\n`)
      const handoff = yield* Session.codexHandoff(codexHome, Option.some("t1"))
      assert.include(handoff, `Its log is ${file}`)
      assert.include(handoff, "[Dream]\nREMEMBER: apple\n\n[You]\nRemembered.")
      const missing = yield* Session.codexHandoff(codexHome, Option.some("t2"))
      assert.include(missing, "Its log wasn't found")
      assert.notInclude(missing, "How it ended")
    }).pipe(Effect.provide(NodeServices.layer))
  )
})
