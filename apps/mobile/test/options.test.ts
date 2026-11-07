/**
 * Options to pick from on the phone (`QuestionMessage.previews`): how the card lays out each option at its own
 * shape, and picking with a note through the real client against the fixtures backend.
 */
import { type MediaRef, type MessageId, type ProjectId, Message } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { Reactivity } from "effect/reactivity"
import { Socket } from "effect/socket"
import { AppClient } from "../src/data/AppClient.ts"
import { Answers } from "../src/data/Answers.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"
import { TolerantMessage } from "../src/data/Tolerant.ts"
import { cabinPick } from "../src/fake/fixtures.ts"
import {
  aspectOf,
  clock,
  contentsOf,
  fit,
  hasPreviews,
  letterFor,
  optionTiles,
  phoneAspect,
  thumbLayout
} from "../src/ui/optionsLayout.ts"

const media = (kind: MediaRef["kind"], width?: number, height?: number): MediaRef => ({
  id: `med_${kind}${width ?? ""}` as never,
  kind,
  contentType: kind === "audio" ? "audio/mp4" : kind === "video" ? "video/mp4" : "image/png",
  sizeBytes: 1,
  ...(width === undefined || height === undefined ? {} : { width, height })
})

describe("option tiles", () => {
  it("list every option in order, with its previews or none", () => {
    const question = { ...Fx.cabinDirections, options: [...Fx.cabinDirections.options, "Something new"] }
    const tiles = optionTiles(question)
    assert.deepStrictEqual(
      tiles.map((t) => [t.letter, t.option, t.media.length]),
      [
        ["A", "Calendar first", 2],
        ["B", "Requests first", 2],
        ["C", "Rotation", 1],
        ["D", "Something new", 0]
      ]
    )
    assert.isTrue(hasPreviews(question))
    assert.isFalse(hasPreviews(Fx.cabinQuestion))
    assert.strictEqual(letterFor(26), "27")
  })

  it("share the card's width in a row for up to three phone screens", () => {
    const tiles = optionTiles(Fx.cabinDirections)
    const layout = thumbLayout(tiles, 330, [phoneAspect, phoneAspect, phoneAspect])
    assert.strictEqual(layout.mode, "row")
    assert.deepStrictEqual(layout.sizes[0], { width: 103, height: 223 })
  })

  it("scroll sideways at one height for a desktop page, a sound or a fourth option", () => {
    const tiles = optionTiles(Fx.cabinDirections)
    const desktop = thumbLayout(tiles, 330, [1.6, phoneAspect, "audio"])
    assert.strictEqual(desktop.mode, "strip")
    assert.deepStrictEqual(desktop.sizes, [
      { width: 240, height: 150 },
      { width: 96, height: 150 },
      { width: 150, height: 150 }
    ])
    const sounds = thumbLayout(optionTiles(Fx.timerSounds), 330, ["audio", "audio", "audio"])
    assert.deepStrictEqual(sounds.sizes[0], { width: 132, height: 104 })
  })

  it("fit media whole at its own shape, measured or assumed", () => {
    assert.deepStrictEqual(fit(1.6, { width: 362, height: 560 }), { width: 362, height: 226 })
    assert.deepStrictEqual(fit(phoneAspect, { width: 362, height: 560 }), { width: 259, height: 560 })
    assert.strictEqual(aspectOf(media("image", 2880, 1800)), 1.6)
    assert.strictEqual(aspectOf(media("image")), phoneAspect)
    assert.strictEqual(aspectOf(media("image"), 1.5), 1.5)
    assert.strictEqual(clock(65.4), "1:05")
    assert.strictEqual(contentsOf([media("image"), media("image", 1, 1), media("video")]), "2 screens, a recording")
  })
})

const appLayer = makeAppLayer(
  { apiUrl: "https://dream.test", backend: "fixtures" },
  { storage: SecureStorage.layerMemory(), webSocket: Socket.layerWebSocketConstructorGlobal, fetch: globalThis.fetch }
).pipe(Layer.provideMerge(Reactivity.layer))

const run = <A, E>(effect: Effect.Effect<A, E, any>) => effect.pipe(Effect.provide(appLayer)) as Effect.Effect<A, E>

describe("picking an option", () => {
  it.effect("goes out with a note, and the card keeps it", () =>
    run(
      Effect.gen(function* () {
        const app = yield* AppClient
        const session = yield* Session
        const signedIn = yield* app.DevSignIn({ email: "ada@example.com", secret: Redacted.make("fixtures") })
        yield* session.signIn({ token: signedIn.sessionToken, user: signedIn.user })
        const answers = yield* Answers
        const note = "Yes, but open on A’s calendar."
        const answered = yield* answers.answerNow({
          projectId: cabinPick.projectId as ProjectId,
          messageId: cabinPick.id as MessageId,
          answer: { _tag: "Choice", option: "Requests first", note }
        })
        assert.deepStrictEqual(answered.state._tag === "Answered" && answered.state.answer, {
          _tag: "Choice",
          option: "Requests first",
          note
        })
        const listed = (yield* app.ListMessages({ projectId: cabinPick.projectId })).messages.find(
          (m) => m.id === cabinPick.id
        )
        assert.strictEqual(listed?._tag === "Question" ? listed.previews?.length : 0, 3)
      })
    )
  )

  it("decodes through the phone's lenient schemas whole", () => {
    const wire = Schema.encodeSync(Schema.toCodecJson(Message))(Fx.timerSounds)
    const decoded = Schema.decodeUnknownOption(Schema.toCodecJson(TolerantMessage))(wire)
    assert.deepStrictEqual(Option.getOrUndefined(decoded), Fx.timerSounds)
  })
})
