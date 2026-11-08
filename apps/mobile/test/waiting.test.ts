/**
 * A project's screen while its live connection isn't there: what it showed last this session straight away, and
 * whether the new snapshot is on its way, slow, or not getting through (`ProjectStates.connection`).
 */
import type { ProjectId } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Redacted, Stream } from "effect"
import { Reactivity } from "effect/reactivity"
import { Socket } from "effect/socket"
import { TestClock } from "effect/testing"
import { AppClient } from "../src/data/AppClient.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { LiveProjects } from "../src/data/LiveProjects.ts"
import type { ProjectState } from "../src/data/projectState.ts"
import { type Connection, ProjectStates } from "../src/data/ProjectStates.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"
import { FakeBackend } from "../src/fake/FakeBackend.ts"

const lift = "prj_liftlog" as ProjectId

const appLayer = makeAppLayer(
  { apiUrl: "https://dream.test", backend: "fixtures" },
  {
    storage: SecureStorage.layerMemory(),
    webSocket: Socket.layerWebSocketConstructorGlobal,
    fetch: globalThis.fetch
  }
).pipe(Layer.provideMerge(Reactivity.layer))

const run = <A, E>(effect: Effect.Effect<A, E, any>) => effect.pipe(Effect.provide(appLayer)) as Effect.Effect<A, E>

const signIn = Effect.gen(function* () {
  const app = yield* AppClient
  const session = yield* Session
  const result = yield* app.DevSignIn({ email: "ada@example.com", secret: Redacted.make("fixtures") })
  yield* session.signIn({ token: result.sessionToken, user: result.user })
})

/** Opens the project as its screen does: its state and its connection, each as last seen. */
const open = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const states = yield* ProjectStates
    const seen = { state: Option.none<ProjectState>(), connection: [] as Array<Connection> }
    const fibers = [
      yield* states.state(projectId).pipe(
        Stream.runForEach((state) => Effect.sync(() => (seen.state = state))),
        Effect.forkChild
      ),
      yield* states.connection(projectId).pipe(
        Stream.runForEach((c) => Effect.sync(() => seen.connection.at(-1) !== c && seen.connection.push(c))),
        Effect.forkChild
      )
    ]
    yield* TestClock.adjust("10 millis")
    return { seen, close: Fiber.interruptAll(fibers) }
  })

describe("a project while its live connection isn't there", () => {
  it.effect("is connecting, slow after two seconds, then live when the snapshot lands", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        yield* (yield* FakeBackend).scenario("live-slow")
        const { seen, close } = yield* open(lift)
        assert.isTrue(Option.isNone(seen.state))
        assert.deepStrictEqual(seen.connection, ["connecting"])
        yield* TestClock.adjust("2 seconds")
        assert.deepStrictEqual(seen.connection, ["connecting", "slow"])
        yield* TestClock.adjust("4 seconds")
        assert.deepStrictEqual(seen.connection, ["connecting", "slow", "live"])
        assert.strictEqual(Option.getOrUndefined(seen.state)?.project.title, "Lift Log")
        yield* close
      })
    )
  )

  it.effect("opened again later, shows what it showed last until the new snapshot replaces it", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const backend = yield* FakeBackend
        const first = yield* open(lift)
        assert.isUndefined(Option.getOrUndefined(first.seen.state)?.status.pausedUntil)
        yield* first.close
        // Long enough for the subscription to close.
        yield* TestClock.adjust("1 minute")

        // Meanwhile it was paused, and the next connection is slow.
        yield* backend.scenario("paused")
        yield* backend.scenario("live-slow")
        const again = yield* open(lift)
        const shown = Option.getOrUndefined(again.seen.state)
        assert.strictEqual(shown?.project.title, "Lift Log")
        assert.isUndefined(shown?.status.pausedUntil)
        assert.deepStrictEqual(again.seen.connection, ["connecting"])

        yield* TestClock.adjust("6 seconds")
        assert.isDefined(Option.getOrUndefined(again.seen.state)?.status.pausedUntil)
        assert.strictEqual(again.seen.connection.at(-1), "live")
        yield* again.close
      })
    )
  )

  it.effect("is failing after three drops in a row, and live again once one gets through", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const backend = yield* FakeBackend
        yield* backend.scenario("live-down")
        const { seen, close } = yield* open(lift)
        yield* TestClock.adjust("2 seconds")
        assert.deepStrictEqual(seen.connection, ["connecting", "slow"])
        yield* TestClock.adjust("2 seconds")
        assert.deepStrictEqual(seen.connection, ["connecting", "slow", "failing"])
        assert.isTrue(Option.isNone(seen.state))

        // Back up: the next connection gets through, as after Try again.
        yield* backend.scenario("reset")
        yield* (yield* ProjectStates).reconnect
        yield* TestClock.adjust("10 millis")
        assert.strictEqual(seen.connection.at(-1), "live")
        assert.isTrue(Option.isSome(seen.state))
        yield* close
      })
    )
  )

  it.effect("a drop after it was live waits quietly at first, then is slow", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const backend = yield* FakeBackend
        const { seen, close } = yield* open(lift)
        assert.strictEqual(seen.connection.at(-1), "live")
        yield* backend.scenario("live-slow")
        yield* (yield* ProjectStates).reconnect
        yield* TestClock.adjust("10 millis")
        assert.strictEqual(seen.connection.at(-1), "connecting")
        assert.isTrue(Option.isSome(seen.state))
        yield* TestClock.adjust("2 seconds")
        assert.strictEqual(seen.connection.at(-1), "slow")
        yield* close
      })
    )
  )

  it.effect("is failing after twenty seconds of a connection that never answers", () =>
    Effect.gen(function* () {
      // Fresh: the app layer builds its own `ProjectStates.layer`, which would otherwise be shared.
      const states = Layer.fresh(ProjectStates.layer).pipe(
        Layer.provide(Layer.succeed(LiveProjects, LiveProjects.of({ subscribe: () => Stream.never }))),
        Layer.provide(appLayer)
      )
      yield* Effect.gen(function* () {
        const { seen, close } = yield* open(lift)
        yield* TestClock.adjust("19 seconds")
        assert.deepStrictEqual(seen.connection, ["connecting", "slow"])
        yield* TestClock.adjust("1 second")
        assert.deepStrictEqual(seen.connection, ["connecting", "slow", "failing"])
        yield* close
      }).pipe(Effect.provide(states))
    })
  )
})
