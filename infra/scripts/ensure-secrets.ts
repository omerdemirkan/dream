/**
 * Creates the Worker secrets Dream generates for itself, once: the master key
 * for the `secrets` table and the token signing key. Existing values are
 * never replaced (a new encryption key would make every stored credential
 * unreadable). Values are never printed.
 *
 *   node infra/scripts/ensure-secrets.ts      # after the first deploy
 */
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Schema } from "effect"
import { cloudflare } from "./cloudflare.ts"

const script = "dream-api"
const generated = ["DREAM_ENCRYPTION_KEY", "DREAM_SIGNING_KEY"] as const

const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")

const program = Effect.gen(function* () {
  const existing = yield* cloudflare(
    "GET",
    `/workers/scripts/${script}/secrets`,
    Schema.Array(Schema.Struct({ name: Schema.String }))
  )
  const names = new Set(existing.map((secret) => secret.name))
  for (const name of generated) {
    if (names.has(name)) {
      yield* Console.log(`${name}: already set, left alone`)
      continue
    }
    yield* cloudflare("PUT", `/workers/scripts/${script}/secrets`, Schema.Unknown, {
      name,
      text: randomHex(),
      type: "secret_text"
    })
    yield* Console.log(`${name}: generated`)
  }
  const missing = [
    "E2B_API_KEY",
    "GOOGLE_IOS_CLIENT_ID",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "APNS_KEY_ID",
    "APNS_TEAM_ID",
    "APNS_BUNDLE_ID",
    "APNS_PRIVATE_KEY",
    "BROWSERBASE_API_KEY",
    "NAMESPACE_TOKEN",
    "DEV_LOGIN_SECRET"
  ].filter((name) => !names.has(name))
  if (missing.length > 0) yield* Console.log(`Not set yet (add in the Cloudflare dashboard): ${missing.join(", ")}`)
})

program.pipe(NodeRuntime.runMain)
