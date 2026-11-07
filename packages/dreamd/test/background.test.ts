/**
 * dreamd's side of background work in a turn (`harness/Background.ts`): following the bridges' reports, the limits
 * on a held turn, what stops with a turn, and what a session from before turns waited left running.
 */
import { assert, describe, it } from "@effect/vitest"
import { renderAgentEvent } from "@dream/domain"
import { DateTime, Deferred, Duration, Effect, Exit, Fiber, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import * as Background from "../src/harness/Background.ts"

const report = (holding: boolean, ...live: ReadonlyArray<readonly [string, string, string]>) => ({
  type: "raw",
  rawValue: {
    type: "dream_background",
    holding,
    live: live.map(([id, type, description]) => ({ id, type, description }))
  }
})
const progress = { type: "raw", rawValue: { type: "system", subtype: "task_progress", task_id: "a1" } }
const research = ["a1", "local_agent", "Check CarPlay support"] as const
const server = ["b1", "local_bash", "Start the dev server"] as const
const minutes = (n: number) => n * 60_000

describe("a turn held for background work", () => {
  it("follows the bridge's reports: what's live, and since when the turn is held for it", () => {
    let state = Background.observe(Background.initial, report(false, research), 0)
    assert.deepStrictEqual(state.live, [{ id: "a1", kind: "subagent", description: "Check CarPlay support" }])
    assert.isUndefined(state.holdingSince)
    state = Background.observe(state, report(true, research), minutes(1))
    assert.strictEqual(state.holdingSince, minutes(1))
    state = Background.observe(state, progress, minutes(10))
    assert.strictEqual(state.activityAt, minutes(10))
    // A follow-up turn: held for 20 minutes so far.
    state = Background.observe(state, report(false, research), minutes(21))
    assert.isUndefined(state.holdingSince)
    assert.strictEqual(state.heldMs, minutes(20))
    assert.deepStrictEqual(Background.observe(state, { type: "text-delta" }, minutes(22)), state)
  })

  it("is stopped after 45 quiet minutes, or 3 hours held in all", () => {
    const held = Background.observe(Background.initial, report(true, server), 0)
    assert.isTrue(Option.isNone(Background.overLimit(held, minutes(44))))
    assert.deepStrictEqual(Background.overLimit(held, minutes(45)), Option.some({ reason: "quiet", minutes: 45 }))
    // A subagent that keeps working isn't quiet, but the turn can only wait so long.
    let busy = Background.observe(Background.initial, report(true, research), 0)
    for (let at = 10; at <= 180; at += 10) {
      busy = Background.observe(busy, progress, minutes(at))
      if (at < 180) assert.isTrue(Option.isNone(Background.overLimit(busy, minutes(at))), `${at}`)
    }
    assert.deepStrictEqual(Background.overLimit(busy, minutes(180)), Option.some({ reason: "long", minutes: 180 }))
    // Not held (the model is working), or nothing live: no limit.
    const working = Background.observe(Background.initial, report(false, research), 0)
    assert.isTrue(Option.isNone(Background.overLimit(working, minutes(500))))
  })

  it.effect("supervise stops a turn past a limit and says what stopped with it", () =>
    Effect.gen(function* () {
      const persisted = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
      const stop = yield* Deferred.make<void>()
      const fiber = yield* Background.supervise({
        run: (observe) =>
          Effect.gen(function* () {
            yield* observe(report(false, server))
            yield* observe(report(true, server))
            // The turn runs until it's stopped, as a bridge holding for a server would.
            return yield* Deferred.await(stop).pipe(Effect.andThen(Effect.fail("aborted")))
          }),
        stop: () => Deferred.succeed(stop, undefined).pipe(Effect.asVoid),
        persist: (live) => Ref.update(persisted, (all) => [...all, live.map((task) => task.id)])
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.minutes(44))
      assert.isUndefined(fiber.pollUnsafe())
      yield* TestClock.adjust(Duration.minutes(2))
      const result = yield* Fiber.join(fiber)
      assert.isTrue(Exit.isFailure(result.exit))
      assert.isTrue(result.limited)
      assert.deepStrictEqual(
        result.stopped,
        Option.some<Background.Stopped>({
          reason: "quiet",
          minutes: 45,
          tasks: [{ id: "b1", kind: "command", description: "Start the dev server" }]
        })
      )
      assert.deepStrictEqual(yield* Ref.get(persisted), [["b1"], []])
    })
  )

  it.effect("supervise reports work still live when the turn ended another way, and nothing otherwise", () =>
    Effect.gen(function* () {
      const ended = yield* Background.supervise({
        run: (observe) => observe(report(true, research)).pipe(Effect.andThen(Effect.fail("usage limit"))),
        stop: () => Effect.void
      })
      assert.isFalse(ended.limited)
      assert.deepStrictEqual(
        Option.map(ended.stopped, (stopped) => stopped.reason),
        Option.some("ended")
      )
      const done = yield* Background.supervise({
        run: (observe) =>
          Effect.gen(function* () {
            yield* observe(report(true, research))
            yield* observe(report(false))
            return "finished"
          }),
        stop: () => Effect.void
      })
      assert.deepStrictEqual(done.exit, Exit.succeed("finished"))
      assert.isTrue(Option.isNone(done.stopped))
    })
  )

  it.effect("supervise leaves what's live on disk when dreamd stops the turn", () =>
    Effect.gen(function* () {
      const persisted = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
      const fiber = yield* Background.supervise({
        run: (observe) => observe(report(true, research)).pipe(Effect.andThen(Effect.never)),
        stop: () => Effect.void,
        persist: (live) => Ref.update(persisted, (all) => [...all, live.map((task) => task.id)])
      }).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(1))
      yield* Fiber.interrupt(fiber)
      assert.deepStrictEqual(yield* Ref.get(persisted), [["a1"]])
    })
  )

  it("tells the agent what stopped and why", () => {
    const at = DateTime.makeUnsafe("2026-11-07T18:48:06Z")
    const text = renderAgentEvent(
      Background.toEvent(
        {
          reason: "earlier",
          tasks: [
            { id: "a1", kind: "subagent", description: "Check CarPlay support" },
            { id: "m1", kind: "monitor", description: "Wait for the research" }
          ]
        },
        { id: "evt_dreamd_1" as never, at }
      )
    )
    assert.include(text, "the background work you'd started was stopped with it before it reported back")
    assert.include(text, "- subagent: Check CarPlay support\n- Monitor: Wait for the research")
    assert.include(text, "if you told them you'd come back with its results, follow through")
  })
})

// ---------------------------------------------------------------------------
// A session from before turns waited
// ---------------------------------------------------------------------------

const line = (entry: Record<string, unknown>) => JSON.stringify(entry)
const userText = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: "user", message: { role: "user", content: text }, ...extra })
const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } })
const toolResult = (id: string, toolUseResult: Record<string, unknown>) =>
  line({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "…" }] },
    toolUseResult
  })
const notification = (taskId: string) =>
  userText(`<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>`, {
    origin: { kind: "task-notification" }
  })

describe("work a turn left running before turns waited", () => {
  const earlierTurn = [
    userText("It's Saturday.\n\nWhat woke you:\n\n[Sat] They wrote:\n> Build me a podcast app"),
    toolUse("t0", "Agent", { description: "Old research", prompt: "…", run_in_background: true }),
    toolResult("t0", { isAsync: true, status: "async_launched", agentId: "old1", description: "Old research" })
  ]
  const lastTurn = [
    userText("It's Saturday.\n\nWhat woke you:\n\n[Sat] They wrote:\n> Anki by voice, in the car"),
    toolUse("t1", "Agent", { description: "Check CarPlay support", prompt: "…", run_in_background: true }),
    toolResult("t1", { isAsync: true, status: "async_launched", agentId: "a1", description: "Check CarPlay support" }),
    toolUse("t2", "Agent", { description: "Check AnkiWeb sync", prompt: "…", run_in_background: true }),
    toolResult("t2", { isAsync: true, status: "async_launched", agentId: "a2", description: "Check AnkiWeb sync" }),
    toolUse("t3", "Monitor", { description: "Wait for the research", command: "sleep 1190", timeout_ms: 1_200_000 }),
    toolResult("t3", { taskId: "m1", timeoutMs: 1_200_000 }),
    toolUse("t4", "Bash", { command: "npm run dev", description: "Start the dev server", run_in_background: true }),
    toolResult("t4", { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b1" }),
    // A subagent's own entries are in its own file; any here are skipped.
    line({ type: "user", isSidechain: true, toolUseResult: { backgroundTaskId: "side1" }, message: { content: [] } }),
    line({ type: "assistant", message: { content: [{ type: "text", text: "Both reports are still running." }] } })
  ]

  it("finds what the last turn launched that never reported back", () => {
    const stranded = Background.strandedInTranscript([...earlierTurn, ...lastTurn, "not json"].join("\n"))
    assert.deepStrictEqual(stranded, [
      { id: "a1", kind: "subagent", description: "Check CarPlay support" },
      { id: "a2", kind: "subagent", description: "Check AnkiWeb sync" },
      { id: "m1", kind: "monitor", description: "Wait for the research" },
      { id: "b1", kind: "command", description: "Start the dev server" }
    ])
  })

  it("leaves out what reported back, and finds nothing in a session without Dream's turns", () => {
    const reported = [...lastTurn, notification("a1"), notification("m1"), notification("b1")].join("\n")
    assert.deepStrictEqual(
      Background.strandedInTranscript(reported).map((task) => task.id),
      ["a2"]
    )
    assert.deepStrictEqual(Background.strandedInTranscript(lastTurn.slice(1).join("\n")), [])
    assert.deepStrictEqual(Background.strandedInTranscript(""), [])
  })
})
