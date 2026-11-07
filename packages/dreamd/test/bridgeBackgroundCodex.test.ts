/**
 * The Codex bridge's hold on turns whose root agent left children running (`bridges/codex/background.mjs`), over
 * the app-server notifications Codex 0.165.0 sends for a `spawn_agent` child.
 */
import { assert, describe, it } from "@effect/vitest"
import {
  addUsage,
  type ChildReport,
  createDreamChildren,
  type SteeredMessage
} from "../src/harness/bridges/codex/background.mjs"

const root = "thread-root"
const activity = (kind: "started" | "completed", child: string, path: string) => ({
  method: "item/completed",
  params: { threadId: root, item: { type: "subAgentActivity", kind, agentThreadId: child, agentPath: path } }
})
const childMessage = (child: string, text: string) => ({
  method: "item/completed",
  params: { threadId: child, item: { type: "agentMessage", id: "m", text } }
})
const delivered = (path: string, text: string) => ({
  method: "rawResponseItem/completed",
  params: {
    threadId: root,
    item: {
      type: "agent_message",
      content: [
        { type: "input_text", text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${path}\nPayload:\n${text}` }
      ]
    }
  }
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("a Codex turn whose root left children running", () => {
  it("ends at once when nothing is running and nothing is unread", async () => {
    const children = createDreamChildren()
    assert.isUndefined(await children.settle(() => {}))
    assert.isFalse(children.holding())
  })

  it("waits for a running child, then hands its final answer to the next root turn", async () => {
    const children = createDreamChildren()
    const reports: Array<ChildReport> = []
    children.observe(activity("started", "c1", "/root/research"), root)
    const settled = children.settle((report) => reports.push(report))
    await tick()
    assert.isTrue(children.holding())
    children.observe(childMessage("c1", "CarPlay can't show custom views"), root)
    children.observe(activity("completed", "c1", "/root/research"), root)
    const next = await settled
    assert.include(next?.input, "Their final answers:")
    assert.include(next?.input, "/root/research:\nCarPlay can't show custom views")
    assert.deepStrictEqual(next?.messages, [])
    assert.deepStrictEqual(
      reports.map((report) => [report.holding, report.live.length]),
      [
        [true, 1],
        [false, 0]
      ]
    )
    // Handed over: the next completion of the root's turn ends it.
    assert.isUndefined(await children.settle(() => {}))
  })

  it("starts the next root turn at once for a message steered in while it waits", async () => {
    const children = createDreamChildren()
    children.observe(activity("started", "c1", "/root/research"), root)
    const settled = children.settle(() => {})
    await tick()
    const message: SteeredMessage = { text: "They wrote: use AnkiConnect", accept: () => {}, reject: () => {} }
    children.steer(message)
    const next = await settled
    assert.strictEqual(next?.input, "They wrote: use AnkiConnect")
    assert.deepStrictEqual(next?.messages, [message])
    assert.isFalse(children.holding())
  })

  it("leaves out answers the root collected with wait_agent, and hands over ones it never did", async () => {
    const children = createDreamChildren()
    children.observe(activity("started", "c1", "/root/a"), root)
    children.observe(activity("started", "c2", "/root/b"), root)
    children.observe(childMessage("c1", "a's answer"), root)
    children.observe(activity("completed", "c1", "/root/a"), root)
    children.observe(delivered("/root/a", "a's answer"), root)
    children.observe(childMessage("c2", "b's answer"), root)
    children.observe(activity("completed", "c2", "/root/b"), root)
    const next = await children.settle(() => {})
    assert.include(next?.input, "/root/b:\nb's answer")
    assert.notInclude(next?.input, "/root/a")
  })

  it("says a held turn's children are doing something, at most once a minute", async () => {
    let now = 0
    const children = createDreamChildren({ now: () => now })
    const reports: Array<ChildReport> = []
    children.observe(activity("started", "c1", "/root/research"), root)
    const settled = children.settle((report) => reports.push(report))
    await tick()
    now = 61_000
    children.observe(childMessage("c1", "working"), root)
    await tick()
    now = 62_000
    children.observe(childMessage("c1", "still working"), root)
    await tick()
    assert.deepStrictEqual(
      reports.map((report) => report.activity === true),
      [false, true]
    )
    children.observe(activity("completed", "c1", "/root/research"), root)
    await settled
  })

  it("adds up the root turns' usage", () => {
    const one = { inputTokens: { total: 10, cacheRead: 4 }, outputTokens: { total: 2 } }
    const two = { inputTokens: { total: 5, cacheRead: 1 }, outputTokens: { total: 3 } }
    assert.deepStrictEqual(addUsage(one, two), { inputTokens: { total: 15, cacheRead: 5 }, outputTokens: { total: 5 } })
    assert.deepStrictEqual(addUsage(undefined, two), two)
  })
})
