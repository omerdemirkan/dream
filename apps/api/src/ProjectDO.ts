/**
 * One Durable Object per project (SQLite-backed): chat, questions and access
 * requests, the Status card, scheduled wakes, the sandbox, the Live Activity,
 * sent notifications, and the agent's event inbox. Its alarm fires wakes and
 * retries delivery.
 *
 * Two separate surfaces on `fetch`:
 * - `LivePath`: WebSocket upgrades (forwarded by the Worker after it checks
 *   the ticket), served by a `ProjectLiveRpcs`-only RPC server, hibernatable.
 * - `InternalRpcPath`: HTTP RPC for `ProjectRpcs` + `SandboxRpcs`, called only
 *   by the Worker, which never forwards phone requests there.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as RpcWebSocket from "@alchemy.run/cloudflare/Workers/RpcWebSocket"
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import { HttpRpcSerialization, type ProjectId, ProjectLiveRpcs, SocketRpcSerialization } from "@dream/domain"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { Context, Effect, Fiber, Layer, Scope } from "effect"
import type { HttpClientRequest } from "effect/http"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { RpcMiddleware, RpcServer } from "effect/rpc"
import { platformLayer } from "./Platform.ts"
import type { ProjectFetch } from "./project/Client.ts"
import { DoRpcs } from "./project/Client.ts"
import { AgentHandlers, LiveHandlers, ProjectHandlers, SandboxAuthServer } from "./project/Handlers.ts"
import { projectLayer } from "./project/Layer.ts"
import { InternalRpcPath, LivePath } from "./project/ProjectRpcs.ts"
import { Scheduler } from "./project/Scheduler.ts"
import { Database } from "./Resources.ts"

/** Keeps the object alive while an RPC on the socket is in flight (as alchemy's RpcDurableObject does). */
class RequestLifetime extends RpcMiddleware.Service<RequestLifetime>()("@dream/api/ProjectDO/RequestLifetime") {}

export default class ProjectDO extends Cloudflare.DurableObject<ProjectDO>()(
  "ProjectDO",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState
    const db = yield* Cloudflare.D1.QueryDatabase(Database)
    const self = yield* Cloudflare.DurableObject

    return Effect.gen(function* () {
      const d1 = yield* db.raw
      const runtime = yield* RuntimeContext
      const fetchProject: ProjectFetch = (projectId: ProjectId, request: HttpClientRequest.HttpClientRequest) =>
        (
          self.getByName(projectId).fetch as unknown as ProjectFetch extends (id: any, r: infer R) => infer O
            ? (r: R) => O
            : never
        )(request)

      const services = projectLayer(state.raw.storage as unknown as DurableObjectStorage).pipe(
        Layer.provideMerge(platformLayer({ d1: d1 as any, fetchProject }))
      )
      const handlers = Layer.mergeAll(ProjectHandlers, AgentHandlers, SandboxAuthServer, LiveHandlers).pipe(
        Layer.provideMerge(services)
      )

      // The services outlive this constructor; they are built once per activation.
      const instanceScope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(handlers, instanceScope)
      const provided = Layer.succeedContext(context)

      const lifetime = Layer.succeed(RequestLifetime, (effect) =>
        Effect.withFiber((fiber) =>
          state
            .waitUntil(Fiber.await(fiber))
            .pipe(Effect.provideService(RuntimeContext, runtime), Effect.andThen(effect))
        )
      )
      const transport = yield* RpcWebSocket.make.pipe(Effect.provide(SocketRpcSerialization))
      yield* Layer.buildWithScope(
        RpcServer.layer(ProjectLiveRpcs.middleware(RequestLifetime)).pipe(
          Layer.provide(Layer.mergeAll(provided, lifetime, Layer.succeed(RpcServer.Protocol, transport.protocol)))
        ),
        instanceScope
      )

      const internal = Effect.gen(function* () {
        const handler = yield* RpcServer.toHttpEffect(DoRpcs).pipe(
          Effect.provide(Layer.mergeAll(provided, HttpRpcSerialization))
        )
        return yield* handler
      })

      const scheduler = Context.get(context, Scheduler)

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest
          // The stub's fetch can add a trailing slash (`/internal/rpc/`).
          const path = new URL(request.url, "https://project").pathname.replace(/\/+$/, "")
          if (path === LivePath) return yield* transport.fetch
          if (path === InternalRpcPath && request.method === "POST") return yield* internal
          return HttpServerResponse.text("Not found", { status: 404 })
        }),
        alarm: () => scheduler.run.pipe(Effect.catchCause((cause) => Effect.logError("alarm failed", cause))),
        webSocketMessage: transport.webSocketMessage,
        webSocketClose: (socket: Cloudflare.WebSocket) => transport.webSocketClose(socket),
        webSocketError: (socket: Cloudflare.WebSocket, error: unknown) => transport.webSocketError(socket, error)
      }
    })
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding))
) {}
