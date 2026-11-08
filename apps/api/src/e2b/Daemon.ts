/**
 * The ProjectDO's client for dreamd: `DaemonRpcs` on the sandbox's port URL,
 * with the sandbox's traffic token (E2B's gate; the request itself resumes a
 * paused sandbox) and the per-sandbox daemon token (dreamd's own check).
 */
import {
  AgentEvent,
  DaemonAuth,
  DaemonRestarting,
  DaemonRpcs,
  DefaultDaemonPort,
  HttpRpcSerialization,
  type RelayForward,
  type RelayForwardResult,
  type RelayId,
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
    ) => Effect.Effect<ReadonlyArray<string>, UpstreamFailure | DaemonRestarting>
    /** Hands a relay's events to dreamd, which posts them to the app on `port`. Waits until the app has answered. */
    readonly forwardRelay: (
      sandbox: SandboxAccess,
      daemonToken: string,
      request: {
        readonly relayId: RelayId
        readonly port: number
        readonly path: string
        readonly deliveries: readonly [RelayForward, ...Array<RelayForward>]
      }
    ) => Effect.Effect<RelayForwardResult, UpstreamFailure | DaemonRestarting>
    /** Whether anyone is watching the project (`DaemonRpcs.SetWatching`). An older dreamd refuses it. */
    readonly setWatching: (
      sandbox: SandboxAccess,
      daemonToken: string,
      watching: boolean
    ) => Effect.Effect<void, UpstreamFailure>
    /** A usage limit they set holds the project, or no longer does (`DaemonRpcs.HoldTurns`). An older dreamd refuses it. */
    readonly holdTurns: (
      sandbox: SandboxAccess,
      daemonToken: string,
      held: boolean
    ) => Effect.Effect<void, UpstreamFailure>
    readonly health: (
      sandbox: SandboxAccess,
      daemonToken: string
    ) => Effect.Effect<
      {
        readonly version: string
        readonly turn: "idle" | "running"
        readonly queued: number
        /** The env file's hash, as that dreamd read it; absent from older builds. */
        readonly envHash?: string
        /** The template release it runs from; absent from older builds. */
        readonly release?: string
      },
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
        events: readonly [AgentEvent, ...Array<AgentEvent>],
        timeZone?: string | undefined
      ) =>
        withClient(sandbox, daemonToken, (client) =>
          client.Deliver({ events, ...(timeZone === undefined ? {} : { timeZone }) })
        ).pipe(
          Effect.map((result) => result.accepted as ReadonlyArray<string>),
          Effect.timeout("60 seconds"),
          Effect.mapError((error) => (error._tag === "DaemonRestarting" ? error : failure("Delivering events")(error)))
        )

      const forwardRelay: Context.Service.Shape<typeof Daemon>["forwardRelay"] = (sandbox, daemonToken, request) =>
        withClient(sandbox, daemonToken, (client) => client.ForwardRelay(request)).pipe(
          // dreamd gives the app two minutes per event.
          Effect.timeout("25 minutes"),
          Effect.mapError((error) =>
            error._tag === "DaemonRestarting" ? error : failure("Handing relay events to dreamd")(error)
          )
        )

      const health = (sandbox: SandboxAccess, daemonToken: string) =>
        withClient(sandbox, daemonToken, (client) => client.Health()).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(failure("Checking dreamd"))
        )

      const setWatching = (sandbox: SandboxAccess, daemonToken: string, watching: boolean) =>
        withClient(sandbox, daemonToken, (client) => client.SetWatching({ watching })).pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError(failure("Telling dreamd who's watching"))
        )

      const holdTurns = (sandbox: SandboxAccess, daemonToken: string, held: boolean) =>
        withClient(sandbox, daemonToken, (client) => client.HoldTurns({ held })).pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError(failure(held ? "Holding dreamd's turns" : "Releasing dreamd's turns"))
        )

      return Daemon.of({ deliver, forwardRelay, setWatching, holdTurns, health })
    })
  )
}
