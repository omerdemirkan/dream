/**
 * The Worker: phone RPC (`Routes.app`), sandbox RPC (`Routes.sandbox`), the
 * live WebSocket hand-off to ProjectDO, media, OAuth callbacks, and the
 * gateway that maps `<slug>-<rand>.<domain>` to a project's sandbox port.
 *
 * It serves `api.<domain>` as a custom domain and `*.<domain>/*` as a zone
 * route, so requests are dispatched by host. Skeleton only.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import ProjectDO from "./ProjectDO.ts"
import { Database, Media } from "./Resources.ts"

/** The apex domain Dream runs on, e.g. "dream.example". */
export const DreamDomain = Config.NonEmptyString("DREAM_DOMAIN")

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Effect.gen(function* () {
    const domain = yield* DreamDomain
    return {
      main: import.meta.url,
      domain: `api.${domain}`,
      routes: [{ pattern: `*.${domain}/*`, zoneName: domain }],
      workersDev: false
    }
  }),
  Effect.gen(function* () {
    const domain = yield* DreamDomain
    // Yielding a resource here binds it to the Worker and returns its runtime
    // client; keep the results once handlers need them.
    yield* ProjectDO
    yield* Cloudflare.D1.QueryDatabase(Database)
    yield* Cloudflare.R2.ReadWriteBucket(Media)

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const host = request.headers["host"] ?? url.host
        if (host === `api.${domain}` && url.pathname === "/health") {
          return HttpServerResponse.text("ok")
        }
        return HttpServerResponse.text("Not implemented", { status: 501 })
      })
    }
  }).pipe(Effect.provide([Cloudflare.D1.QueryDatabaseBinding, Cloudflare.R2.ReadWriteBucketBinding]))
) {}
