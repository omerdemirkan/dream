/**
 * Adds people to the invite list (D1 `invites`), so they can sign in with Google.
 *
 *   node infra/scripts/invite.ts someone@example.com [another@example.com …]
 */
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Schema } from "effect"
import { cloudflare } from "./cloudflare.ts"

const DatabaseName = /^dream-.*database/i

const program = Effect.gen(function* () {
  const emails = process.argv
    .slice(2)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes("@"))
  if (emails.length === 0) return yield* Console.error("Usage: node infra/scripts/invite.ts <email> [email …]")
  const databases = yield* cloudflare(
    "GET",
    "/d1/database",
    Schema.Array(Schema.Struct({ uuid: Schema.String, name: Schema.String }))
  )
  const database = databases.find((db) => DatabaseName.test(db.name))
  if (database === undefined)
    return yield* Console.error(`No Dream D1 database found among: ${databases.map((d) => d.name).join(", ")}`)
  for (const email of emails) {
    yield* cloudflare("POST", `/d1/database/${database.uuid}/query`, Schema.Unknown, {
      sql: "INSERT INTO invites (email, created_at) VALUES (?, ?) ON CONFLICT (email) DO NOTHING",
      params: [email, new Date().toISOString()]
    })
    yield* Console.log(`invited ${email}`)
  }
})

program.pipe(NodeRuntime.runMain)
