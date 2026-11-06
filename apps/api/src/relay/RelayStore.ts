/**
 * A RelayDO's own SQLite: the relay it holds, how it's doing (with what a Discord session needs to resume after the
 * object restarts), and the events waiting for the app, oldest first.
 */
import { RelayProblem, RelayState } from "@dream/domain"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Migrator from "effect/sql/Migrator"
import { decodeFirst, decodeRows, encodeJson, exec, jsonCodec } from "../db/Sql.ts"
import { RelayConfig } from "./RelayRpcs.ts"

/** What resuming a Discord Gateway session takes, kept across restarts of the object. */
export const DiscordSession = Schema.Struct({
  sessionId: Schema.String,
  resumeUrl: Schema.String,
  /** The last dispatch's sequence number. */
  seq: Schema.Int,
  botUserId: Schema.optionalKey(Schema.String)
})
export type DiscordSession = typeof DiscordSession.Type

export const RelayRuntime = Schema.Struct({
  state: RelayState,
  since: Schema.optionalKey(Schema.DateTimeUtc),
  account: Schema.optionalKey(Schema.String),
  delivered: Schema.Int,
  dropped: Schema.Int,
  lastEventAt: Schema.optionalKey(Schema.DateTimeUtc),
  lastDeliveredAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** Newest first, at most `ProblemsKept`. */
  problems: Schema.Array(RelayProblem),
  discord: Schema.optionalKey(DiscordSession),
  /** Deliveries have failed without a break since then. */
  deliveryFailingSince: Schema.optionalKey(Schema.DateTimeUtc),
  /** The agent heard that deliveries are failing; not again until one goes through. */
  deliveryAlerted: Schema.optionalKey(Schema.Boolean),
  /** When the ProjectDO last said this relay is still its to hold. */
  checkedAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type RelayRuntime = typeof RelayRuntime.Type

export const ProblemsKept = 5

export const initialRuntime: RelayRuntime = { state: "connecting", delivered: 0, dropped: 0, problems: [] }

export interface Queued {
  readonly id: string
  readonly atMs: number
  readonly body: string
}

export const migrations = Migrator.fromRecord({
  "0001_init": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE config (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`
    yield* sql`CREATE TABLE runtime (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`
    yield* sql`CREATE TABLE queue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      at_ms INTEGER NOT NULL,
      body TEXT NOT NULL
    )`
  })
})

export const migrate = Migrator.make({})({ loader: migrations }).pipe(Effect.orDie)

const JsonRow = Schema.Struct({ json: Schema.String })
const QueueRow = Schema.Struct({ id: Schema.String, at_ms: Schema.Number, body: Schema.String })
const CountRow = Schema.Struct({ n: Schema.Number })

export class RelayStore extends Context.Service<
  RelayStore,
  {
    readonly config: Effect.Effect<Option.Option<RelayConfig>>
    readonly saveConfig: (config: RelayConfig) => Effect.Effect<void>
    readonly runtime: Effect.Effect<RelayRuntime>
    readonly updateRuntime: (f: (runtime: RelayRuntime) => RelayRuntime) => Effect.Effect<RelayRuntime>
    /** Adds an event unless one with its id is already waiting; whether it was added. */
    readonly enqueue: (event: Queued) => Effect.Effect<boolean>
    readonly oldest: (limit: number) => Effect.Effect<ReadonlyArray<Queued>>
    readonly remove: (ids: ReadonlyArray<string>) => Effect.Effect<void>
    readonly waiting: Effect.Effect<number>
    /** Drops the oldest until at most `keep` wait; how many went. */
    readonly trim: (keep: number) => Effect.Effect<number>
    /** Drops events received before `beforeMs`; how many went. */
    readonly expire: (beforeMs: number) => Effect.Effect<number>
    /** Forgets everything: the relay, its state, and what's waiting. */
    readonly wipe: Effect.Effect<void>
  }
>()("@dream/api/relay/RelayStore") {
  static readonly layer = Layer.effect(
    RelayStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const singleton = <S extends Schema.Top>(table: string, schema: S) => ({
        get: sql.unsafe(`SELECT json FROM ${table} WHERE id = 1`).pipe(
          decodeFirst(JsonRow),
          Effect.map((row) =>
            row === undefined
              ? Option.none<S["Type"]>()
              : Option.some(Schema.decodeUnknownSync(jsonCodec(schema))(row.json))
          )
        ),
        put: (value: S["Type"]) =>
          exec(
            sql.unsafe(
              `INSERT INTO ${table} (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json`,
              [encodeJson(schema, value)]
            )
          )
      })
      const config = singleton("config", RelayConfig)
      const runtime = singleton("runtime", RelayRuntime)
      const currentRuntime = Effect.map(
        runtime.get,
        Option.getOrElse(() => initialRuntime)
      )

      const count = (rows: Effect.Effect<ReadonlyArray<unknown>, any>) =>
        rows.pipe(
          decodeFirst(CountRow),
          Effect.map((row) => row?.n ?? 0)
        )

      return RelayStore.of({
        config: config.get,
        saveConfig: config.put,
        runtime: currentRuntime,
        updateRuntime: (f) =>
          Effect.gen(function* () {
            const next = f(yield* currentRuntime)
            yield* runtime.put(next)
            return next
          }),
        enqueue: (event) =>
          Effect.gen(function* () {
            const before = yield* count(sql`SELECT COUNT(*) AS n FROM queue WHERE id = ${event.id}`)
            if (before > 0) return false
            yield* exec(sql`INSERT INTO queue (id, at_ms, body) VALUES (${event.id}, ${event.atMs}, ${event.body})`)
            return true
          }),
        oldest: (limit) =>
          sql`SELECT id, at_ms, body FROM queue ORDER BY seq LIMIT ${limit}`.pipe(
            decodeRows(QueueRow),
            Effect.map((rows) => rows.map((row) => ({ id: row.id, atMs: row.at_ms, body: row.body })))
          ),
        remove: (ids) => (ids.length === 0 ? Effect.void : exec(sql`DELETE FROM queue WHERE ${sql.in("id", ids)}`)),
        waiting: count(sql`SELECT COUNT(*) AS n FROM queue`),
        trim: (keep) =>
          Effect.gen(function* () {
            const total = yield* count(sql`SELECT COUNT(*) AS n FROM queue`)
            const excess = total - keep
            if (excess <= 0) return 0
            yield* exec(sql`DELETE FROM queue WHERE seq IN (SELECT seq FROM queue ORDER BY seq LIMIT ${excess})`)
            return excess
          }),
        expire: (beforeMs) =>
          Effect.gen(function* () {
            const old = yield* count(sql`SELECT COUNT(*) AS n FROM queue WHERE at_ms < ${beforeMs}`)
            if (old > 0) yield* exec(sql`DELETE FROM queue WHERE at_ms < ${beforeMs}`)
            return old
          }),
        wipe: Effect.gen(function* () {
          yield* exec(sql`DELETE FROM queue`)
          yield* exec(sql`DELETE FROM runtime`)
          yield* exec(sql`DELETE FROM config`)
        })
      })
    })
  )
}
