/**
 * The whole Cloudflare footprint, as one alchemy v2 Stack. Not deployed yet.
 *
 * Run from the workspace root (paths in resource props are root-relative):
 *   bun run infra:plan      # needs Cloudflare credentials (alchemy profile or CLOUDFLARE_API_TOKEN)
 *
 * Environment (root .env):
 *   DREAM_DOMAIN   apex domain whose zone is already in the Cloudflare account, e.g. "dream.example"
 *
 * - `api.<domain>`  custom domain on the Worker (DNS record + cert managed by Cloudflare)
 * - `*.<domain>/*`  zone route to the same Worker: the gateway for published apps
 * - `*.<domain>`    proxied placeholder DNS record so the wildcard route receives traffic
 * The Worker binds ProjectDO, D1 and R2 itself (apps/api/src/Api.ts), so
 * yielding it deploys them.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Api } from "@dream/api"
import * as Alchemy from "alchemy"
import { adopt } from "alchemy/AdoptPolicy"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

export default Alchemy.Stack(
  "Dream",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const domain = yield* Config.NonEmptyString("DREAM_DOMAIN")

    // The zone exists already (the domain is registered or delegated to Cloudflare); adopt it, never delete it.
    const zone = yield* Cloudflare.Zone.Zone("Zone", { name: domain }).pipe(adopt(true))

    // Wildcard routes only fire on proxied hostnames; `100::` is the conventional placeholder origin.
    yield* Cloudflare.DNS.Record("GatewayWildcard", {
      zoneId: zone.zoneId,
      name: `*.${domain}`,
      type: "AAAA",
      content: "100::",
      proxied: true
    })

    const api = yield* Api

    return { api: api.url.as<string>(), zoneId: zone.zoneId }
  })
)
