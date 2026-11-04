/**
 * The contracts work end to end: a real RpcServer and RpcClient over HTTP with
 * the serialization from `Transport.ts`, bearer-token middleware on both sides,
 * and a streaming RPC.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Stream } from "effect"
import { FetchHttpClient, Headers, HttpEffect } from "effect/http"
import { RpcClient, RpcGroup, RpcMiddleware, RpcServer } from "effect/rpc"
import {
  AgentEvent,
  DaemonAuth,
  DaemonRpcs,
  HttpRpcSerialization,
  ProjectEvent,
  ProjectLiveRpcs,
  Routes,
  Unauthorized
} from "../src/index.ts"
import * as Fixtures from "../src/fixtures.ts"

const token = "daemon-secret"

/** Serve `group` in memory and return a client layer that talks to it over HTTP. */
const inMemoryHttp = <R extends RpcGroup.Any>(group: R, serverLayer: Layer.Layer<any, never, never>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const httpEffect = yield* RpcServer.toHttpEffect(group as any).pipe(
        Effect.provide(Layer.mergeAll(serverLayer, HttpRpcSerialization))
      )
      const handler = HttpEffect.toWebHandler(httpEffect)
      const fetch: typeof globalThis.fetch = (input, init) => handler(new Request(input, init))
      return RpcClient.layerProtocolHttp({ url: `http://daemon${Routes.daemon}` }).pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
        Layer.provide(HttpRpcSerialization)
      )
    })
  )

const DaemonHandlers = DaemonRpcs.toLayer({
  Deliver: ({ events }) => Effect.succeed({ accepted: events.map((event) => event.id) }),
  Health: () => Effect.succeed({ version: "test", turn: "idle" as const, queued: 0 })
})

/** Server side: check the bearer token. */
const DaemonAuthServer = Layer.succeed(DaemonAuth, (effect, { headers }) =>
  Option.getOrUndefined(Headers.get(headers, "authorization")) === `Bearer ${token}`
    ? effect
    : Effect.fail(new Unauthorized({ message: "bad daemon token" }))
)

/** Client side: attach a bearer token. */
const daemonAuthClient = (bearer: string) =>
  RpcMiddleware.layerClient(DaemonAuth, ({ request, next }) =>
    next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${bearer}`) })
  )

describe("DaemonRpcs over HTTP", () => {
  const transport = inMemoryHttp(DaemonRpcs, Layer.mergeAll(DaemonHandlers, DaemonAuthServer))

  it.effect("delivers events with the daemon token", () =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(DaemonRpcs)
      const events = Fixtures.events as unknown as readonly [AgentEvent, ...Array<AgentEvent>]
      const result = yield* client.Deliver({ events })
      assert.deepStrictEqual(
        result.accepted,
        events.map((event) => event.id)
      )
    }).pipe(Effect.provide(Layer.mergeAll(transport, daemonAuthClient(token))))
  )

  it.effect("rejects a wrong token with Unauthorized", () =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(DaemonRpcs)
      const exit = yield* client.Health().pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      const error = yield* Effect.flip(client.Health())
      assert.strictEqual(error._tag, "Unauthorized")
    }).pipe(Effect.provide(Layer.mergeAll(transport, daemonAuthClient("wrong"))))
  )
})

describe("ProjectLiveRpcs", () => {
  const LiveHandlers = ProjectLiveRpcs.toLayer({
    Subscribe: () =>
      Stream.make(
        ProjectEvent.cases.Snapshot.make({
          project: Fixtures.cabin,
          status: { ...Fixtures.liftLogStatus, phase: "exploring" },
          messages: [Fixtures.cabinQuestion],
          hasEarlierMessages: false,
          working: false
        }),
        ProjectEvent.cases.WorkingChanged.make({ working: true })
      )
  })

  it.effect("streams a snapshot first, then changes", () =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(ProjectLiveRpcs)
      const received = yield* client.Subscribe().pipe(Stream.runCollect)
      assert.deepStrictEqual(
        received.map((event) => event._tag),
        ["Snapshot", "WorkingChanged"]
      )
      const [snapshot] = received
      assert.strictEqual(snapshot?._tag === "Snapshot" && snapshot.messages[0]?._tag, "Question")
    }).pipe(Effect.provide(inMemoryHttp(ProjectLiveRpcs, LiveHandlers)))
  )
})
