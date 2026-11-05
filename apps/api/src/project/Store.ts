/**
 * The ProjectDO's own SQLite (one database per project): chat, the Status
 * card, scheduled wakes, the sandbox, the Live Activity, sent notifications,
 * the agent's event inbox, browser sessions, the Mac, and timers for the
 * alarm. Singletons are one-row tables holding a JSON value.
 */
import {
  AgentEvent,
  EventId,
  LiveActivityAttributes,
  LiveActivityContent,
  Message,
  MessageId,
  NotificationId,
  Project,
  StatusCard,
  UsageWindowName,
  Wake,
  WakeId
} from "@dream/domain"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import * as Migrator from "effect/sql/Migrator"
import { SandboxAccess } from "../e2b/E2B.ts"
import { decodeFirst, decodeRows, encodeJson, exec, jsonCodec } from "../db/Sql.ts"

// ---------------------------------------------------------------------------
// Internal state shapes
// ---------------------------------------------------------------------------

export const SandboxRecord = Schema.Struct({
  status: Schema.Literals(["none", "creating", "ready", "failed"]),
  access: Schema.optionalKey(SandboxAccess),
  /** Bearer for DaemonRpcs, in DREAM_DAEMON_TOKEN. */
  daemonToken: Schema.optionalKey(Schema.String),
  createdAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** sha-256 of the rules last pushed, so unchanged rules aren't pushed again. */
  rulesHash: Schema.optionalKey(Schema.String),
  /** sha-256 of dreamd's env file as last written, but for the project token, so a changed setting is rewritten. */
  envHash: Schema.optionalKey(Schema.String),
  /** The rules changed while the sandbox was paused; push them when it runs. */
  rulesDirty: Schema.Boolean,
  /** The project's file keys changed since they were last written into the sandbox; write them before delivering. */
  keyFilesDirty: Schema.optionalKey(Schema.Boolean),
  working: Schema.Boolean,
  turnStartedAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** A turn has started at least once. Before then, the first turn moves the phase on from "new". */
  startedWork: Schema.optionalKey(Schema.Boolean),
  /** Consecutive delivery failures, for backoff. */
  failures: Schema.Int,
  lastError: Schema.optionalKey(Schema.String),
  /** The template build its Dream (dreamd, CLI, prompt, harnesses) came from: created from, or last refreshed to. */
  templateBuild: Schema.optionalKey(Schema.String),
  /** The release its dreamd last reported (`/opt/dream/release.json`). */
  release: Schema.optionalKey(Schema.String),
  /** The template's current build (and the release its tag names), as last looked up, and when. */
  latestBuild: Schema.optionalKey(
    Schema.Struct({ build: Schema.String, release: Schema.optionalKey(Schema.String), checkedAt: Schema.DateTimeUtc })
  ),
  /** Refreshing to `build` failed `failures` times in a row; don't try that build again before `retryAt`. */
  refreshFailure: Schema.optionalKey(
    Schema.Struct({
      build: Schema.String,
      failures: Schema.Int,
      retryAt: Schema.DateTimeUtc,
      message: Schema.String
    })
  )
})
export type SandboxRecord = typeof SandboxRecord.Type

export const emptySandbox: SandboxRecord = { status: "none", rulesDirty: false, working: false, failures: 0 }

export const LiveActivityDevice = Schema.Struct({
  deviceId: Schema.String,
  activityId: Schema.String,
  pushToken: Schema.String
})

export const LiveActivityRecord = Schema.Struct({
  attributes: LiveActivityAttributes,
  /** What the agent last set; `needsYou` is added on the way out. */
  content: LiveActivityContent,
  startedAt: Schema.DateTimeUtc,
  ended: Schema.Boolean,
  activities: Schema.Array(LiveActivityDevice)
})
export type LiveActivityRecord = typeof LiveActivityRecord.Type

export const MacRecord = Schema.Struct({
  state: Schema.Literals(["starting", "running", "stopped"]),
  instanceId: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(Schema.DateTimeUtc),
  lastUsedAt: Schema.optionalKey(Schema.DateTimeUtc),
  deadline: Schema.optionalKey(Schema.DateTimeUtc)
})
export type MacRecord = typeof MacRecord.Type

export const UsagePause = Schema.Struct({
  window: UsageWindowName,
  until: Schema.DateTimeUtc,
  /** Whether this project hit the limit itself (it then gets a UsageReset event). */
  wakeOnReset: Schema.Boolean
})
export type UsagePause = typeof UsagePause.Type

export const BrowserRecord = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type BrowserRecord = typeof BrowserRecord.Type

export const NotificationRecord = Schema.Struct({
  id: NotificationId,
  messageId: Schema.optionalKey(MessageId),
  sentAt: Schema.DateTimeUtc,
  withdrawnAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type NotificationRecord = typeof NotificationRecord.Type

export const StoredEvent = Schema.Struct({
  id: EventId,
  event: AgentEvent,
  deliveredAt: Schema.optionalKey(Schema.DateTimeUtc)
})

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export const migrations = Migrator.fromRecord({
  "0001_init": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const singleton = (name: string) =>
      sql.unsafe(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`)
    yield* singleton("project")
    yield* singleton("status")
    yield* singleton("sandbox")
    yield* singleton("live_activity")
    yield* singleton("mac")
    yield* singleton("usage_pause")
    yield* sql`CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      json TEXT NOT NULL
    )`
    yield* sql`CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      next_at_ms INTEGER
    )`
    yield* sql`CREATE INDEX schedules_next ON schedules (next_at_ms)`
    yield* sql`CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      json TEXT NOT NULL
    )`
    yield* sql`CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      json TEXT NOT NULL,
      delivered_at TEXT
    )`
    yield* sql`CREATE TABLE browser_sessions (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      ended INTEGER NOT NULL DEFAULT 0
    )`
    yield* sql`CREATE TABLE timers (
      name TEXT PRIMARY KEY,
      due_ms INTEGER NOT NULL
    )`
  }),
  "0002_archived": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE archived (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`
  })
})

export const migrate = Migrator.make({})({ loader: migrations }).pipe(Effect.orDie)

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

const JsonRow = Schema.Struct({ json: Schema.String })
const MessageRow = Schema.Struct({ seq: Schema.Number, json: Schema.String })

export type TimerName =
  | "deliver"
  | "usage-reset"
  | "mac-idle"
  | "turn-keepalive"
  | "browser-sweep"
  | "sandbox-retry"
  | "sandbox-refresh"

export class Store extends Context.Service<
  Store,
  {
    readonly getSingleton: <S extends Schema.Top>(table: string, schema: S) => Effect.Effect<Option.Option<S["Type"]>>
    readonly putSingleton: <S extends Schema.Top>(table: string, schema: S, value: S["Type"]) => Effect.Effect<void>
    readonly clearSingleton: (table: string) => Effect.Effect<void>

    readonly insertMessage: (message: Message) => Effect.Effect<void>
    readonly updateMessage: (message: Message) => Effect.Effect<void>
    readonly message: (id: MessageId) => Effect.Effect<Option.Option<Message>>
    /** Newest first, before `before` (exclusive), up to `limit`. */
    readonly messagesBefore: (
      before: MessageId | undefined,
      limit: number
    ) => Effect.Effect<{ readonly messages: ReadonlyArray<Message>; readonly hasEarlier: boolean }>
    readonly openAsks: Effect.Effect<ReadonlyArray<Message>>

    readonly putWake: (wake: Wake, nextAtMs: number | undefined) => Effect.Effect<void>
    readonly wakes: Effect.Effect<ReadonlyArray<Wake>>
    readonly wake: (id: WakeId) => Effect.Effect<Option.Option<Wake>>
    readonly deleteWake: (id: WakeId) => Effect.Effect<void>
    readonly dueWakes: (nowMs: number) => Effect.Effect<ReadonlyArray<Wake>>
    readonly nextWakeMs: Effect.Effect<Option.Option<number>>

    readonly putNotification: (record: NotificationRecord) => Effect.Effect<void>
    readonly notification: (id: NotificationId) => Effect.Effect<Option.Option<NotificationRecord>>
    readonly notificationsFor: (messageId: MessageId) => Effect.Effect<ReadonlyArray<NotificationRecord>>

    readonly enqueue: (event: AgentEvent) => Effect.Effect<void>
    readonly pendingEvents: (limit: number) => Effect.Effect<ReadonlyArray<AgentEvent>>
    readonly markDelivered: (ids: ReadonlyArray<EventId>, at: string) => Effect.Effect<void>

    readonly putBrowser: (record: BrowserRecord) => Effect.Effect<void>
    readonly browser: (id: string) => Effect.Effect<Option.Option<BrowserRecord>>
    readonly openBrowsers: Effect.Effect<ReadonlyArray<BrowserRecord>>

    readonly setTimer: (name: TimerName, dueMs: number) => Effect.Effect<void>
    readonly clearTimer: (name: TimerName) => Effect.Effect<void>
    /** Archiving: drop every timer, wake and undelivered event. */
    readonly clearSchedule: (at: string) => Effect.Effect<void>
    readonly dueTimers: (nowMs: number) => Effect.Effect<ReadonlyArray<TimerName>>
    readonly nextTimerMs: Effect.Effect<Option.Option<number>>
  }
>()("@dream/api/project/Store") {
  static readonly layer = Layer.effect(
    Store,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const getSingleton = <S extends Schema.Top>(table: string, schema: S) =>
        sql.unsafe(`SELECT json FROM ${table} WHERE id = 1`).pipe(
          decodeFirst(JsonRow),
          Effect.map((row) =>
            row === undefined ? Option.none() : Option.some(Schema.decodeUnknownSync(jsonCodec(schema))(row.json))
          )
        )

      const putSingleton = <S extends Schema.Top>(table: string, schema: S, value: S["Type"]) =>
        exec(
          sql.unsafe(
            `INSERT INTO ${table} (id, json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json`,
            [encodeJson(schema, value)]
          )
        )

      const clearSingleton = (table: string) => exec(sql.unsafe(`DELETE FROM ${table}`))

      const decodeMessage = (json: string) => Schema.decodeUnknownSync(jsonCodec(Message))(json)

      const insertMessage = (message: Message) =>
        exec(
          sql`INSERT INTO messages (id, created_at, json) VALUES (${message.id}, ${encodeIso(message)}, ${encodeJson(Message, message)})`
        )

      const updateMessage = (message: Message) =>
        exec(sql`UPDATE messages SET json = ${encodeJson(Message, message)} WHERE id = ${message.id}`)

      const message = (id: MessageId) =>
        sql`SELECT json FROM messages WHERE id = ${id}`.pipe(
          decodeFirst(JsonRow),
          Effect.map((row) => (row === undefined ? Option.none() : Option.some(decodeMessage(row.json))))
        )

      const messagesBefore = (before: MessageId | undefined, limit: number) =>
        Effect.gen(function* () {
          const rows = yield* (
            before === undefined
              ? sql`SELECT seq, json FROM messages ORDER BY seq DESC LIMIT ${limit + 1}`
              : sql`SELECT seq, json FROM messages WHERE seq < (SELECT seq FROM messages WHERE id = ${before})
                    ORDER BY seq DESC LIMIT ${limit + 1}`
          ).pipe(decodeRows(MessageRow))
          return {
            messages: rows.slice(0, limit).map((row) => decodeMessage(row.json)),
            hasEarlier: rows.length > limit
          }
        })

      const openAsks = sql`SELECT json FROM messages
          WHERE json_extract(json, '$._tag') IN ('Question', 'Access') AND json_extract(json, '$.state._tag') = 'Open'
          ORDER BY seq`.pipe(
        decodeRows(JsonRow),
        Effect.map((rows) => rows.map((row) => decodeMessage(row.json)))
      )

      const putWake = (wake: Wake, nextAtMs: number | undefined) =>
        exec(sql`
          INSERT INTO schedules (id, json, next_at_ms) VALUES (${wake.id}, ${encodeJson(Wake, wake)}, ${nextAtMs ?? null})
          ON CONFLICT (id) DO UPDATE SET json = excluded.json, next_at_ms = excluded.next_at_ms`)

      const decodeWake = (json: string) => Schema.decodeUnknownSync(jsonCodec(Wake))(json)

      const wakes = sql`SELECT json FROM schedules ORDER BY COALESCE(next_at_ms, 0)`.pipe(
        decodeRows(JsonRow),
        Effect.map((rows) => rows.map((row) => decodeWake(row.json)))
      )

      const wake = (id: WakeId) =>
        sql`SELECT json FROM schedules WHERE id = ${id}`.pipe(
          decodeFirst(JsonRow),
          Effect.map((row) => (row === undefined ? Option.none() : Option.some(decodeWake(row.json))))
        )

      const deleteWake = (id: WakeId) => exec(sql`DELETE FROM schedules WHERE id = ${id}`)

      const dueWakes = (nowMs: number) =>
        sql`SELECT json FROM schedules WHERE next_at_ms IS NOT NULL AND next_at_ms <= ${nowMs} ORDER BY next_at_ms`.pipe(
          decodeRows(JsonRow),
          Effect.map((rows) => rows.map((row) => decodeWake(row.json)))
        )

      const nextWakeMs = sql`SELECT MIN(next_at_ms) AS due FROM schedules WHERE next_at_ms IS NOT NULL`.pipe(
        decodeFirst(Schema.Struct({ due: Schema.NullOr(Schema.Number) })),
        Effect.map((row) => Option.fromNullishOr(row?.due))
      )

      const putNotification = (record: NotificationRecord) =>
        exec(sql`
          INSERT INTO notifications (id, message_id, json) VALUES (${record.id}, ${record.messageId ?? null},
            ${encodeJson(NotificationRecord, record)})
          ON CONFLICT (id) DO UPDATE SET json = excluded.json`)

      const decodeNotification = (json: string) => Schema.decodeUnknownSync(jsonCodec(NotificationRecord))(json)

      const notification = (id: NotificationId) =>
        sql`SELECT json FROM notifications WHERE id = ${id}`.pipe(
          decodeFirst(JsonRow),
          Effect.map((row) => (row === undefined ? Option.none() : Option.some(decodeNotification(row.json))))
        )

      const notificationsFor = (messageId: MessageId) =>
        sql`SELECT json FROM notifications WHERE message_id = ${messageId}`.pipe(
          decodeRows(JsonRow),
          Effect.map((rows) => rows.map((row) => decodeNotification(row.json)))
        )

      const enqueue = (event: AgentEvent) =>
        exec(
          sql`INSERT INTO events (id, json) VALUES (${event.id}, ${encodeJson(AgentEvent, event)}) ON CONFLICT (id) DO NOTHING`
        )

      const pendingEvents = (limit: number) =>
        sql`SELECT json FROM events WHERE delivered_at IS NULL ORDER BY seq LIMIT ${limit}`.pipe(
          decodeRows(JsonRow),
          Effect.map((rows) => rows.map((row) => Schema.decodeUnknownSync(jsonCodec(AgentEvent))(row.json)))
        )

      const markDelivered = (ids: ReadonlyArray<EventId>, at: string) =>
        ids.length === 0 ? Effect.void : exec(sql`UPDATE events SET delivered_at = ${at} WHERE ${sql.in("id", ids)}`)

      const putBrowser = (record: BrowserRecord) =>
        exec(sql`
          INSERT INTO browser_sessions (id, json, ended) VALUES (${record.id}, ${encodeJson(BrowserRecord, record)},
            ${record.endedAt === undefined ? 0 : 1})
          ON CONFLICT (id) DO UPDATE SET json = excluded.json, ended = excluded.ended`)

      const decodeBrowser = (json: string) => Schema.decodeUnknownSync(jsonCodec(BrowserRecord))(json)

      const browser = (id: string) =>
        sql`SELECT json FROM browser_sessions WHERE id = ${id}`.pipe(
          decodeFirst(JsonRow),
          Effect.map((row) => (row === undefined ? Option.none() : Option.some(decodeBrowser(row.json))))
        )

      const openBrowsers = sql`SELECT json FROM browser_sessions WHERE ended = 0`.pipe(
        decodeRows(JsonRow),
        Effect.map((rows) => rows.map((row) => decodeBrowser(row.json)))
      )

      const setTimer = (name: TimerName, dueMs: number) =>
        exec(sql`INSERT INTO timers (name, due_ms) VALUES (${name}, ${dueMs})
                 ON CONFLICT (name) DO UPDATE SET due_ms = excluded.due_ms`)

      const clearTimer = (name: TimerName) => exec(sql`DELETE FROM timers WHERE name = ${name}`)

      const clearSchedule = (at: string) =>
        Effect.gen(function* () {
          yield* exec(sql`DELETE FROM timers`)
          yield* exec(sql`DELETE FROM schedules`)
          yield* exec(sql`UPDATE events SET delivered_at = ${at} WHERE delivered_at IS NULL`)
        })

      const dueTimers = (nowMs: number) =>
        sql`SELECT name FROM timers WHERE due_ms <= ${nowMs} ORDER BY due_ms`.pipe(
          decodeRows(Schema.Struct({ name: Schema.String })),
          Effect.map((rows) => rows.map((row) => row.name as TimerName))
        )

      const nextTimerMs = sql`SELECT MIN(due_ms) AS due FROM timers`.pipe(
        decodeFirst(Schema.Struct({ due: Schema.NullOr(Schema.Number) })),
        Effect.map((row) => Option.fromNullishOr(row?.due))
      )

      return Store.of({
        getSingleton,
        putSingleton,
        clearSingleton,
        insertMessage,
        updateMessage,
        message,
        messagesBefore,
        openAsks,
        putWake,
        wakes,
        wake,
        deleteWake,
        dueWakes,
        nextWakeMs,
        putNotification,
        notification,
        notificationsFor,
        enqueue,
        pendingEvents,
        markDelivered,
        putBrowser,
        browser,
        openBrowsers,
        setTimer,
        clearTimer,
        clearSchedule,
        dueTimers,
        nextTimerMs
      })
    })
  )
}

const encodeIso = (message: Message): string => encodeJson(Schema.DateTimeUtc, message.createdAt).replace(/"/g, "")

/** Singleton table names, typed. */
export const Singletons = {
  project: ["project", Project] as const,
  status: ["status", StatusCard] as const,
  sandbox: ["sandbox", SandboxRecord] as const,
  liveActivity: ["live_activity", LiveActivityRecord] as const,
  mac: ["mac", MacRecord] as const,
  usagePause: ["usage_pause", UsagePause] as const,
  archived: ["archived", Schema.Struct({ at: Schema.DateTimeUtc })] as const
}
