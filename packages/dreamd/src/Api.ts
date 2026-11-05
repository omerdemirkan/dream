/**
 * What dreamd itself tells the API: when turns start and finish, and where the
 * subscription stands. These go to `Routes.sandbox` with the project token.
 * Reports are best effort: a few retries, then a log line. Losing one only
 * costs a stale "working" badge or usage bar until the next.
 */
import { type EventId, HttpRpcSerialization, Routes, SandboxAuth, SandboxRpcs, type UsageSnapshot } from "@dream/domain"
import { Context, Effect, Layer, Redacted, Ref, Schedule } from "effect"
import { FetchHttpClient, Headers } from "effect/http"
import { RpcClient, RpcMiddleware } from "effect/rpc"
import { DreamdConfig } from "./Config.ts"

export type Report =
  | { readonly _tag: "Turn"; readonly state: "started" | "finished"; readonly eventIds: ReadonlyArray<EventId> }
  | { readonly _tag: "Usage"; readonly usage: UsageSnapshot }

/** An RPC client for `SandboxRpcs` on the Worker, authenticated with the project token. */
export const layerClient = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DreamdConfig
    const bearer = `Bearer ${Redacted.value(config.projectToken)}`
    return Layer.mergeAll(
      RpcClient.layerProtocolHttp({ url: `${config.apiUrl}${Routes.sandbox}` }).pipe(
        Layer.provide([FetchHttpClient.layer, HttpRpcSerialization])
      ),
      RpcMiddleware.layerClient(SandboxAuth, ({ request, next }) =>
        next({ ...request, headers: Headers.set(request.headers, "authorization", bearer) })
      )
    )
  })
)

export class Api extends Context.Service<
  Api,
  {
    readonly reportTurn: (state: "started" | "finished", eventIds: ReadonlyArray<EventId>) => Effect.Effect<void>
    readonly reportUsage: (usage: UsageSnapshot) => Effect.Effect<void>
  }
>()("@dream/dreamd/Api") {
  static readonly layer = Layer.effect(
    Api,
    Effect.gen(function* () {
      const client = yield* RpcClient.make(SandboxRpcs)
      const report = <E>(what: string, effect: Effect.Effect<void, E>) =>
        effect.pipe(
          Effect.retry({ schedule: Schedule.exponential("1 second"), times: 4 }),
          Effect.catchCause((cause) => Effect.logWarning(`Couldn't report ${what}`, cause))
        )
      return Api.of({
        reportTurn: (state, eventIds) => report(`turn ${state}`, client.ReportTurn({ state, eventIds })),
        reportUsage: (usage) => report("usage", client.ReportUsage({ usage }))
      })
    })
  ).pipe(Layer.provide(layerClient))

  /** Records reports instead of sending them. */
  static readonly layerTest = (reports: Ref.Ref<ReadonlyArray<Report>>) =>
    Layer.succeed(
      Api,
      Api.of({
        reportTurn: (state, eventIds) =>
          Ref.update(reports, (all): ReadonlyArray<Report> => [...all, { _tag: "Turn", state, eventIds }]),
        reportUsage: (usage) => Ref.update(reports, (all): ReadonlyArray<Report> => [...all, { _tag: "Usage", usage }])
      })
    )
}
