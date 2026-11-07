/**
 * Threads in Chat: what folds under its message, what still shows where it falls, and what a thread holds.
 */
import { assert, describe, it } from "@effect/vitest"
import type { Message, MessageId, TextMessage } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { DateTime } from "effect"
import { chatItems, copyText, foldLine, threadOf, topLevel } from "../src/data/threads.ts"

const later = (message: TextMessage, id: string, minutes: number, change: Partial<TextMessage> = {}): TextMessage => ({
  ...message,
  id: id as MessageId,
  createdAt: DateTime.add(message.createdAt, { minutes }),
  ...change
})

describe("Chat with threads", () => {
  it("folds replies under their message, with the count and the latest", () => {
    const items = chatItems([Fx.liftLogUpdate, Fx.liftLogDupes, Fx.liftLogDupesReply])
    assert.strictEqual(items.length, 1)
    const [only] = items
    assert.strictEqual(only?._tag, "Message")
    if (only?._tag !== "Message" || only.thread === undefined) return assert.fail("no thread")
    assert.strictEqual(only.thread.count, 2)
    assert.strictEqual(only.thread.latest.id, Fx.liftLogDupesReply.id)
    assert.deepStrictEqual(foldLine(only.thread), {
      count: "2 replies",
      latest:
        "Dream: It does now. Each workout is matched on its start time and exercises, so the 214 came down to 187."
    })
    assert.strictEqual(foldLine({ count: 1, latest: Fx.liftLogDupes }).count, "1 reply")
    assert.isTrue(foldLine({ count: 1, latest: Fx.liftLogDupes }).latest.startsWith("You: "))
  })

  it("shows the agent's reply where it falls once other messages came after its thread's first", () => {
    const after = later(Fx.liftLogUpdate, "msg_after", 5, { text: "The rest timer is next." })
    const reply = later(Fx.liftLogDupesReply, "msg_late", 20)
    const items = chatItems([Fx.liftLogUpdate, Fx.liftLogDupes, after, reply])
    assert.deepStrictEqual(
      items.map((i) => (i._tag === "Message" ? i.message.id : `echo:${i.reply.id}`)),
      [Fx.liftLogUpdate.id, after.id, "echo:msg_late"]
    )
    const echo = items[2]
    assert.strictEqual(echo?._tag === "Echo" && echo.root?.id, Fx.liftLogUpdate.id)
    // Theirs never echo, and one whose first message isn't loaded yet echoes without it.
    const theirs = later(Fx.liftLogDupes, "msg_theirs", 21)
    const orphan = later(Fx.liftLogDupesReply, "msg_orphan", 22, { replyTo: "msg_older" as MessageId })
    const more = chatItems([after, theirs, orphan])
    assert.deepStrictEqual(
      more.map((i) => i._tag),
      ["Message", "Echo"]
    )
    assert.isTrue(more[1]?._tag === "Echo" && more[1].root === undefined)
    assert.deepStrictEqual(
      topLevel([Fx.liftLogUpdate, Fx.liftLogDupes, after]).map((m) => m.id),
      [Fx.liftLogUpdate.id, after.id]
    )
  })

  it("holds a thread's first message and replies, live ones over fetched ones", () => {
    const stale = { ...Fx.timerSounds }
    const fetched = { root: stale as Message, replies: [Fx.timerLouder] }
    const live = [Fx.timerSoundsRevised, Fx.timerLouder, Fx.timerLouderReply]
    const thread = threadOf(live, Fx.timerSounds.id, fetched)
    assert.strictEqual(thread.root, Fx.timerSoundsRevised)
    assert.deepStrictEqual(
      thread.replies.map((m) => m.id),
      [Fx.timerLouder.id, Fx.timerLouderReply.id]
    )
    // Opened from a notification, before Chat has loaded back that far.
    const cold = threadOf([Fx.timerLouderReply], Fx.timerSounds.id, fetched)
    assert.strictEqual(cold.root, stale)
    assert.deepStrictEqual(
      cold.replies.map((m) => m.id),
      [Fx.timerLouder.id, Fx.timerLouderReply.id]
    )
  })

  it("copies a message's text, or a question with its options", () => {
    assert.strictEqual(copyText(Fx.liftLogDupes), Fx.liftLogDupes.text)
    assert.strictEqual(
      copyText(Fx.timerSounds),
      "Which sound should the rest timer end with?\n• Soft chime\n• Three short buzzes\n• Rising tone"
    )
    assert.strictEqual(copyText(Fx.appleAccess), "Add your Apple Developer key to put Lift Log on your phone.")
  })
})
