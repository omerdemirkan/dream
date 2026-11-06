/**
 * One Durable Object per relay (SQLite-backed), named by its relay id: it holds the relay's line open from the
 * Worker while the project's sandbox sleeps, and hands what arrives to the project (`relay/Runtime.ts`). Only the
 * project's ProjectDO calls it, at `RelayRpcPath`; nothing outside the Worker reaches it.
 *
 * It reaches the ProjectDO through the Worker's env rather than a binding of its own (see `lib/StubFetch.ts`).
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { HttpRpcSerialization, type ProjectId } from "@dream/domain"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { Context, Effect, Layer, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { RpcServer } from "effect/rpc"
import { type NamespaceLike, stubFetch } from "./lib/StubFetch.ts"
import { ProjectClients } from "./project/Client.ts"
import { Dialer } from "./relay/Dialer.ts"
import { discordEndpointsFromEnv, RelayHandlers, relayLayer } from "./relay/RelayLayer.ts"
import { RelayHost } from "./relay/RelayHost.ts"
import { RelayRpcPath, RelayRpcs } from "./relay/RelayRpcs.ts"
import { RelayRuntime } from "./relay/Runtime.ts"

export default class RelayDO extends Cloudflare.DurableObject<RelayDO>()(
  "RelayDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState

    return Effect.gen(function* () {
      const runtime = yield* RuntimeContext
      // `get` reads the Worker's env (its bindings); `runtime.env` holds only what alchemy captured at init.
      const projects = yield* runtime.get<NamespaceLike>("ProjectDO")
      const services = relayLayer(state.raw.storage as unknown as DurableObjectStorage).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            RelayHost.layer.pipe(
              Layer.provide(
                ProjectClients.layer((projectId: ProjectId, request) => stubFetch(projects, projectId, request))
              )
            ),
            Dialer.layerFetch,
            discordEndpointsFromEnv,
            FetchHttpClient.layer
          )
        )
      )

      // The services, and the line and outbox they run, live as long as this activation.
      const instanceScope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(
        Layer.mergeAll(RelayHandlers).pipe(Layer.provideMerge(services)),
        instanceScope
      )
      const relay = Context.get(context, RelayRuntime)
      const handler = yield* RpcServer.toHttpEffect(RelayRpcs).pipe(
        Effect.provide(Layer.mergeAll(Layer.succeedContext(context), HttpRpcSerialization)),
        Scope.provide(instanceScope)
      )
      // An object that restarted (a deploy) picks its line up at once rather than at the next alarm.
      yield* Effect.forkIn(relay.alarm, instanceScope)

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest
          const path = new URL(request.url, "https://relay").pathname.replace(/\/+$/, "")
          if (path === RelayRpcPath && request.method === "POST") return yield* handler
          return HttpServerResponse.text("Not found", { status: 404 })
        }),
        alarm: () => relay.alarm
      }
    })
  })
) {}
