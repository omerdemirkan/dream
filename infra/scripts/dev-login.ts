/**
 * DEV_LOGIN_SECRET: the shared secret behind `DevSignIn`, for development and
 * end-to-end tests before Google sign-in is configured.
 *
 * The value lives in two places, kept equal by `ensure`: the Worker secret the
 * API checks, and the `settings` table of a small D1 database, `dream-ops`,
 * so any thread with the workspace's Cloudflare connection can read it without
 * it ever landing in git. Reading it:
 *
 *   node infra/scripts/dev-login.ts ensure            # create it once (idempotent)
 *   node infra/scripts/dev-login.ts session <email>   # sign in on the deployed API; prints a session token
 *
 * or directly: POST /accounts/<account>/d1/database/<dream-ops id>/query
 *   {"sql":"SELECT value FROM settings WHERE name = 'DEV_LOGIN_SECRET'"}
 */
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Schema } from "effect"
import { cloudflare } from "./cloudflare.ts"

const OpsDatabase = "dream-ops"
const Script = "dream-api"
const ApiUrl = process.env.DREAM_API_URL ?? `https://dream.${process.env.DREAM_DOMAIN ?? "omer.build"}`

const QueryResult = Schema.Array(Schema.Struct({ results: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }))

const opsDatabase = Effect.gen(function* () {
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

const query = (database: string, sql: string, params: ReadonlyArray<string> = []) =>
  cloudflare("POST", `/d1/database/${database}/query`, QueryResult, { sql, params }).pipe(
    Effect.map((results) => results[0]?.results ?? [])
  )

const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("")

export const readSecret = Effect.gen(function* () {
  const database = yield* opsDatabase
  const rows = yield* query(database, "SELECT value FROM settings WHERE name = ?", ["DEV_LOGIN_SECRET"])
  const value = rows[0]?.value
  return typeof value === "string" ? value : undefined
})

const ensure = Effect.gen(function* () {
  const database = yield* opsDatabase
  let value = yield* readSecret
  if (value === undefined) {
    value = randomHex()
    yield* query(database, "INSERT INTO settings (name, value) VALUES (?, ?)", ["DEV_LOGIN_SECRET", value])
    yield* Console.log(`DEV_LOGIN_SECRET: generated and stored in D1 ${OpsDatabase}.settings`)
  }
  yield* cloudflare("PUT", `/workers/scripts/${Script}/secrets`, Schema.Unknown, {
    name: "DEV_LOGIN_SECRET",
    text: value,
    type: "secret_text"
  })
  yield* Console.log(`DEV_LOGIN_SECRET: set on the ${Script} Worker (same value as ${OpsDatabase})`)
})

const session = (email: string) =>
  Effect.gen(function* () {
    const secret = yield* readSecret
    if (secret === undefined) return yield* Console.error("No DEV_LOGIN_SECRET yet; run `ensure` first.")
    // One RPC request as NDJSON, the way an RpcClient sends it.
    const body = `${JSON.stringify({ _tag: "Request", id: "1", tag: "DevSignIn", payload: { email, secret }, headers: [] })}\n`
    const response = yield* Effect.promise(() =>
      fetch(`${ApiUrl}/rpc`, { method: "POST", headers: { "content-type": "application/ndjson" }, body }).then((r) =>
        r.text()
      )
    )
    const exit = response
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
      .find((message) => message._tag === "Exit")
    if (exit?.exit?._tag !== "Success") return yield* Console.error(`Sign-in failed: ${response}`)
    yield* Console.log(exit.exit.value.sessionToken)
  })

const [command, arg] = process.argv.slice(2)
const program =
  command === "ensure"
    ? ensure
    : command === "session" && arg !== undefined
      ? session(arg)
      : Console.error("Usage: node infra/scripts/dev-login.ts ensure | session <email>")

program.pipe(NodeRuntime.runMain)
