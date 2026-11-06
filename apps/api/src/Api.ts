/**
 * The Worker: phone RPC (`Routes.app`), sandbox RPC (`Routes.sandbox`), the
 * live WebSocket hand-off to ProjectDO, media, OAuth callbacks, Codex's token
 * refresh, and the gateway that maps `<slug>-<rand>.<domain>` to a project's
 * sandbox port. It serves the API host as a custom domain and `*.<domain>/*`
 * as a zone route, and dispatches by host. A cron refreshes expiring
 * credentials and cleans up abandoned sign-ins.
 *
 * Config read here (init) is bound by alchemy at deploy from the deploying
 * shell's environment. Operator secrets are not: they're Cloudflare dashboard
 * secrets, read when a request runs (see Config.ts).
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import type { D1Database, R2Bucket } from "@cloudflare/workers-types"
import type { ProjectId } from "@dream/domain"
import { Config, Effect, Option } from "effect"
import type { HttpClientRequest } from "effect/http"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { route } from "./http/Router.ts"
import type { ProjectFetch } from "./project/Client.ts"
import ProjectDO from "./ProjectDO.ts"
import RelayDO from "./RelayDO.ts"
import { maintenance, type WorkerBindings, workerLayer } from "./WorkerLayer.ts"
import { Database, Media, Updates } from "./Resources.ts"

/** The apex domain Dream runs on, e.g. "omer.build". */
export const DreamDomain = Config.NonEmptyString("DREAM_DOMAIN")

/** The API's hostname; defaults to `dream.<domain>`. */
export const ApiHost = Config.option(Config.NonEmptyString("DREAM_API_HOST"))

/** The Worker's script name, fixed so secrets set outside alchemy stay attached to it. */
export const WorkerName = "dream-api"

/** Set once R2 is enabled on the account; until then the Worker runs without media storage. */
export const R2Enabled = Config.Boolean("DREAM_R2_ENABLED").pipe(Config.withDefault(false))

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Effect.gen(function* () {
    const domain = yield* DreamDomain
    const apiHost = Option.getOrElse(yield* ApiHost, () => `dream.${domain}`)
    // DREAM_ENCRYPTION_KEY and DREAM_SIGNING_KEY are Worker secrets generated once by
    // infra/scripts/ensure-secrets.ts, outside alchemy's state, and never rotated by a deploy.
    return {
      main: import.meta.url,
      name: WorkerName,
      domain: apiHost,
      routes: [{ pattern: `*.${domain}/*`, zoneName: domain }],
      workersDev: false,
      env: { DREAM_API_HOST: apiHost }
    }
  }),
  Effect.gen(function* () {
    yield* DreamDomain
    const projects = yield* ProjectDO
    // Bound so the Worker exports the class; ProjectDOs reach relays through the env, and the Worker never does.
    yield* RelayDO
    const database = yield* Cloudflare.D1.QueryDatabase(Database)
    const r2Enabled = yield* R2Enabled
    const media = r2Enabled ? yield* Cloudflare.R2.ReadWriteBucket(Media) : undefined
    const updates = r2Enabled ? yield* Cloudflare.R2.ReadWriteBucket(Updates) : undefined

    const bindings = Effect.gen(function* () {
      const d1 = (yield* database.raw) as unknown as D1Database
      const r2 = media === undefined ? undefined : ((yield* media.raw) as unknown as R2Bucket)
      const updatesBucket = updates === undefined ? undefined : ((yield* updates.raw) as unknown as R2Bucket)
      return {
        d1,
        r2,
        updates: updatesBucket,
        fetchProject: (projectId: ProjectId, request: HttpClientRequest.HttpClientRequest) =>
          (
            projects.getByName(projectId).fetch as unknown as (
              r: HttpClientRequest.HttpClientRequest
            ) => ReturnType<ProjectFetch>
          )(request),
        forwardLive: (projectId: ProjectId, request: Request) =>
          projects
            .getByName(projectId)
            .fetch(HttpServerRequest.fromWeb(request))
            .pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.text("Unavailable", { status: 503 }))))
      } satisfies WorkerBindings
    })

    yield* Cloudflare.Workers.cron("*/5 * * * *", () =>
      Effect.flatMap(bindings, (b) => maintenance.pipe(Effect.provide(workerLayer(b)))).pipe(
        Effect.catchCause((cause) => Effect.logError("maintenance failed", cause))
      )
    )

    return {
      fetch: Effect.gen(function* () {
        const raw = yield* Cloudflare.Request
        const b = yield* bindings
        return yield* route(raw).pipe(Effect.provide(workerLayer(b)))
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("request failed", cause).pipe(
            Effect.as(HttpServerResponse.text("Something went wrong", { status: 500 }))
          )
        )
      )
    }
  }).pipe(
    Effect.provide([
      Cloudflare.D1.QueryDatabaseBinding,
      Cloudflare.R2.ReadWriteBucketBinding,
      Cloudflare.Workers.CronEventSourceLive
    ])
  )
) {}
