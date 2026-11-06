/** App links on Home against the fixtures backend, through the app's own RPC client. */
import { RequestId } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { Reactivity } from "effect/reactivity"
import { Socket } from "effect/socket"
import { AppClient } from "../src/data/AppClient.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"
import { FakeBackend } from "../src/fake/FakeBackend.ts"

const appLayer = makeAppLayer(
  { apiUrl: "https://dream.test", backend: "fixtures" },
  { storage: SecureStorage.layerMemory(), webSocket: Socket.layerWebSocketConstructorGlobal, fetch: globalThis.fetch }
).pipe(Layer.provideMerge(Reactivity.layer))

const run = <A, E>(effect: Effect.Effect<A, E, any>) => effect.pipe(Effect.provide(appLayer)) as Effect.Effect<A, E>

const signIn = Effect.gen(function* () {
  const app = yield* AppClient
  const session = yield* Session
  const result = yield* app.DevSignIn({ email: "ada@example.com", secret: Redacted.make("fixtures") })
  yield* session.signIn({ token: result.sessionToken, user: result.user })
  return app
})

describe("app links", () => {
  it.effect("lists the dock, adds, renames, re-icons and removes", () =>
    run(
      Effect.gen(function* () {
        const app = yield* signIn
        const links = yield* app.ListLinks()
        assert.deepStrictEqual(
          links.map((l) => l.title),
          ["Lift Log", "Brief", "Cabin", "Train times"]
        )
        assert.isUndefined(links.find((l) => l.title === "Cabin")?.openedAt)

        const added = yield* app.AddLink({
          url: "https://morning-brief-k3x9q2.dream.example",
          title: "Digest",
          color: "orange",
          requestId: RequestId.make("5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")
        })
        assert.strictEqual(added.projectId, "prj_morningbrief")
        assert.strictEqual(added.addedBy, "person")

        const cabin = links.find((l) => l.title === "Cabin")!
        const renamed = yield* app.UpdateLink({ linkId: cabin.id, title: "Weekends", icon: null })
        assert.strictEqual(renamed.title, "Weekends")
        assert.isUndefined(renamed.icon)
        assert.deepStrictEqual(renamed.theirs, ["title", "icon"])

        yield* app.MarkLinkOpened({ linkId: cabin.id })
        yield* app.RemoveLink({ linkId: added.id })
        const after = yield* app.ListLinks()
        assert.deepStrictEqual(
          after.map((l) => l.title),
          ["Lift Log", "Brief", "Weekends", "Train times"]
        )
        assert.isDefined(after.find((l) => l.id === cabin.id)?.openedAt)

        const { url } = yield* app.PrepareHomeScreen({ linkId: cabin.id })
        assert.strictEqual(url, "https://cabin-k3x9q2.dream.example?dream_home_screen=1")
        const train = after.find((l) => l.title === "Train times")!
        assert.strictEqual((yield* app.PrepareHomeScreen({ linkId: train.id })).url, train.url)
      })
    )
  )

  it.effect("has scenarios for an empty dock and new links", () =>
    run(
      Effect.gen(function* () {
        const app = yield* signIn
        const backend = yield* FakeBackend
        yield* backend.scenario("links-new")
        assert.lengthOf(yield* app.ListLinks(), 6)
        yield* backend.scenario("links-empty")
        assert.lengthOf(yield* app.ListLinks(), 0)
      })
    )
  )
})
