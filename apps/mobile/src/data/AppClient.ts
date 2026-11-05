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
import { PhoneAppRpcs } from "./Tolerant.ts"

export type AppRpcClient = RpcClient.FromGroup<typeof AppRpcs, RpcClientError>

export class AppClient extends Context.Service<AppClient, AppRpcClient>()("@dream/mobile/AppClient") {
  /**
   * Over HTTP to the real API. Expects `FetchHttpClient.Fetch` to be a fetch that
   * can stream response bodies (`expo/fetch` on the phone). Lists decode leniently (`Tolerant.ts`).
   */
  static readonly layerHttp = Layer.unwrap(
    Effect.gen(function* () {
      const { apiUrl } = yield* AppConfig
      return Layer.effect(AppClient, RpcClient.make(PhoneAppRpcs).pipe(Effect.flatMap(signingOut))).pipe(
        Layer.provide(RpcClient.layerProtocolHttp({ url: `${apiUrl}${Routes.app}` })),
        Layer.provide(Layer.mergeAll(FetchHttpClient.layer, HttpRpcSerialization)),
        Layer.provide(AppAuthClient)
      )
    })
  )
}

/** Attaches `authorization: Bearer <session token>`. */
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
        return yield* next({ ...request, headers })
      })
  })
)

const isUnauthorized = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "Unauthorized"

/**
 * The client, signing out whenever a call fails with `Unauthorized`. This can't live in `AppAuthClient`: a
 * client middleware's `next` only sends the request, and the API's answer reaches the caller another way.
 */
export const signingOut = (client: AppRpcClient) =>
  Effect.gen(function* () {
    const session = yield* Session
    const wrapped: Record<string, unknown> = {}
    for (const [tag, call] of Object.entries(client) as ReadonlyArray<[string, unknown]>) {
      wrapped[tag] =
        typeof call === "function"
          ? (...args: Array<unknown>) => {
              const result: unknown = Reflect.apply(call, client, args)
              return Effect.isEffect(result)
                ? result.pipe(Effect.tapError((error) => (isUnauthorized(error) ? session.signOut : Effect.void)))
                : result
            }
          : call
    }
    // Same methods with the same types; only their failure path gains the sign-out.
    return wrapped as AppRpcClient
  })
