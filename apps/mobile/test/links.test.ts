/** App links on Home against the fixtures backend, through the app's own RPC client. */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { Reactivity } from "effect/reactivity"
import { Socket } from "effect/socket"
import { AppClient } from "../src/data/AppClient.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { linkChoices } from "../src/data/linkChoices.ts"
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
  it.effect("lists the dock, renames, re-icons, removes and puts back", () =>
    run(
      Effect.gen(function* () {
        const app = yield* signIn
        const links = yield* app.ListLinks()
        assert.deepStrictEqual(
          links.map((l) => l.title),
          ["Lift Log", "Brief", "Cabin", "Train times"]
        )
        assert.isUndefined(links.find((l) => l.title === "Cabin")?.openedAt)

        const refused = yield* Effect.flip(
          app.AddLink({ url: "https://morning-brief-k3x9q2.dream.example", title: "Digest", color: "orange" })
        )
        assert.strictEqual(refused._tag, "InvalidRequest")

        const cabin = links.find((l) => l.title === "Cabin")!
        const renamed = yield* app.UpdateLink({ linkId: cabin.id, title: "Weekends", icon: null })
        assert.strictEqual(renamed.title, "Weekends")
        assert.isUndefined(renamed.icon)
        assert.deepStrictEqual(renamed.theirs, ["title", "icon"])

        yield* app.MarkLinkOpened({ linkId: cabin.id })
        const brief = links.find((l) => l.title === "Brief")!
        const train = links.find((l) => l.title === "Train times")!
        yield* app.RemoveLink({ linkId: brief.id })
        yield* app.RemoveLink({ linkId: train.id })
        assert.deepStrictEqual(
          (yield* app.ListLinks()).map((l) => l.title),
          ["Lift Log", "Weekends"]
        )
        // The agent's link waits to be put back; the one they added themselves is gone.
        assert.deepStrictEqual(
          (yield* app.ListRemovedLinks()).map((l) => l.id),
          [brief.id]
        )
        const back = yield* app.RestoreLink({ linkId: brief.id })
        assert.isUndefined(back.removedAt)
        const after = yield* app.ListLinks()
        assert.deepStrictEqual(
          after.map((l) => l.title),
          ["Lift Log", "Brief", "Weekends"]
        )
        assert.lengthOf(yield* app.ListRemovedLinks(), 0)
        assert.isDefined(after.find((l) => l.id === cabin.id)?.openedAt)

        const { url } = yield* app.PrepareHomeScreen({ linkId: cabin.id })
        assert.strictEqual(url, "https://cabin-k3x9q2.dream.example?dream_home_screen=1")
      })
    )
  )

  it.effect("has scenarios for an empty dock, new links, links to put back and none from agents", () =>
    run(
      Effect.gen(function* () {
        const app = yield* signIn
        const backend = yield* FakeBackend
        yield* backend.scenario("links-new")
        assert.lengthOf(yield* app.ListLinks(), 6)
        yield* backend.scenario("links-empty")
        assert.lengthOf(yield* app.ListLinks(), 0)
        yield* backend.scenario("reset")
        yield* backend.scenario("links-removed")
        assert.deepStrictEqual(linkChoices(yield* app.ListLinks(), yield* app.ListRemovedLinks()), {
          _tag: "Choices",
          links: yield* app.ListRemovedLinks()
        })
        assert.deepStrictEqual(
          (yield* app.ListRemovedLinks()).map((l) => l.title),
          ["Rest timer", "Brief"]
        )
        yield* backend.scenario("reset")
        yield* backend.scenario("links-nothing-published")
        assert.deepStrictEqual(
          (yield* app.ListLinks()).map((l) => l.title),
          ["Train times"]
        )
        assert.deepStrictEqual(linkChoices(yield* app.ListLinks(), yield* app.ListRemovedLinks()), {
          _tag: "NothingYet"
        })
      })
    )
  )
})
