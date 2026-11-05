/**
 * The ProjectDO's client for dreamd: `DaemonRpcs` on the sandbox's port URL,
 * with the sandbox's traffic token (E2B's gate; the request itself resumes a
 * paused sandbox) and the per-sandbox daemon token (dreamd's own check).
 */
import {
  AgentEvent,
  DaemonAuth,
  DaemonRpcs,
  DefaultDaemonPort,
  HttpRpcSerialization,
  Routes,
  UpstreamFailure
} from "@dream/domain"
import { Context, Effect, Layer } from "effect"
import { Headers, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient, type RpcClientError, RpcMiddleware } from "effect/rpc"
import type { SandboxAccess } from "./E2B.ts"

export const daemonOrigin = (sandbox: SandboxAccess, port: number = DefaultDaemonPort) =>
  `https://${port}-${sandbox.sandboxId}.${sandbox.domain}`

export class Daemon extends Context.Service<
  Daemon,
  {
    readonly deliver: (
      sandbox: SandboxAccess,
      daemonToken: string,
      events: readonly [AgentEvent, ...Array<AgentEvent>],
      timeZone?: string | undefined
    ) => Effect.Effect<ReadonlyArray<string>, UpstreamFailure>
    readonly health: (
      sandbox: SandboxAccess,
      daemonToken: string
    ) => Effect.Effect<
      { readonly version: string; readonly turn: "idle" | "running"; readonly queued: number },
      UpstreamFailure
    >
  }
>()("@dream/api/Daemon") {
  static readonly layer = Layer.effect(
    Daemon,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient

      const withClient = <A, E>(
        sandbox: SandboxAccess,
        daemonToken: string,
        use: (client: RpcClient.FromGroup<typeof DaemonRpcs, RpcClientError.RpcClientError>) => Effect.Effect<A, E>
      ) => {
        const httpClient = http.pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeader("e2b-traffic-access-token", sandbox.trafficAccessToken))
        )
        const protocol = RpcClient.layerProtocolHttp({ url: `${daemonOrigin(sandbox)}${Routes.daemon}` }).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
          Layer.provide(HttpRpcSerialization)
        )
        const auth = RpcMiddleware.layerClient(DaemonAuth, ({ request, next }) =>
          next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${daemonToken}`) })
        )
        return RpcClient.make(DaemonRpcs).pipe(
          Effect.flatMap(use),
          Effect.provide(Layer.merge(protocol, auth)),
          Effect.scoped
        )
      }

      const failure = (what: string) => (cause: unknown) =>
        new UpstreamFailure({
          service: "dreamd",
          message: `${what} failed: ${String((cause as { message?: unknown })?.message ?? cause)}`
        })

      const deliver = (
        sandbox: SandboxAccess,
        daemonToken: string,
        events: readonly [AgentEvent, ...Array<AgentEvent>]
      ) =>
        withClient(sandbox, daemonToken, (client) => client.Deliver({ events })).pipe(
          Effect.map((result) => result.accepted as ReadonlyArray<string>),
          Effect.timeout("60 seconds"),
          Effect.mapError(failure("Delivering events"))
        )

      const health = (sandbox: SandboxAccess, daemonToken: string) =>
        withClient(sandbox, daemonToken, (client) => client.Health()).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(failure("Checking dreamd"))
        )

      return Daemon.of({ deliver, health })
    })
  )
}
