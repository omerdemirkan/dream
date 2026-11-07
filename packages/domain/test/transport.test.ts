import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { FetchHttpClient, Headers, HttpEffect } from "effect/http"
import { RpcClient, RpcMiddleware, RpcServer } from "effect/rpc"
import { type AgentEvent, DaemonAuth, DaemonRpcs, HttpRpcSerialization, ModelEgress, Routes } from "../src/index.ts"
import * as Fixtures from "../src/fixtures.ts"

describe("ModelEgress", () => {
  it("names the host and headers each harness's credential is injected with", () => {
    assert.strictEqual(ModelEgress["claude-code"].host, "api.anthropic.com")
    assert.deepStrictEqual(ModelEgress["claude-code"].headers({ oauthToken: "sk-ant-oat01-x" }), {
      Authorization: "Bearer sk-ant-oat01-x"
    })
    assert.strictEqual(ModelEgress.codex.host, "chatgpt.com")
    assert.deepStrictEqual(ModelEgress.codex.headers({ accessToken: "eyJ.a.b", accountId: "acct_1" }), {
      Authorization: "Bearer eyJ.a.b",
      "ChatGPT-Account-ID": "acct_1"
    })
  })
})

describe("Deliver", () => {
  it.effect("carries their time zone when the DO knows it, and works without it", () =>
    Effect.gen(function* () {
      const received: Array<string | undefined> = []
      const handlers = DaemonRpcs.toLayer({
        Deliver: ({ events, timeZone }) =>
          Effect.sync(() => {
            received.push(timeZone)
            return { accepted: events.map((event) => event.id) }
          }),
        ForwardRelay: ({ deliveries }) => Effect.succeed({ delivered: deliveries.length }),
        SetWatching: () => Effect.void,
        Health: () => Effect.succeed({ version: "test", turn: "idle" as const, queued: 0 })
      })
      const auth = Layer.succeed(DaemonAuth, (effect) => effect)
      const httpEffect = yield* RpcServer.toHttpEffect(DaemonRpcs).pipe(
        Effect.provide(Layer.mergeAll(handlers, auth, HttpRpcSerialization))
      )
      const handler = HttpEffect.toWebHandler(httpEffect)
      const fetch: typeof globalThis.fetch = (input, init) => handler(new Request(input, init))
      const client = yield* RpcClient.make(DaemonRpcs).pipe(
        Effect.provide(
          Layer.mergeAll(
            RpcClient.layerProtocolHttp({ url: `http://daemon${Routes.daemon}` }).pipe(
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
              Layer.provide(HttpRpcSerialization)
            ),
            RpcMiddleware.layerClient(DaemonAuth, ({ request, next }) =>
              next({ ...request, headers: Headers.set(request.headers, "authorization", "Bearer t") })
            )
          )
        )
      )
      const events = Fixtures.events as unknown as readonly [AgentEvent, ...Array<AgentEvent>]
      yield* client.Deliver({ events, timeZone: "America/Los_Angeles" })
      yield* client.Deliver({ events })
      assert.deepStrictEqual(received, ["America/Los_Angeles", undefined])
      assert.isTrue(Option.isNone(Option.fromNullishOr(received[1])))
    }).pipe(Effect.scoped)
  )
})
