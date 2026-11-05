/**
 * Operator secrets Dream generates for itself and keeps in two places, equal: a Worker secret on dream-api, which
 * the API checks, and the `settings` table of a small D1 database, `dream-ops`, so any thread with the workspace's
 * Cloudflare connection can read it without it ever landing in git (DEV_LOGIN_SECRET, UPDATES_PUBLISH_SECRET).
 * Values are never printed.
 */
import { Console, Effect, Schema } from "effect"
import { cloudflare } from "./cloudflare.ts"

export const OpsDatabase = "dream-ops"
const Script = "dream-api"

const QueryResult = Schema.Array(Schema.Struct({ results: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }))

export const query = (database: string, sql: string, params: ReadonlyArray<string> = []) =>
  cloudflare("POST", `/d1/database/${database}/query`, QueryResult, { sql, params }).pipe(
    Effect.map((results) => results[0]?.results ?? [])
  )

export const opsDatabase = Effect.gen(function* () {
  const databases = yield* cloudflare(
    "GET",
    "/d1/database",
    Schema.Array(Schema.Struct({ uuid: Schema.String, name: Schema.String }))
  )
  const existing = databases.find((db) => db.name === OpsDatabase)
  if (existing !== undefined) return existing.uuid
  const created = yield* cloudflare("POST", "/d1/database", Schema.Struct({ uuid: Schema.String }), {
    name: OpsDatabase
  })
  yield* query(created.uuid, "CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)")
  return created.uuid
})

const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")

/** The stored value of an operator secret, if it was generated. */
export const readOpsSecret = (name: string) =>
  Effect.gen(function* () {
    const database = yield* opsDatabase
    const rows = yield* query(database, "SELECT value FROM settings WHERE name = ?", [name])
    const value = rows[0]?.value
    return typeof value === "string" ? value : undefined
  })

/** Generates the secret once (idempotent) and sets it on the Worker, with the value in dream-ops. */
export const ensureOpsSecret = (name: string) =>
  Effect.gen(function* () {
    const database = yield* opsDatabase
    let value = yield* readOpsSecret(name)
    if (value === undefined) {
      value = randomHex()
      yield* query(database, "INSERT INTO settings (name, value) VALUES (?, ?)", [name, value])
      yield* Console.log(`${name}: generated and stored in D1 ${OpsDatabase}.settings`)
    }
    yield* cloudflare("PUT", `/workers/scripts/${Script}/secrets`, Schema.Unknown, {
      name,
      text: value,
      type: "secret_text"
    })
    yield* Console.log(`${name}: set on the ${Script} Worker (same value as ${OpsDatabase})`)
  })
