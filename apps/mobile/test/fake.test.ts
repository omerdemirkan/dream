/**
 * The app's data layer end to end against the fixtures backend: the real RPC
 * client (through `RpcTest`), sessions, held answers with Undo, and live
 * project state.
 */
import type { MessageId, ProjectId } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Redacted, Stream, SubscriptionRef } from "effect"
import { Reactivity } from "effect/reactivity"
import { Socket } from "effect/socket"
import { TestClock } from "effect/testing"
import { AppClient } from "../src/data/AppClient.ts"
import { Answers } from "../src/data/Answers.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { ProjectStates } from "../src/data/ProjectStates.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"
import { FakeBackend } from "../src/fake/FakeBackend.ts"

const cabin = "prj_cabin" as ProjectId
const cabinRule = "msg_cabinrule" as MessageId

const appLayer = makeAppLayer(
  { apiUrl: "https://dream.test", backend: "fixtures" },
  {
    storage: SecureStorage.layerMemory(),
    webSocket: Socket.layerWebSocketConstructorGlobal,
    fetch: globalThis.fetch
  }
).pipe(Layer.provideMerge(Reactivity.layer))

const signIn = Effect.gen(function* () {
  const app = yield* AppClient
  const session = yield* Session
  const result = yield* app.DevSignIn({ email: "ada@example.com", secret: Redacted.make("fixtures") })
  yield* session.signIn({ token: result.sessionToken, user: result.user })
})

const run = <A, E>(effect: Effect.Effect<A, E, any>) => effect.pipe(Effect.provide(appLayer)) as Effect.Effect<A, E>

describe("fixtures backend through the app's services", () => {
  it.effect("refuses authenticated calls until signed in", () =>
    run(
      Effect.gen(function* () {
        const app = yield* AppClient
        const error = yield* Effect.flip(app.ListProjects())
        assert.strictEqual(error._tag, "Unauthorized")
        yield* signIn
        const projects = yield* app.ListProjects()
        assert.deepStrictEqual(
          projects.map((p) => p.project.title),
          ["Lift Log", "Morning Brief", "Cabin", "Recipe Scaler"]
        )
      })
    )
  )

  it.effect("lists open asks oldest first, including later ones for Status", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const asks = yield* (yield* AppClient).ListOpenAsks()
        assert.deepStrictEqual(
          asks.map((a) => a.message.id),
          ["msg_apple", "msg_brieftelegram", "msg_cabinrule", "msg_cabinpick", "msg_gcal", "msg_recipewho"]
        )
      })
    )
  )

  it.effect("a key file goes to its project only, and removing it marks the card, which takes a key again", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        const brief = "prj_morningbrief" as ProjectId
        const messageId = "msg_brieftelegram" as MessageId
        const connected = yield* app.SubmitKeyAccess({
          projectId: brief,
          messageId,
          key: Redacted.make("FAKE:telegram")
        })
        assert.strictEqual(connected.state._tag, "Connected")
        const file = (yield* app.ListIntegrations()).find((i) => i.access._tag === "File")!
        assert.deepStrictEqual(file.access, {
          _tag: "File",
          service: "Telegram",
          name: "telegram-bot-token",
          path: "/home/user/.dream/keys/telegram-bot-token",
          projectId: brief
        })
        yield* app.DisconnectIntegration({ integrationId: file.id })
        const { messages } = yield* app.ListMessages({ projectId: brief })
        const card = messages.find((m) => m.id === messageId)
        assert.strictEqual(card?._tag === "Access" && card.state._tag, "Disconnected")
        const again = yield* app.SubmitKeyAccess({ projectId: brief, messageId, key: Redacted.make("FAKE:again") })
        assert.strictEqual(again.state._tag, "Connected")
      })
    )
  )

  it.effect("connects an OAuth request as if they'd approved it, and lists the integration", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        yield* (yield* FakeBackend).scenario("spotify-ask")
        const asks = yield* app.ListOpenAsks()
        assert.isTrue(asks.some((a) => a.message.id === "msg_spotify"))
        const projectId = "prj_liftlog" as ProjectId
        const messageId = "msg_spotify" as MessageId
        const { authorizeUrl } = yield* app.StartOAuthAccess({ projectId, messageId })
        assert.include(authorizeUrl, "spotify")
        yield* TestClock.adjust("10 seconds")
        const integrations = yield* app.ListIntegrations()
        const spotify = integrations.find((i) => i.access._tag === "OAuth")
        assert.strictEqual(spotify?.label, "Spotify")
        assert.isFalse((yield* app.ListOpenAsks()).some((a) => a.message.id === "msg_spotify"))
        const notOAuth = yield* Effect.flip(app.StartOAuthAccess({ projectId, messageId: "msg_apple" as MessageId }))
        assert.strictEqual(notOAuth._tag, "InvalidRequest")
      })
    )
  )

  it.effect("holds an answer for the undo window, then sends it", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const answers = yield* Answers
        const app = yield* AppClient
        yield* answers.answerUndoable({
          projectId: cabin,
          messageId: cabinRule,
          answer: { _tag: "Choice", option: "First to ask" }
        })
        assert.isTrue((yield* SubscriptionRef.get(answers.pending)).has(cabinRule))
        assert.isTrue((yield* app.ListOpenAsks()).some((a) => a.message.id === cabinRule))
        yield* TestClock.adjust("5 seconds")
        assert.isFalse((yield* SubscriptionRef.get(answers.pending)).has(cabinRule))
        assert.isFalse((yield* app.ListOpenAsks()).some((a) => a.message.id === cabinRule))
      })
    )
  )

  it.effect("Undo inside the window means the answer is never sent", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const answers = yield* Answers
        const app = yield* AppClient
        yield* answers.answerUndoable({
          projectId: cabin,
          messageId: cabinRule,
          answer: { _tag: "Choice", option: "First to ask" }
        })
        yield* TestClock.adjust("2 seconds")
        assert.isTrue(yield* answers.undo(cabinRule))
        yield* TestClock.adjust("10 seconds")
        assert.isTrue((yield* app.ListOpenAsks()).some((a) => a.message.id === cabinRule))
        assert.strictEqual((yield* SubscriptionRef.get(answers.pending)).size, 0)
      })
    )
  )

  it.effect("rejects an option the question doesn't have", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const answers = yield* Answers
        const failure = yield* Effect.flip(
          answers.answerNow({ projectId: cabin, messageId: cabinRule, answer: { _tag: "Choice", option: "Coin toss" } })
        )
        assert.include(failure.message, "isn't one of the options")
      })
    )
  )

  it.effect("folds the live stream into project state, then the agent's reply", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const states = yield* ProjectStates
        const answers = yield* Answers
        const seen: Array<string> = []
        const fiber = yield* states.state(cabin).pipe(
          Stream.filter(Option.isSome),
          Stream.map((state) => state.value),
          Stream.tap((state) =>
            Effect.sync(() => {
              const rule = state.messages.find((m) => m.id === cabinRule)
              seen.push(
                `${rule?._tag === "Question" ? rule.state._tag : "?"}:${state.messages.length}:${state.working}`
              )
            })
          ),
          Stream.runDrain,
          Effect.forkChild
        )
        yield* TestClock.adjust("10 millis")
        yield* answers.answerNow({
          projectId: cabin,
          messageId: cabinRule,
          answer: { _tag: "Choice", option: "First to ask" }
        })
        yield* TestClock.adjust("5 seconds")
        yield* Fiber.interrupt(fiber)
        assert.strictEqual(seen[0], "Open:5:false")
        assert.include(seen, "Answered:5:true")
        assert.strictEqual(seen[seen.length - 1], "Answered:6:false")
      })
    )
  )

  it.effect("a new idea becomes a project whose agent asks its first question and pushes it", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        const backend = yield* FakeBackend
        const pushes = yield* backend.pushes.pipe(Stream.take(1), Stream.runCollect, Effect.forkChild)
        yield* TestClock.adjust("10 millis")
        const project = yield* app.CreateProject({ idea: "A tiny app that tracks which plants need water" })
        assert.strictEqual(project.phase, "new")
        yield* TestClock.adjust("7 seconds")
        const asks = yield* app.ListOpenAsks()
        const question = asks.find((a) => a.project.id === project.id)
        assert.strictEqual(question?.project.title, "Tiny Tracks")
        const [push] = yield* Fiber.join(pushes)
        assert.strictEqual(push?.data._tag, "OpenMessage")
        assert.strictEqual(push?.category, "question")
      })
    )
  )

  it.effect("the session survives a restart and the device id is stable", () =>
    Effect.gen(function* () {
      const storage = yield* Layer.build(SecureStorage.layerMemory())
      const launch = Effect.gen(function* () {
        return yield* Session
      }).pipe(Effect.provide(Session.layer.pipe(Layer.provide(Layer.succeedContext(storage)))))
      const first = yield* launch
      yield* first.signIn({ token: Redacted.make("tok"), user: Fx.user })
      const second = yield* launch
      assert.strictEqual(second.deviceId, first.deviceId)
      const restored = Option.getOrUndefined(yield* SubscriptionRef.get(second.current))
      assert.strictEqual(restored?.user.email, "ada@example.com")
      assert.strictEqual(restored && Redacted.value(restored.token), "tok")
      yield* second.signOut
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get((yield* launch).current)))
    }).pipe(Effect.scoped)
  )
})
