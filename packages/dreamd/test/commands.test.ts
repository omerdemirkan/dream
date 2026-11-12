import { assert, describe, it } from "@effect/vitest"
import { Context, Effect, Layer, Ref, Stream } from "effect"
import { Api, type Report } from "../src/Api.ts"
import { Commands } from "../src/Commands.ts"
import { Hold } from "../src/Hold.ts"
import { Inbox } from "../src/Inbox.ts"
import { ProjectLog } from "../src/Log.ts"
import { Machine } from "../src/Machine.ts"
import { modelHere, type TaskRunInput, Tasks } from "../src/Tasks.ts"
import { baseLayer, tempDir, wakeWithCommand, wakeWithTask } from "./support.ts"

const setup = (
  script: Parameters<typeof Tasks.layerTest>[0]["script"] = () => Effect.die("no tasks here"),
  dir = tempDir()
) =>
  Effect.gen(function* () {
    const reports = yield* Ref.make<ReadonlyArray<Report>>([])
    const asked = yield* Ref.make<ReadonlyArray<TaskRunInput>>([])
    const context = yield* Layer.build(
      Commands.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(Tasks.layerTest({ script, log: asked }), Api.layerTest(reports))),
        Layer.provideMerge(Layer.mergeAll(Inbox.layer, Hold.layer, Machine.layerNone)),
        Layer.provideMerge(ProjectLog.layer),
        Layer.provideMerge(baseLayer(dir))
      )
    )
    const inbox = Context.get(context, Inbox)
    yield* Effect.forkScoped(Context.get(context, Commands).run)
    /** The inbox once nothing is left running. */
    const settled = inbox.changes.pipe(
      Stream.filter((state) => state.entries.every((entry) => entry.state !== "command")),
      Stream.runHead,
      Effect.timeout("10 seconds"),
      Effect.map((state) => (state._tag === "Some" ? state.value.entries : []))
    )
    return { inbox, reports, asked, settled, hold: Context.get(context, Hold) }
  })

describe("scheduled commands", () => {
  it.live("drop a wake whose command succeeds, and queue one that fails with its output", () =>
    Effect.gen(function* () {
      const { inbox, settled } = yield* setup()
      yield* inbox.deliver([
        wakeWithCommand(1, "echo fine"),
        wakeWithCommand(2, "echo 'parser failed on 3 issues' >&2; exit 3")
      ])
      const entries = yield* settled
      assert.strictEqual(entries.length, 1)
      const [failed] = entries
      assert.strictEqual(failed?.state, "queued")
      const result = failed?.event._tag === "WakeDue" ? failed.event.run?.result : undefined
      assert.strictEqual(result?.exitCode, 3)
      assert.include(result?.outputTail, "parser failed on 3 issues")
    }).pipe(Effect.scoped)
  )
})

describe("a usage hold", () => {
  it.live("keeps scheduled commands and tasks waiting until it's over", () =>
    Effect.gen(function* () {
      const { inbox, hold, asked, settled } = yield* setup(() => Effect.succeed({ outcome: "succeeded" as const }))
      yield* hold.set(true)
      yield* inbox.deliver([wakeWithCommand(1, "echo fine"), wakeWithTask(2, "Write this week's episode.")])
      yield* Effect.sleep("200 millis")
      assert.strictEqual((yield* inbox.commands).length, 2)
      assert.lengthOf(yield* Ref.get(asked), 0)
      yield* hold.set(false)
      assert.lengthOf(yield* settled, 0)
      assert.lengthOf(yield* Ref.get(asked), 1)
    }).pipe(Effect.scoped)
  )
})

describe("scheduled tasks", () => {
  it.live("run in a session of their own, are reported, and reach the agent only when they fail", () =>
    Effect.gen(function* () {
      const { inbox, reports, asked, settled } = yield* setup((input) =>
        Effect.succeed(
          input.task.brief.includes("broken")
            ? {
                outcome: "failed" as const,
                failure: { reason: "its session ended with an error: 529 overloaded", report: "Got halfway." },
                report: "Got halfway."
              }
            : {
                outcome: "succeeded" as const,
                report: "Published episode 12.",
                usage: { tokens: { input: 1, cacheRead: 2_000, cacheWrite: 300, output: 400 }, costUsd: 0.02 },
                lastReading: { weekly: { usedPercent: 36 } }
              }
        )
      )
      yield* inbox.deliver(
        [wakeWithTask(1, "Write this week's episode."), wakeWithTask(2, "Do the broken thing.")],
        "Europe/London"
      )
      const entries = yield* settled

      // Each ran from its own brief, on the model and effort the agent gave, in their time zone.
      const runs = yield* Ref.get(asked)
      assert.deepStrictEqual(
        runs.map((run) => [run.wakeId, run.task.model, run.task.effort, run.timeZone]),
        [
          ["wak_1", "sonnet", "medium", "Europe/London"],
          ["wak_2", "sonnet", "medium", "Europe/London"]
        ]
      )
      // The success is dropped; the failure is queued for the agent with why.
      assert.strictEqual(entries.length, 1)
      const failed = entries[0]?.event
      assert.strictEqual(failed?._tag === "WakeDue" ? failed.wakeId : undefined, "wak_2")
      assert.deepStrictEqual(failed?._tag === "WakeDue" ? failed.task?.result : undefined, {
        reason: "its session ended with an error: 529 overloaded",
        report: "Got halfway."
      })
      assert.strictEqual(entries[0]?.state, "queued")

      // Both runs are reported, with the session's last words and tokens; the usage it saw goes up as well.
      const sent = yield* Ref.get(reports)
      const tasks = sent.flatMap((report) => (report._tag === "Task" ? [report.task] : []))
      assert.deepStrictEqual(
        tasks.map((task) => [task.wakeId, task.outcome, task.summary, task.usage?.costUsd]).sort(),
        [
          ["wak_1", "succeeded", "Published episode 12.", 0.02],
          ["wak_2", "failed", "Got halfway.", undefined]
        ]
      )
      assert.strictEqual(tasks.find((task) => task.wakeId === "wak_1")?.after?.weekly?.usedPercent, 36)
      assert.isTrue(sent.some((report) => report._tag === "Usage" && report.usage.weekly?.usedPercent === 36))
    }).pipe(Effect.scoped)
  )
})

describe("a task's model", () => {
  it("after a move to another plan, is the counterpart of one the old plan offered", () => {
    assert.strictEqual(modelHere("codex", "sonnet"), "terra")
    assert.strictEqual(modelHere("claude-code", "gpt-6-astra"), "fable")
    assert.strictEqual(modelHere("claude-code", "luna"), "haiku")
  })

  it("is a family, which runs as its newest model, and any other name as it was", () => {
    assert.strictEqual(modelHere("codex", "gpt-6.1-sol"), "sol")
    assert.strictEqual(modelHere("codex", "gpt-6-sol"), "sol")
    assert.strictEqual(modelHere("claude-code", "haiku"), "haiku")
    assert.strictEqual(modelHere("claude-code", "claude-fable-5-1"), "claude-fable-5-1")
    assert.strictEqual(modelHere("codex", "gpt-5.5"), "gpt-5.5")
  })
})
