/**
 * The phone → API RPC client (`AppRpcs`, HTTP + NDJSON at `Routes.app`).
 *
 * Authenticated calls carry the session token from `Session`. When the API
 * says the token is no longer good, the app signs out so the person lands on
 * the sign-in screen instead of a broken Home.
 */
import { AppAuth, AppRpcs, HttpRpcSerialization, Routes } from "@dream/domain"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, Headers } from "effect/http"
import { RpcClient, RpcMiddleware } from "effect/rpc"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import { AppConfig } from "./AppConfig.ts"
import { Session } from "./Session.ts"

export type AppRpcClient = RpcClient.FromGroup<typeof AppRpcs, RpcClientError>

export class AppClient extends Context.Service<AppClient, AppRpcClient>()("@dream/mobile/AppClient") {
  /**
   * Over HTTP to the real API. Expects `FetchHttpClient.Fetch` to be a fetch that
   * can stream response bodies (`expo/fetch` on the phone).
   */
  static readonly layerHttp = Layer.unwrap(
    Effect.gen(function* () {
      const { apiUrl } = yield* AppConfig
      return Layer.effect(AppClient, RpcClient.make(AppRpcs)).pipe(
        Layer.provide(RpcClient.layerProtocolHttp({ url: `${apiUrl}${Routes.app}` })),
        Layer.provide(Layer.mergeAll(FetchHttpClient.layer, HttpRpcSerialization)),
        Layer.provide(AppAuthClient)
      )
    })
  )
}

/** Attaches `authorization: Bearer <session token>`, and signs out on `Unauthorized`. */
export const AppAuthClient = RpcMiddleware.layerClient(
  AppAuth,
  Effect.gen(function* () {
    const session = yield* Session
    return ({ request, next }) =>
      Effect.gen(function* () {
        const token = yield* session.token
        const headers = Option.match(token, {
          onNone: () => request.headers,
          onSome: (token) => Headers.set(request.headers, "authorization", `Bearer ${Redacted.value(token)}`)
        })
        return yield* next({ ...request, headers }).pipe(
          Effect.tapError((error) =>
            typeof error === "object" && error !== null && "_tag" in error && error._tag === "Unauthorized"
              ? session.signOut
              : Effect.void
          )
        )
      })
  })
)
