/**
 * The Claude Code bridge's hold on turns with background work (`bridges/claude-code/background.mjs`), driven the
 * way the patched bridge loop drives it (`Bridges.ts`), over message sequences recorded from Claude Code 2.1.318
 * against the fake Messages API: a background subagent, a background command, work that ends mid-turn, and none.
 */
import { assert, describe, it } from "@effect/vitest"
import {
  type BackgroundReport,
  createDreamBackground,
  quietType
} from "../src/harness/bridges/claude-code/background.mjs"

type Msg = { readonly type: string; readonly [key: string]: unknown }

const init: Msg = { type: "system", subtype: "init" }
const running: Msg = { type: "system", subtype: "session_state_changed", state: "running" }
const idle: Msg = { type: "system", subtype: "session_state_changed", state: "idle" }
const tasks = (...ids: ReadonlyArray<string>): Msg => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: ids.map((id) => ({
    task_id: id,
    task_type: id.startsWith("b") ? "local_bash" : "local_agent",
    description: id
  }))
})
const assistant: Msg = { type: "assistant", message: { content: [] } }
/** A `result`; `answers` says whether it answers the turn's prompt (else it's a follow-up's). */
const result = (answers: boolean): Msg => ({ type: "result", subtype: "success", answers })
const notification = (id: string): Msg => ({ type: "system", subtype: "task_notification", task_id: id })

/**
 * The patched loop's decisions, over `script`: where the turn ends (the index of the message, or "quiet" when the
 * grace period ran out), and the reports for dreamd. After the script the CLI sends nothing more, as a live one
 * that has nothing to do; `fire` then runs the grace timer, if one is set.
 */
const run = async (script: ReadonlyArray<Msg>, options: { readonly steering?: ReadonlyArray<number> } = {}) => {
  let pending: (() => void) | undefined
  const background = createDreamBackground({
    setTimer: (callback) => {
      pending = callback
      return 1
    },
    clearTimer: () => {
      pending = undefined
    }
  })
  async function* source() {
    for (const msg of script) yield msg
    await new Promise(() => {})
  }
  const reports: Array<BackgroundReport> = []
  const report = () => {
    const value = background.report()
    if (value !== undefined) reports.push(value)
  }
  const ended = (async () => {
    let observedResult = false
    let index = -1
    for await (const msg of background.watch(source())) {
      if (msg.type === quietType) {
        if (observedResult && background.endNow({ graceOver: true })) return "quiet" as const
        continue
      }
      index++
      // A message the person sent mid-turn, still being answered.
      const active = options.steering?.includes(index) === true
      background.observe(msg)
      report()
      if (
        msg.type === "system" &&
        msg.subtype === "session_state_changed" &&
        msg.state === "idle" &&
        background.engaged() &&
        observedResult &&
        !active &&
        background.endNow()
      ) {
        return index
      }
      if (msg.type === "result") {
        background.result()
        report()
        if (msg.answers !== true) {
          if (background.engaged() && observedResult && !active && background.endNow()) return index
          continue
        }
        observedResult = true
        if (!active) {
          if (background.engaged() && !background.endNow()) continue
          return index
        }
        continue
      }
      if (observedResult && !active && !background.engaged()) return index
    }
    return "source ended" as const
  })()
  const settle = (ms: number) =>
    Promise.race([ended, new Promise<"still open">((resolve) => setTimeout(() => resolve("still open"), ms))])
  const first = await settle(20)
  if (first !== "still open") return { end: first, reports, graceSet: pending !== undefined }
  const graceSet = pending !== undefined
  pending?.()
  return { end: await settle(20), reports, graceSet }
}

describe("a Claude Code turn with background work", () => {
  it("ends where the adapter ends it when there's none", async () => {
    const { end, reports } = await run([running, init, assistant, result(true), idle])
    assert.strictEqual(end, 3)
    assert.deepStrictEqual(reports, [])
  })

  it("holds past the model's reply for a background subagent, through the CLI's follow-up turn", async () => {
    const script = [
      running,
      init,
      assistant,
      tasks("a1"),
      { type: "system", subtype: "task_started", task_id: "a1" },
      { type: "user" },
      assistant,
      result(true), // 7: the model's reply; the subagent is still working
      { type: "system", subtype: "task_progress", task_id: "a1" },
      notification("a1"),
      tasks(),
      init, // 11: the CLI's own turn for the notification
      assistant,
      result(false), // 13
      idle
    ]
    const { end, reports } = await run(script)
    assert.strictEqual(end, 13)
    assert.deepStrictEqual(
      reports.map((report) => [report.holding, report.live.map((task) => task.id)]),
      [
        [false, ["a1"]],
        [true, ["a1"]],
        [false, []]
      ]
    )
  })

  it("holds for a background command, which leaves the session idle while it runs", async () => {
    const script = [
      running,
      init,
      assistant,
      tasks("b1"),
      { type: "user" },
      assistant,
      result(true), // 6
      idle, // 7: idle with the command still running doesn't end the turn
      notification("b1"),
      tasks(),
      running,
      init,
      assistant,
      result(false), // 13
      idle
    ]
    assert.strictEqual((await run(script)).end, 13)
  })

  it("waits for every task, and ends at the reply after the last one reports", async () => {
    const script = [
      init,
      assistant,
      tasks("a1"),
      tasks("a1", "a2"),
      assistant,
      result(true),
      notification("a1"),
      tasks("a2"),
      init,
      assistant,
      result(false), // 10: a2 is still running
      notification("a2"),
      tasks(),
      init,
      assistant,
      result(false) // 15
    ]
    assert.strictEqual((await run(script)).end, 15)
  })

  it("ends after a short grace when the last task stops and no turn follows", async () => {
    const script = [init, assistant, tasks("b1"), assistant, result(true), idle, tasks()]
    const { end, graceSet } = await run(script)
    assert.isTrue(graceSet)
    assert.strictEqual(end, "quiet")
  })

  it("gives a task that finished mid-turn a moment to bring a turn of its own", async () => {
    const finishedMidTurn = [init, assistant, tasks("b1"), assistant, tasks(), assistant, result(true)]
    const quiet = await run(finishedMidTurn)
    assert.isTrue(quiet.graceSet)
    assert.strictEqual(quiet.end, "quiet")
    const followed = await run([...finishedMidTurn, init, assistant, result(false)])
    assert.strictEqual(followed.end, 9)
  })

  it("keeps the turn open for a message the person sent while it waits", async () => {
    const script = [init, assistant, tasks("a1"), assistant, result(true), init, assistant, result(true)]
    // The steered message is being answered at 7; with a1 still running the turn holds on.
    const { end } = await run(script, { steering: [5, 6, 7] })
    assert.strictEqual(end, "still open")
  })

  it("ignores ambient tasks", async () => {
    const watcher: Msg = {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "w1", task_type: "local_bash", description: "watch", ambient: true }]
    }
    assert.strictEqual((await run([init, watcher, assistant, result(true)])).end, 3)
  })

  it("leaves a background task's failure to the model instead of ending the turn", () => {
    const background = createDreamBackground()
    const failed = {
      type: "system",
      subtype: "task_updated",
      task_id: "a1",
      patch: { status: "failed", error: "boom" }
    }
    assert.deepStrictEqual(background.forStream(failed), failed)
    background.observe(tasks("a1"))
    assert.deepStrictEqual<unknown>(background.forStream(failed), { ...failed, patch: { status: "failed" } })
  })
})
