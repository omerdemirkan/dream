/**
 * Calling a RelayDO from its ProjectDO: an RpcClient for `RelayRpcs` over the RelayDO's `fetch`, one object per relay
 * id. Transport failures are defects, as with `ProjectClients`.
 */
import { HttpRpcSerialization, type RelayId } from "@dream/domain"
import { Context, Effect, Layer } from "effect"
import { HttpClient, type HttpClientError, type HttpClientRequest, type HttpClientResponse } from "effect/http"
import { RpcClient, type RpcClientError } from "effect/rpc"
import { RelayRpcPath, RelayRpcs } from "./RelayRpcs.ts"

export type RelayClient = RpcClient.FromGroup<typeof RelayRpcs, RpcClientError.RpcClientError>

/** `fetch` into the RelayDO named by a relay id. */
export type RelayFetch = (
  relayId: RelayId,
  request: HttpClientRequest.HttpClientRequest
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>

export class RelayClients extends Context.Service<
  RelayClients,
  {
    readonly use: <A, E>(
      relayId: RelayId,
      use: (client: RelayClient) => Effect.Effect<A, E | RpcClientError.RpcClientError>
    ) => Effect.Effect<A, Exclude<E, RpcClientError.RpcClientError>>
  }
>()("@dream/api/relay/RelayClients") {
  static readonly layer = (fetch: RelayFetch) =>
    Layer.succeed(
      RelayClients,
      RelayClients.of({
        use: (relayId, use) => {
          const http = HttpClient.make((request) => fetch(relayId, request))
          const protocol = RpcClient.layerProtocolHttp({ url: `https://relay${RelayRpcPath}` }).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
            Layer.provide(HttpRpcSerialization)
          )
          return RpcClient.make(RelayRpcs).pipe(
            Effect.flatMap(use),
            Effect.catchTag("RpcClientError" as any, (error: unknown) => Effect.die(error)),
            Effect.provide(protocol),
            Effect.scoped
          ) as any
        }
      })
    )
}

/** For code that never calls a relay (the Worker reaches them only through their ProjectDO). */
export const noRelays: RelayFetch = (relayId) =>
  Effect.die(new Error(`Relays are reached through their ProjectDO, not from here (${relayId}).`))
