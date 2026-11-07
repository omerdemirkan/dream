/**
 * Option previews on a question (`dream ask --show`), added in November 2026. The phone on someone's lock screen
 * may be a TestFlight build from before them, which must keep showing these questions as plain options.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import {
  AgentEvent,
  EventId,
  MediaId,
  MediaRef,
  Message,
  mediaKind,
  QuestionAnswer,
  QuestionMessage,
  QuestionPreviewLimits,
  questionPreviewsProblem,
  renderAgentEvent,
  SandboxRpcs
} from "../src/index.ts"
import * as Fixtures from "../src/fixtures.ts"

const json = <S extends Schema.Top>(schema: S) => Schema.toCodecJson(schema as never) as never as Schema.Codec<S["Type"], unknown>
const wireOf = (message: Message): unknown =>
  JSON.parse(JSON.stringify(Schema.encodeSync(Schema.toCodecJson(Message))(message)))

// The shapes as build 26786469 knew them: no previews, no note on a choice, no audio.
const OldMediaRef = Schema.Struct({
  ...MediaRef.fields,
  kind: Schema.Literals(["image", "video"]),
  contentType: Schema.Literals(["image/png", "image/jpeg", "video/mp4"])
})
const OldAnswer = Schema.TaggedUnion({
  Choice: { option: Schema.String },
  Freeform: { text: Schema.NonEmptyString }
})
const OldState = Schema.TaggedUnion({
  Open: {},
  Answered: { answer: OldAnswer, answeredAt: Schema.DateTimeUtc },
  Withdrawn: { withdrawnAt: Schema.DateTimeUtc }
})
const { previews: _, state: __, ...oldFields } = QuestionMessage.fields
const OldQuestion = Schema.TaggedStruct("Question", { ...oldFields, state: OldState })

describe("option previews", () => {
  it("round-trip with images, video and audio", () => {
    for (const question of [Fixtures.cabinDirections, Fixtures.timerSounds]) {
      const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(Message))(wireOf(question))
      assert.deepStrictEqual(decoded, question)
    }
  })

  it("show as plain options in an app from before them", () => {
    const old = Schema.decodeUnknownSync(Schema.toCodecJson(OldQuestion))(wireOf(Fixtures.timerSounds))
    assert.notProperty(old, "previews")
    assert.deepStrictEqual(old.options, Fixtures.timerSounds.options)
    // Audio would be one it can't read, which is why the API keeps it to previews.
    const sound = Fixtures.timerSounds.previews![0]!.media[0]!
    assert.isTrue(Schema.decodeUnknownExit(Schema.toCodecJson(OldMediaRef))(sound)._tag === "Failure")
  })

  it("keep a note on a pick, which older apps and dreamds drop", () => {
    const answered: QuestionMessage = {
      ...Fixtures.cabinDirections,
      state: {
        _tag: "Answered",
        answer: { _tag: "Choice", option: "Requests first", note: "Open on A’s calendar, though." },
        answeredAt: DateTime.makeUnsafe("2026-11-04T20:00:00Z")
      }
    }
    assert.deepStrictEqual(Schema.decodeUnknownSync(Schema.toCodecJson(Message))(wireOf(answered)), answered)
    const old = Schema.decodeUnknownSync(Schema.toCodecJson(OldQuestion))(wireOf(answered))
    assert.deepStrictEqual(old.state._tag === "Answered" && old.state.answer, { _tag: "Choice", option: "Requests first" })
    // An API from before them takes the newer app's answer, without the note.
    const choice = Schema.encodeSync(Schema.toCodecJson(QuestionAnswer))({ _tag: "Choice", option: "Rotation", note: "Hm" })
    assert.deepStrictEqual(Schema.decodeUnknownSync(Schema.toCodecJson(OldAnswer))(choice), {
      _tag: "Choice",
      option: "Rotation"
    })
  })

  it("reach the agent with the note", () => {
    const event = AgentEvent.cases.QuestionAnswered.make({
      id: "evt_1" as EventId,
      at: DateTime.makeUnsafe("2026-11-04T20:00:00Z"),
      messageId: Fixtures.cabinDirections.id,
      question: Fixtures.cabinDirections.question,
      answer: { _tag: "Choice", option: "Requests first", note: "Open on A’s calendar,\nso people see what’s free." }
    })
    assert.strictEqual(
      renderAgentEvent(event).replace(/^\[[^\]]*\] /, ""),
      `They answered your question msg_cabindirs, "How should a weekend get booked?", "Requests first", adding:\n` +
        "> Open on A’s calendar,\n> so people see what’s free."
    )
  })

  it("name the question's options, once each, within the limits", () => {
    const options = ["Calendar first", "Requests first"]
    const one = (option: string, n = 1) => ({ option, media: Array.from({ length: n }, () => 0) })
    assert.isUndefined(questionPreviewsProblem(options, [one("Calendar first", 2), one("Requests first")]))
    assert.isUndefined(questionPreviewsProblem(options, []))
    assert.include(questionPreviewsProblem(options, [one("Calendar")])!, "isn't one of the options")
    assert.include(questionPreviewsProblem(options, [one("Calendar first"), one("Calendar first")])!, "more than one")
    assert.include(questionPreviewsProblem(options, [one("Calendar first", QuestionPreviewLimits.perOption + 1)])!, "at most")
    const many = Array.from({ length: 4 }, (_, i) => one(`O${i}`, QuestionPreviewLimits.perOption))
    assert.include(questionPreviewsProblem(many.map((p) => p.option), many)!, "a question shows at most")
  })

  it("tell media kinds apart", () => {
    assert.strictEqual(mediaKind("audio/mpeg"), "audio")
    assert.strictEqual(mediaKind("video/mp4"), "video")
    assert.strictEqual(mediaKind("image/jpeg"), "image")
  })

  it("travel from dreamd as media ids, which an API from before them ignores", () => {
    const rpc = SandboxRpcs.requests.get("AskQuestion")!
    const payload = {
      question: "How should a weekend get booked?",
      options: ["Calendar first"],
      previews: [{ option: "Calendar first", media: ["med_a" as MediaId] as const }]
    }
    const encoded = Schema.encodeSync(json(rpc.payloadSchema))(payload)
    assert.deepStrictEqual(Schema.decodeUnknownSync(json(rpc.payloadSchema))(encoded), payload)
    const Old = Schema.Struct({ question: Schema.String, options: Schema.Array(Schema.String) })
    assert.notProperty(Schema.decodeUnknownSync(Old)(encoded), "previews")
  })
})
