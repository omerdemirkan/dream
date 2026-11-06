/**
 * `fetch` into a Durable Object through a namespace binding from the Worker's env, for objects of a class this one
 * doesn't bind itself: the ProjectDO and the RelayDO call each other this way, since each declaring the other as a
 * binding would make the two classes' definitions depend on each other.
 */
import { Effect } from "effect"
import type { HttpClientRequest } from "effect/http"
import { HttpClientError, HttpClientResponse } from "effect/http"
import * as HttpServerRequest from "effect/http/HttpServerRequest"

export interface NamespaceLike {
  readonly getByName: (name: string) => { readonly fetch: (request: Request) => Promise<Response> }
}

export const stubFetch = (
  namespace: NamespaceLike | undefined,
  name: string,
  request: HttpClientRequest.HttpClientRequest
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> =>
  Effect.gen(function* () {
    if (namespace === undefined) return yield* Effect.die(new Error("That Durable Object namespace isn't bound."))
    const web = yield* HttpServerRequest.toWeb(HttpServerRequest.fromClientRequest(request)).pipe(Effect.orDie)
    const response = yield* Effect.tryPromise({
      try: () => namespace.getByName(name).fetch(web),
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause, description: String(cause) })
        })
    })
    return HttpClientResponse.fromWeb(request, response)
  })
