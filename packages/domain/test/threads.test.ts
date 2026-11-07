/**
 * Threads (replies gathered under a message) and questions changed in place, added in November 2026. The phone on
 * someone's lock screen may be TestFlight build 26786469, from before them: it must show a reply as a message of
 * its own and a changed question as the question it now is.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import {
  AgentEvent,
  AppRpcs,
  type EventId,
  Message,
  type MessageId,
  messageAuthor,
  QuestionMessage,
  renderAgentEvent,
  repliesByRoot,
  SandboxRpcs,
  TextMessage,
  ThreadRef,
  threadExcerpt,
  threadRefOf,
  threadRootId
} from "../src/index.ts"
import * as Fixtures from "../src/fixtures.ts"

const wireOf = (message: Message): unknown =>
  JSON.parse(JSON.stringify(Schema.encodeSync(Schema.toCodecJson(Message))(message)))
const roundTrip = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: S["Type"]) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema))(
    JSON.parse(JSON.stringify(Schema.encodeSync(Schema.toCodecJson(schema))(value)))
  )

// The shapes as build 26786469 knew them: no thread, no revision.
const OldText = TextMessage.mapFields(({ replyTo: _, ...rest }) => rest)
const { replyTo: _r, revisedAt: _v, ...oldQuestionFields } = QuestionMessage.fields
const OldQuestion = Schema.TaggedStruct("Question", oldQuestionFields)
const OldUserMessage = Schema.Struct((({ thread: _, ...rest }) => rest)(AgentEvent.cases.UserMessage.fields))

describe("threads on the wire", () => {
  it("round-trip a reply and a changed question", () => {
    for (const message of [Fixtures.liftLogDupes, Fixtures.liftLogDupesReply, Fixtures.timerSoundsRevised]) {
      assert.deepStrictEqual(Schema.decodeUnknownSync(Schema.toCodecJson(Message))(wireOf(message)), message)
    }
    const wire = wireOf(Fixtures.timerSoundsRevised) as { revisedAt: string }
    assert.strictEqual(wire.revisedAt, "2026-11-04T21:47:00.000Z")
    assert.notProperty(wireOf(Fixtures.liftLogUpdate) as object, "replyTo")
  })

  it("show a reply as a plain message, and a changed question as it is now, in an app from before them", () => {
    const reply = Schema.decodeUnknownSync(Schema.toCodecJson(OldText))(wireOf(Fixtures.liftLogDupesReply))
    assert.notProperty(reply, "replyTo")
    assert.strictEqual(reply.text, Fixtures.liftLogDupesReply.text)
    const question = Schema.decodeUnknownSync(Schema.toCodecJson(OldQuestion))(wireOf(Fixtures.timerSoundsRevised))
    assert.notProperty(question, "revisedAt")
    assert.deepStrictEqual(question.options, Fixtures.timerSoundsRevised.options)
    assert.strictEqual(question.state._tag, "Open")
  })

  it("round-trip the new payloads, which older servers decode without the new keys", () => {
    const send = AppRpcs.requests.get("SendMessage")!
    const payload = {
      projectId: Fixtures.liftLog.id,
      text: "Can it skip duplicates?",
      replyTo: Fixtures.liftLogUpdate.id
    }
    assert.deepStrictEqual(roundTrip(send.payloadSchema, payload), payload)
    // SendMessage as an API from before threads declares it.
    const OldSend = Schema.Struct({
      projectId: Schema.String,
      text: Schema.String,
      requestId: Schema.optionalKey(Schema.String),
      workstream: Schema.optionalKey(Schema.String)
    })
    assert.notProperty(Schema.decodeUnknownSync(Schema.toCodecJson(OldSend))(payload), "replyTo")
    const revise = SandboxRpcs.requests.get("ReviseQuestion")!
    const change = {
      messageId: Fixtures.timerSounds.id,
      options: ["A chime that gets louder", "Soft chime"],
      why: null
    }
    assert.deepStrictEqual(roundTrip(revise.payloadSchema, change), change)
    const thread = AppRpcs.requests.get("ListThread")!
    const listed = { root: Fixtures.liftLogUpdate, replies: [Fixtures.liftLogDupes, Fixtures.liftLogDupesReply] }
    assert.deepStrictEqual(roundTrip(thread.successSchema, listed), listed)
  })
})

describe("threads", () => {
  it("gather replies under their first message, in order", () => {
    const messages = [
      Fixtures.liftLogUpdate,
      Fixtures.timerSounds,
      Fixtures.timerLouder,
      Fixtures.liftLogDupes,
      Fixtures.timerLouderReply,
      Fixtures.liftLogDupesReply
    ]
    const threads = repliesByRoot(messages)
    assert.deepStrictEqual(
      threads.get(Fixtures.liftLogUpdate.id)?.map((m) => m.id),
      [Fixtures.liftLogDupes.id, Fixtures.liftLogDupesReply.id]
    )
    assert.deepStrictEqual(
      threads.get(Fixtures.timerSounds.id)?.map((m) => m.id),
      [Fixtures.timerLouder.id, Fixtures.timerLouderReply.id]
    )
    assert.strictEqual(threads.size, 2)
    assert.strictEqual(threadRootId(Fixtures.liftLogDupesReply), Fixtures.liftLogUpdate.id)
    assert.strictEqual(threadRootId(Fixtures.liftLogUpdate), Fixtures.liftLogUpdate.id)
    assert.strictEqual(messageAuthor(Fixtures.timerSounds), "agent")
    assert.strictEqual(messageAuthor(Fixtures.liftLogDupes), "user")
  })

  it("name their first message with enough of it to make sense of a reply", () => {
    assert.deepStrictEqual(threadRefOf(Fixtures.timerSounds), {
      messageId: Fixtures.timerSounds.id,
      from: "agent",
      kind: "question",
      excerpt: "Which sound should the rest timer end with?",
      open: true
    })
    assert.deepStrictEqual(threadRefOf(Fixtures.appleAccess), {
      messageId: Fixtures.appleAccess.id,
      from: "agent",
      kind: "access",
      excerpt: "Add your Apple Developer key to put Lift Log on your phone.",
      open: true
    })
    const long = { ...Fixtures.liftLogDupes, text: `${"word ".repeat(100)}\n\nend` }
    const excerpt = threadExcerpt(long, 40)
    assert.isAtMost(excerpt.length, 40)
    assert.isTrue(excerpt.endsWith("word…"))
    assert.strictEqual(threadExcerpt({ ...Fixtures.liftLogDupes, text: "  two\n lines " }), "two lines")
    assert.deepStrictEqual(roundTrip(ThreadRef, threadRefOf(Fixtures.liftLogDupes)), {
      messageId: Fixtures.liftLogDupes.id,
      from: "user",
      kind: "text",
      excerpt: Fixtures.liftLogDupes.text
    })
  })
})

describe("a reply in the turn prompt", () => {
  const event = (thread: ThreadRef | undefined) =>
    AgentEvent.cases.UserMessage.make({
      id: "evt_reply" as EventId,
      at: DateTime.makeUnsafe("2026-11-04T21:45:00Z"),
      messageId: "msg_louder" as MessageId,
      text: Fixtures.timerLouder.text,
      ...(thread === undefined ? {} : { thread })
    })

  it("says which message's thread it's in, and that an open question isn't answered", () => {
    assert.strictEqual(
      renderAgentEvent(event(threadRefOf(Fixtures.timerSounds))),
      "[Wed, Nov 4, 9:45 PM] They wrote (msg_louder) in the thread on your question msg_timersound, " +
        '"Which sound should the rest timer end with?", which is still open (a reply doesn\'t answer it):\n' +
        "> Could it start soft and get louder if I don’t stop it?\n" +
        "If they're asking you to change it, `dream ask revise msg_timersound` changes the card in place."
    )
    assert.strictEqual(
      renderAgentEvent(event(threadRefOf(Fixtures.liftLogUpdate))),
      "[Wed, Nov 4, 9:45 PM] They wrote (msg_louder) in the thread on your message msg_liftimport " +
        '("Apple Health import works in the simulator — 214 workouts from a sample export."):\n' +
        "> Could it start soft and get louder if I don’t stop it?"
    )
    const answered = { ...threadRefOf(Fixtures.timerSounds), open: false }
    assert.notInclude(renderAgentEvent(event(answered)), "revise")
    assert.include(renderAgentEvent(event(threadRefOf(Fixtures.liftLogDupes))), "their own message msg_dupes")
  })

  it("reads as a plain message to a dreamd from before threads", () => {
    const wire = JSON.parse(
      JSON.stringify(Schema.encodeSync(Schema.toCodecJson(AgentEvent))(event(threadRefOf(Fixtures.timerSounds))))
    )
    const old = Schema.decodeUnknownSync(Schema.toCodecJson(OldUserMessage))(wire)
    assert.notProperty(old, "thread")
    assert.strictEqual(old.text, Fixtures.timerLouder.text)
  })
})
