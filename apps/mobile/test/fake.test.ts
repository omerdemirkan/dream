/**
 * The app's data layer end to end against the fixtures backend: the real RPC
 * client (through `RpcTest`), sessions, held answers with Undo, and live
 * project state.
 */
import { type MessageId, type ProjectId, RequestId, type WorkstreamId } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { Clock, DateTime, Effect, Fiber, Layer, Option, Redacted, Stream, SubscriptionRef } from "effect"
import { Reactivity } from "effect/reactivity"
import { Socket } from "effect/socket"
import { TestClock } from "effect/testing"
import { AccountUsages } from "../src/data/AccountUsages.ts"
import { AppClient } from "../src/data/AppClient.ts"
import { Answers } from "../src/data/Answers.ts"
import { withWriteTimeout, writeTimeout } from "../src/data/errors.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { ProjectArchive } from "../src/data/ProjectArchive.ts"
import { ProjectStates } from "../src/data/ProjectStates.ts"
import { ProjectUsages } from "../src/data/ProjectUsages.ts"
import { profileHint, usageBadge } from "../src/data/usage.ts"
import { chatRowOf, presenceOf, receiptOf } from "../src/data/presence.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { randomUuid, Session } from "../src/data/Session.ts"
import { unsupportedText } from "../src/data/Tolerant.ts"
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

  it.effect("counts what needs them now on Home's rows, leaving out access for later", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const projects = yield* (yield* AppClient).ListProjects()
        assert.deepStrictEqual(
          projects.map((p) => [p.project.title, p.openAsks]),
          [
            ["Lift Log", 0],
            ["Morning Brief", 1],
            ["Cabin", 3],
            ["Recipe Scaler", 1]
          ]
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

  it.effect("workstreams: the scenarios put Lift Log in each state, and a message into one is answered in it", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        const backend = yield* FakeBackend
        const lift = "prj_liftlog" as ProjectId
        yield* backend.scenario("workstreams")
        const { messages } = yield* app.ListMessages({ projectId: lift })
        assert.strictEqual(messages.find((m) => m.id === "msg_wsandroid")?.workstream, "ws_android")
        assert.strictEqual(messages.find((m) => m.id === "msg_lift1rm")?.workstream, "ws_charts")

        const sent = yield* app.SendMessage({
          projectId: lift,
          text: "Only if it doesn't slow down iPhone",
          workstream: "ws_android" as WorkstreamId
        })
        assert.strictEqual(sent.workstream, "ws_android")
        const stray = yield* app.SendMessage({
          projectId: lift,
          text: "Thanks",
          workstream: "ws_gone" as WorkstreamId
        })
        assert.notProperty(stray, "workstream")
        yield* TestClock.adjust("30 seconds")
        const after = (yield* app.ListMessages({ projectId: lift })).messages
        const replies = after.filter((m) => m._tag === "Text" && m.from === "agent" && m.text.startsWith("Noted."))
        assert.sameMembers(
          replies.map((m) => String(m.workstream)),
          ["ws_android", "undefined"]
        )

        yield* backend.scenario("workstreams-waiting")
        const waiting = (yield* app.ListMessages({ projectId: lift })).messages
        const sound = waiting.find((m) => m.id === "msg_wssound")
        assert.strictEqual(sound?._tag === "Question" ? sound.state._tag : undefined, "Open")
        assert.isTrue((yield* app.ListOpenAsks()).some((a) => a.message.id === "msg_wssound"))
      })
    )
  )

  it.effect("signs out when the API no longer accepts the session", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const session = yield* Session
        const app = yield* AppClient
        const signedIn = Option.getOrThrow(yield* SubscriptionRef.get(session.current))
        yield* session.signIn({ ...signedIn, token: Redacted.make("expired") })
        const error = yield* Effect.flip(app.ListProjects())
        assert.strictEqual(error._tag, "Unauthorized")
        assert.isTrue(Option.isNone(yield* session.token))
      })
    )
  )

  it.effect("shows a message this build can't decode as the neutral row", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        yield* (yield* FakeBackend).scenario("unsupported-message")
        const { messages } = yield* app.ListMessages({ projectId: cabin })
        const row = messages.find((m) => m.id === "msg_unsupported")
        assert.strictEqual(row?._tag, "Text")
        assert.strictEqual(row?._tag === "Text" ? row.text : undefined, unsupportedText)
      })
    )
  )

  it.effect("stalls the next write past the timeout, then lets the retry through", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        yield* (yield* FakeBackend).scenario("stall-next-write")
        const send = app.SendMessage({ projectId: cabin, text: "Weekends only" }).pipe(withWriteTimeout)
        const stalled = yield* Effect.forkChild(send)
        yield* TestClock.adjust(writeTimeout)
        const failure = yield* Effect.flip(Fiber.join(stalled))
        assert.strictEqual(failure._tag, "RequestTimedOut")
        const sent = yield* send
        assert.strictEqual(sent._tag === "Text" ? sent.text : undefined, "Weekends only")
      })
    )
  )

  it.effect("an answer goes out at once, and Home's row counts one fewer", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const answers = yield* Answers
        const app = yield* AppClient
        const cabinAsks = Effect.map(app.ListProjects(), (all) => all.find((s) => s.project.id === cabin)?.openAsks)
        assert.strictEqual(yield* cabinAsks, 3)
        const answered = yield* answers.answerNow({
          projectId: cabin,
          messageId: cabinRule,
          answer: { _tag: "Choice", option: "First to ask" }
        })
        assert.strictEqual(answered.state._tag, "Answered")
        assert.strictEqual(yield* cabinAsks, 2)
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

describe("the agent's presence in fixtures (A+B+C)", () => {
  const recipe = "prj_recipescaler" as ProjectId

  it.effect("a message to a sleeping project: Sent, starting and Seen, working, then the reply and Done for now", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        const states = yield* ProjectStates
        const seen: Array<string> = []
        const fiber = yield* states.state(recipe).pipe(
          Stream.filter(Option.isSome),
          Stream.map((state) => state.value),
          Stream.tap((state) =>
            Effect.gen(function* () {
              const now = DateTime.makeUnsafe(yield* Clock.currentTimeMillis)
              const presence = presenceOf({
                activity: state.activity,
                working: state.working,
                pausedUntil: state.status.pausedUntil,
                now
              })
              const row = chatRowOf(presence, state.messages, now)
              const receipt = receiptOf(state.messages, state.activity)
              const step = `${presence._tag}|${row?._tag ?? "-"}|${receipt ? (receipt.seen ? "Seen" : "Sent") : "-"}`
              if (seen.at(-1) !== step) seen.push(step)
            })
          ),
          Stream.runDrain,
          Effect.forkChild
        )
        yield* TestClock.adjust("10 millis")
        yield* app.SendMessage({
          projectId: recipe,
          text: "Metric too, please",
          requestId: RequestId.make(randomUuid())
        })
        yield* TestClock.adjust("10 seconds")
        yield* Fiber.interrupt(fiber)
        assert.deepStrictEqual(seen, [
          "Asleep|-|Seen",
          "Asleep|Sent|Sent",
          "Starting|Starting|Sent",
          "Starting|Starting|Seen",
          "Working|Working|Seen",
          "Awake|Done|Seen"
        ])
        const [home] = (yield* app.ListProjects()).filter((s) => s.project.id === recipe)
        assert.strictEqual(home?.activity?.state, "idle")
      })
    )
  )

  it.effect("the header's usage starts from the fetch, then follows each turn's Usage event and the scenarios", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        const usages = yield* ProjectUsages
        const backend = yield* FakeBackend
        const lift = Fx.liftLog.id
        const seen: Array<string> = []
        const fiber = yield* usages.glance(lift).pipe(
          Stream.tap((glance) => Effect.sync(() => seen.push(usageBadge(glance)?.value ?? "-"))),
          Stream.runDrain,
          Effect.forkChild
        )
        yield* TestClock.adjust("10 millis")
        assert.deepStrictEqual(seen, ["-", "4%"])
        const sheet = yield* usages.sheet(lift)
        assert.strictEqual(sheet.weekly?.projectPercent, 4)
        assert.deepStrictEqual(
          sheet.projects.map((p) => [p.title, p.sharePercent]),
          [
            ["Recipe Scaler", 19],
            ["Lift Log", 4],
            ["Cabin", 3],
            ["Morning Brief", 2]
          ]
        )

        yield* app.SendMessage({ projectId: lift, text: "Add a rest timer", requestId: RequestId.make(randomUuid()) })
        yield* TestClock.adjust("10 seconds")
        const after = yield* usages.sheet(lift)
        assert.isAbove(after.weekly?.projectPercent ?? 0, 4)
        assert.isAbove(after.week.tokens ?? 0, sheet.week.tokens ?? 0)

        yield* backend.scenario("usage-near-limit")
        yield* TestClock.adjust("10 millis")
        yield* backend.scenario("usage-none")
        yield* TestClock.adjust("10 millis")
        yield* Fiber.interrupt(fiber)
        assert.deepStrictEqual(seen.slice(-2), ["8% left", "-"])
        const none = yield* usages.sheet(lift)
        assert.isUndefined(none.weekly)
        assert.isUndefined(none.week.tokens)
      })
    )
  )

  it.effect("Settings' plan card follows the same usage world, and the profile hint shows only near the limit", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        const accounts = yield* AccountUsages
        const backend = yield* FakeBackend
        const plan = yield* accounts.plan("chatgpt")
        assert.strictEqual(plan?.plan, "ChatGPT Pro")
        assert.strictEqual(plan?.weekly?.usedPercent, 38)
        assert.strictEqual(plan?.weekly?.dreamPercent, 28)
        assert.strictEqual(plan?.outsideDreamPercent, 10)
        assert.deepStrictEqual(
          plan?.projects.map((p) => p.title),
          ["Recipe Scaler", "Lift Log", "Cabin", "Morning Brief"]
        )
        // No Claude subscription in the sample world.
        assert.isUndefined(yield* accounts.plan("claude"))
        assert.isFalse(profileHint(yield* app.ListModelConnections()))

        yield* backend.scenario("usage-near-limit")
        const near = yield* accounts.plan("chatgpt")
        assert.strictEqual(near?.weekly?.usedPercent, 92)
        const connections = yield* app.ListModelConnections()
        assert.strictEqual(connections[0]?.usage?.weekly?.usedPercent, 92)
        assert.isTrue(profileHint(connections))

        yield* backend.scenario("usage-none")
        const none = yield* accounts.plan("chatgpt")
        assert.isUndefined(none?.weekly)
        assert.deepStrictEqual(none?.projects, [])
      })
    )
  )

  it.effect("every stage of the mock's scenario is a scenario", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        const backend = yield* FakeBackend
        const liftRow = Effect.map(app.ListProjects(), (rows) => rows.find((s) => s.project.slug === "lift-log"))
        for (const [scenario, state] of [
          ["activity-sent", "idle"],
          ["activity-starting", "starting"],
          ["activity-working", "working"],
          ["activity-done", "idle"]
        ] as const) {
          yield* backend.scenario(scenario)
          assert.strictEqual((yield* liftRow)?.activity?.state, state, scenario)
        }
        yield* backend.scenario("activity-home")
        const rows = yield* app.ListProjects()
        assert.isDefined(rows.find((s) => s.project.slug === "recipe-scaler")?.pausedUntil)
        assert.isDefined(rows.find((s) => s.project.slug === "morning-brief")?.activity?.nextWakeAt)
        yield* backend.scenario("activity-new-idea")
        const fresh = (yield* app.ListProjects()).find((s) => s.project.id === "prj_newidea")
        assert.strictEqual(fresh?.activity?.state, "starting")
      })
    )
  )
})

describe("archiving and deleting projects", () => {
  const recipe = "prj_recipescaler" as ProjectId

  it.effect("archiving hides a project at once, lists it as archived, and Undo brings it back as it was", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        const archive = yield* ProjectArchive
        const titles = Effect.map(app.ListProjects(), (rows) => rows.map((row) => row.project.title))
        const archived = yield* archive.archive(recipe)
        assert.strictEqual(archived.project.title, "Recipe Scaler")
        assert.isTrue((yield* SubscriptionRef.get(archive.hidden)).has(recipe))
        assert.deepStrictEqual(yield* titles, ["Lift Log", "Morning Brief", "Cabin"])
        assert.notInclude(
          (yield* app.ListOpenAsks()).map((ask) => ask.message.id),
          "msg_recipewho" as MessageId
        )
        assert.deepStrictEqual(
          (yield* app.ListArchivedProjects()).map((row) => row.project.id),
          [recipe]
        )
        const restored = yield* archive.restore(recipe)
        assert.strictEqual(restored.openAsks, 1)
        assert.isFalse((yield* SubscriptionRef.get(archive.hidden)).has(recipe))
        assert.deepStrictEqual(yield* titles, ["Lift Log", "Morning Brief", "Cabin", "Recipe Scaler"])
        assert.deepStrictEqual(yield* app.ListArchivedProjects(), [])
      })
    )
  )

  it.effect("a failed archive puts the project back on Home", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const archive = yield* ProjectArchive
        const error = yield* Effect.flip(archive.archive("prj_nope" as ProjectId))
        assert.strictEqual(error._tag, "NotFound")
        assert.isFalse((yield* SubscriptionRef.get(archive.hidden)).has("prj_nope" as ProjectId))
      })
    )
  )

  it.effect("deleting removes it everywhere, its file keys too, and deleting it again is fine", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        const archive = yield* ProjectArchive
        const brief = "prj_morningbrief" as ProjectId
        yield* app.SubmitKeyAccess({
          projectId: brief,
          messageId: "msg_brieftelegram" as MessageId,
          key: Redacted.make("123:abc")
        })
        yield* archive.remove(brief)
        yield* archive.remove(brief)
        assert.notInclude(
          (yield* app.ListProjects()).map((row) => row.project.id),
          brief
        )
        assert.isTrue(
          (yield* app.ListIntegrations()).every(
            (integration) => !(integration.access._tag === "File" && integration.access.projectId === brief)
          )
        )
        assert.strictEqual((yield* Effect.flip(app.GetLiveUrl({ projectId: brief })))._tag, "NotFound")
      })
    )
  )
})
