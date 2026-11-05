/**
 * Sets one Worker secret on dream-api from stdin, so the value never lands in
 * shell history or on screen, and survives deploys (alchemy leaves secrets it
 * didn't create alone). Used for operator credentials such as the OAuth
 * providers' client ids and secrets (docs/setup/oauth-providers.md).
 *
 *   pbpaste | node infra/scripts/set-secret.ts OAUTH_SPOTIFY_CLIENT_SECRET
 *
 * The new value takes effect on the next request; nothing needs redeploying.
 */
import { text } from "node:stream/consumers"
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Schema } from "effect"
import { cloudflare } from "./cloudflare.ts"

const script = "dream-api"

const program = Effect.gen(function* () {
  const name = process.argv[2]
  if (name === undefined || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
    return yield* Effect.fail(new Error("Usage: <value on stdin> | node infra/scripts/set-secret.ts SECRET_NAME"))
  }
  if (process.stdin.isTTY) yield* Console.log(`Paste the value for ${name}, then press Ctrl-D:`)
  const value = (yield* Effect.promise(() => text(process.stdin))).trim()
  if (value.length === 0) return yield* Effect.fail(new Error(`No value for ${name} on stdin; nothing was set.`))
  yield* cloudflare("PUT", `/workers/scripts/${script}/secrets`, Schema.Unknown, {
    name,
    text: value,
    type: "secret_text"
  })
  yield* Console.log(`${name}: set (${value.length} characters)`)
})

program.pipe(NodeRuntime.runMain)
