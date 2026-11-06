/** An empty Home: the fixtures scenario for it, and the drawn arrow that leads to the input. */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { Reactivity } from "effect/reactivity"
import { Socket } from "effect/socket"
import { AppClient } from "../src/data/AppClient.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"
import { FakeBackend } from "../src/fake/FakeBackend.ts"
import { arrowArt, arrowBox, arrowHeading } from "../src/ui/handArrow.ts"

const appLayer = makeAppLayer(
  { apiUrl: "https://dream.test", backend: "fixtures" },
  { storage: SecureStorage.layerMemory(), webSocket: Socket.layerWebSocketConstructorGlobal, fetch: globalThis.fetch }
).pipe(Layer.provideMerge(Reactivity.layer))

const run = <A, E>(effect: Effect.Effect<A, E, any>) => effect.pipe(Effect.provide(appLayer)) as Effect.Effect<A, E>

describe("empty Home", () => {
  it.effect("no-projects leaves no projects and no links", () =>
    run(
      Effect.gen(function* () {
        const app = yield* AppClient
        const session = yield* Session
        const result = yield* app.DevSignIn({ email: "ada@example.com", secret: Redacted.make("fixtures") })
        yield* session.signIn({ token: result.sessionToken, user: result.user })
        const backend = yield* FakeBackend
        yield* backend.scenario("no-projects")
        assert.lengthOf(yield* app.ListProjects(), 0)
        assert.lengthOf(yield* app.ListLinks(), 0)
      })
    )
  )

  it("lands the arrow's tip at the bottom centre, heading down", () => {
    assert.closeTo(arrowArt.tip[0], arrowBox.width / 2, 1)
    assert.isAtMost(arrowArt.tip[1], arrowBox.height)
    assert.isAtLeast(arrowArt.tip[1], arrowBox.height - 4)
    // Within 10° of straight down, so the head points at the input.
    assert.closeTo(arrowHeading, Math.PI / 2, (10 * Math.PI) / 180)
    assert.lengthOf(arrowArt.barbs, 2)
  })
})
