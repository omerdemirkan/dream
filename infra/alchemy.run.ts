/**
 * The whole Cloudflare footprint, as one alchemy v2 Stack.
 *
 * Run from the workspace root (paths in resource props are root-relative):
 *   bun run infra:plan
 *   bun run infra:deploy                 # stage "prod"; then: node infra/scripts/ensure-secrets.ts
 *
 * Environment (root .env):
 *   DREAM_DOMAIN       apex domain whose zone is already in the Cloudflare account, e.g. "omer.build"
 *   DREAM_API_HOST     the API hostname (default dream.<domain>)
 *   DREAM_R2_ENABLED   "true" once R2 is enabled on the account (media storage)
 *   DREAM_EMAIL_ENABLED "true" once the account can send email (Workers Paid; the token needs Email Sending: Edit)
 *   DREAM_OPERATORS    comma-separated emails of the people who see everyone's costs in the app (docs/metering.md)
 *   ALCHEMY_STATE      "cloudflare" to keep state in the account's alchemy state store (its API token needs
 *                      Secrets Store access); otherwise state is local in .alchemy/ and a fresh machine
 *                      re-imports the deployed resources with `--adopt`.
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN   unless an alchemy profile is configured
 *
 * - `<api host>`     custom domain on the Worker (DNS record + cert managed by Cloudflare)
 * - `*.<domain>/*`   zone route to the same Worker: the gateway for published apps
 * - `*.<domain>`     proxied placeholder DNS record so the wildcard route receives traffic
 * - `mail.<domain>`  Email Service sending subdomain (DKIM, SPF, bounces), when DREAM_EMAIL_ENABLED
 * The Worker binds ProjectDO, D1 and (when enabled) R2 itself (apps/api/src/Api.ts).
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Api, EmailEnabled, mailDomain } from "@dream/api"
import * as Alchemy from "alchemy"
import { adopt } from "alchemy/AdoptPolicy"
import { localState } from "alchemy/State"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

const state = process.env.ALCHEMY_STATE === "cloudflare" ? Cloudflare.state() : localState()

export default Alchemy.Stack(
  "Dream",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const domain = yield* Config.NonEmptyString("DREAM_DOMAIN")
    const api = yield* Api

    // `alchemy dev` runs the Worker locally; only the deployed stage touches the real zone.
    if (process.env.ALCHEMY_DEV === "true") return { api: api.url.as<string>() }

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

    // What Dream emails from (`EmailAccessLink`). Cloudflare writes its DNS records; no copies of sent mail are
    // kept in the activity log, since each holds a live link.
    if (yield* EmailEnabled) {
      yield* Cloudflare.Email.SendingSubdomain("Mail", {
        zoneId: zone.zoneId,
        name: mailDomain(domain),
        previewEnabled: false
      })
    }

    return { api: api.url.as<string>(), zoneId: zone.zoneId }
  })
)
