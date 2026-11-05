/**
 * Model connections (Claude or ChatGPT, once per person), integrations
 * (Google, pasted keys, App Store Connect) and pending Google OAuth states (D1).
 * Rows reference secrets by id; the records here carry no secret values.
 */
import {
  Integration,
  IntegrationAccess,
  IntegrationId,
  IntegrationStatus,
  MessageId,
  ModelConnectFlow,
  ModelConnection,
  ModelConnectionId,
  ModelConnectionStatus,
  ModelProvider,
  ProjectId,
  UsageSnapshot,
  UserId
} from "@dream/domain"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { newIntegrationId, newModelConnectionId } from "../lib/Ids.ts"
import { decodeFirst, decodeRows, encodeJson, exec, IsoDate, JsonColumn, nowIso, orNull } from "./Sql.ts"

export const IntegrationKind = Schema.Literals(["google_oauth", "api_key", "apple_asc"])
export type IntegrationKind = typeof IntegrationKind.Type

const ModelConnectionRow = Schema.Struct({
  id: ModelConnectionId,
  user_id: UserId,
  provider: ModelProvider,
  status: ModelConnectionStatus,
  secret_id: Schema.NullOr(Schema.String),
  auth_sandbox_id: Schema.NullOr(Schema.String),
  auth_secret_id: Schema.NullOr(Schema.String),
  flow_json: Schema.NullOr(JsonColumn(ModelConnectFlow)),
  error: Schema.NullOr(Schema.String),
  access_expires_at_ms: Schema.NullOr(Schema.Number),
  usage_json: Schema.NullOr(JsonColumn(UsageSnapshot)),
  connected_at: Schema.NullOr(IsoDate),
  created_at: IsoDate,
  updated_at: IsoDate
})
export type ModelConnectionRow = typeof ModelConnectionRow.Type

export const toModelConnection = (row: ModelConnectionRow): ModelConnection => ({
  id: row.id,
  provider: row.provider,
  status: row.status,
  ...(row.connected_at === null ? {} : { connectedAt: row.connected_at }),
  ...(row.usage_json === null ? {} : { usage: row.usage_json })
})

const IntegrationRow = Schema.Struct({
  id: IntegrationId,
  user_id: UserId,
  kind: IntegrationKind,
  label: Schema.String,
  status: IntegrationStatus,
  access_json: JsonColumn(IntegrationAccess),
  secret_id: Schema.String,
  access_expires_at_ms: Schema.NullOr(Schema.Number),
  connected_at: IsoDate,
  updated_at: IsoDate
})
export type IntegrationRow = typeof IntegrationRow.Type

export const toIntegration = (row: IntegrationRow): Integration => ({
  id: row.id,
  label: row.label,
  status: row.status,
  access: row.access_json,
  connectedAt: row.connected_at
})

const OAuthStateRow = Schema.Struct({
  state: Schema.String,
  user_id: UserId,
  project_id: ProjectId,
  message_id: MessageId,
  scopes_json: JsonColumn(Schema.Array(Schema.String)),
  expires_at_ms: Schema.Number
})
export type OAuthStateRow = typeof OAuthStateRow.Type

export interface NewIntegration {
  readonly userId: UserId
  readonly kind: IntegrationKind
  readonly label: string
  readonly access: IntegrationAccess
  readonly secretId: string
  readonly accessExpiresAtMs?: number | undefined
}

export class Connections extends Context.Service<
  Connections,
  {
    // Model connections ------------------------------------------------------
    readonly createModelConnection: (userId: UserId, provider: ModelProvider) => Effect.Effect<ModelConnectionRow>
    readonly modelConnection: (
      userId: UserId,
      id: ModelConnectionId
    ) => Effect.Effect<Option.Option<ModelConnectionRow>>
    readonly modelConnections: (userId: UserId) => Effect.Effect<ReadonlyArray<ModelConnectionRow>>
    /** The connected subscription for a provider, newest first. */
    readonly connectedModel: (
      userId: UserId,
      provider: ModelProvider
    ) => Effect.Effect<Option.Option<ModelConnectionRow>>
    readonly updateModelConnection: (
      id: ModelConnectionId,
      patch: {
        readonly status?: ModelConnectionStatus
        readonly secretId?: string | null
        readonly authSandboxId?: string | null
        readonly authSecretId?: string | null
        readonly flow?: ModelConnectFlow | null
        readonly error?: string | null
        readonly accessExpiresAtMs?: number | null
        readonly connectedAt?: DateTime.Utc
      }
    ) => Effect.Effect<void>
    readonly deleteModelConnection: (id: ModelConnectionId) => Effect.Effect<void>
    readonly recordUsage: (userId: UserId, usage: UsageSnapshot) => Effect.Effect<void>
    /** ChatGPT connections whose access token expires before `beforeMs`. */
    readonly expiringChatGpt: (beforeMs: number) => Effect.Effect<ReadonlyArray<ModelConnectionRow>>
    /** Takes the refresh lock until `untilMs`; false if someone else holds it. */
    readonly lockModelRefresh: (id: ModelConnectionId, nowMs: number, untilMs: number) => Effect.Effect<boolean>
    readonly unlockModelRefresh: (id: ModelConnectionId) => Effect.Effect<void>
    /** Pending connections whose auth sandboxes are older than `beforeIso`. */
    readonly stalePending: (before: DateTime.Utc) => Effect.Effect<ReadonlyArray<ModelConnectionRow>>

    // Integrations -------------------------------------------------------------
    readonly createIntegration: (integration: NewIntegration) => Effect.Effect<IntegrationRow>
    readonly integration: (userId: UserId, id: IntegrationId) => Effect.Effect<Option.Option<IntegrationRow>>
    readonly integrations: (userId: UserId) => Effect.Effect<ReadonlyArray<IntegrationRow>>
    readonly updateIntegration: (
      id: IntegrationId,
      patch: {
        readonly status?: IntegrationStatus
        readonly label?: string
        readonly access?: IntegrationAccess
        readonly accessExpiresAtMs?: number | null
      }
    ) => Effect.Effect<void>
    readonly deleteIntegration: (id: IntegrationId) => Effect.Effect<void>
    readonly expiringIntegrations: (beforeMs: number) => Effect.Effect<ReadonlyArray<IntegrationRow>>
    readonly lockIntegrationRefresh: (id: IntegrationId, nowMs: number, untilMs: number) => Effect.Effect<boolean>
    readonly unlockIntegrationRefresh: (id: IntegrationId) => Effect.Effect<void>

    // Google OAuth states --------------------------------------------------------
    readonly putOAuthState: (row: OAuthStateRow) => Effect.Effect<void>
    /** Reads and deletes a state; absent if unknown or expired. */
    readonly takeOAuthState: (state: string, nowMs: number) => Effect.Effect<Option.Option<OAuthStateRow>>
  }
>()("@dream/api/Connections") {
  static readonly layer = Layer.effect(
    Connections,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const modelById = (id: ModelConnectionId) =>
        sql`SELECT * FROM model_connections WHERE id = ${id}`.pipe(decodeFirst(ModelConnectionRow))

      const createModelConnection = Effect.fn("Connections.createModelConnection")(function* (
        userId: UserId,
        provider: ModelProvider
      ) {
        const id = yield* newModelConnectionId()
        const now = yield* nowIso
        yield* exec(sql`
          INSERT INTO model_connections (id, user_id, provider, status, created_at, updated_at)
          VALUES (${id}, ${userId}, ${provider}, 'pending', ${now}, ${now})`)
        return (yield* modelById(id))!
      })

      const modelConnection = (userId: UserId, id: ModelConnectionId) =>
        sql`SELECT * FROM model_connections WHERE id = ${id} AND user_id = ${userId}`.pipe(
          decodeFirst(ModelConnectionRow),
          Effect.map(Option.fromUndefinedOr)
        )

      const modelConnections = (userId: UserId) =>
        sql`SELECT * FROM model_connections WHERE user_id = ${userId} ORDER BY created_at DESC`.pipe(
          decodeRows(ModelConnectionRow)
        )

      const connectedModel = (userId: UserId, provider: ModelProvider) =>
        sql`SELECT * FROM model_connections WHERE user_id = ${userId} AND provider = ${provider} AND status = 'connected'
            ORDER BY connected_at DESC LIMIT 1`.pipe(
          decodeFirst(ModelConnectionRow),
          Effect.map(Option.fromUndefinedOr)
        )

      const updateModelConnection = Effect.fn("Connections.updateModelConnection")(function* (
        id: ModelConnectionId,
        patch: {
          readonly status?: ModelConnectionStatus
          readonly secretId?: string | null
          readonly authSandboxId?: string | null
          readonly authSecretId?: string | null
          readonly flow?: ModelConnectFlow | null
          readonly error?: string | null
          readonly accessExpiresAtMs?: number | null
          readonly connectedAt?: DateTime.Utc
        }
      ) {
        const now = yield* nowIso
        const fields: Record<string, unknown> = { updated_at: now }
        if (patch.status !== undefined) fields.status = patch.status
        if (patch.secretId !== undefined) fields.secret_id = patch.secretId
        if (patch.authSandboxId !== undefined) fields.auth_sandbox_id = patch.authSandboxId
        if (patch.authSecretId !== undefined) fields.auth_secret_id = patch.authSecretId
        if (patch.flow !== undefined)
          fields.flow_json = patch.flow === null ? null : encodeJson(ModelConnectFlow, patch.flow)
        if (patch.error !== undefined) fields.error = patch.error
        if (patch.accessExpiresAtMs !== undefined) fields.access_expires_at_ms = patch.accessExpiresAtMs
        if (patch.connectedAt !== undefined) fields.connected_at = DateTime.formatIso(patch.connectedAt)
        yield* exec(sql`UPDATE model_connections SET ${sql.update(fields)} WHERE id = ${id}`)
      })

      const deleteModelConnection = (id: ModelConnectionId) => exec(sql`DELETE FROM model_connections WHERE id = ${id}`)

      const recordUsage = (userId: UserId, usage: UsageSnapshot) =>
        Effect.gen(function* () {
          const now = yield* nowIso
          yield* exec(sql`
            UPDATE model_connections SET usage_json = ${encodeJson(UsageSnapshot, usage)}, updated_at = ${now}
            WHERE user_id = ${userId} AND provider = ${usage.provider} AND status = 'connected'`)
        })

      const expiringChatGpt = (beforeMs: number) =>
        sql`SELECT * FROM model_connections WHERE provider = 'chatgpt' AND status = 'connected'
            AND access_expires_at_ms IS NOT NULL AND access_expires_at_ms < ${beforeMs}`.pipe(
          decodeRows(ModelConnectionRow)
        )

      const lockModelRefresh = (id: ModelConnectionId, nowMs: number, untilMs: number) =>
        sql`UPDATE model_connections SET refresh_lock_until_ms = ${untilMs}
            WHERE id = ${id} AND (refresh_lock_until_ms IS NULL OR refresh_lock_until_ms < ${nowMs})
            RETURNING id`.pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.orDie
        )

      const unlockModelRefresh = (id: ModelConnectionId) =>
        exec(sql`UPDATE model_connections SET refresh_lock_until_ms = NULL WHERE id = ${id}`)

      const stalePending = (before: DateTime.Utc) =>
        sql`SELECT * FROM model_connections WHERE status = 'pending' AND created_at < ${DateTime.formatIso(before)}`.pipe(
          decodeRows(ModelConnectionRow)
        )

      const integrationById = (id: IntegrationId) =>
        sql`SELECT * FROM integrations WHERE id = ${id}`.pipe(decodeFirst(IntegrationRow))

      const createIntegration = Effect.fn("Connections.createIntegration")(function* (integration: NewIntegration) {
        const id = yield* newIntegrationId()
        const now = yield* nowIso
        yield* exec(sql`
          INSERT INTO integrations (id, user_id, kind, label, status, access_json, secret_id, access_expires_at_ms, connected_at, updated_at)
          VALUES (${id}, ${integration.userId}, ${integration.kind}, ${integration.label}, 'connected',
                  ${encodeJson(IntegrationAccess, integration.access)}, ${integration.secretId},
                  ${orNull(integration.accessExpiresAtMs)}, ${now}, ${now})`)
        return (yield* integrationById(id))!
      })

      const integration = (userId: UserId, id: IntegrationId) =>
        sql`SELECT * FROM integrations WHERE id = ${id} AND user_id = ${userId}`.pipe(
          decodeFirst(IntegrationRow),
          Effect.map(Option.fromUndefinedOr)
        )

      const integrations = (userId: UserId) =>
        sql`SELECT * FROM integrations WHERE user_id = ${userId} ORDER BY connected_at`.pipe(decodeRows(IntegrationRow))

      const updateIntegration = Effect.fn("Connections.updateIntegration")(function* (
        id: IntegrationId,
        patch: {
          readonly status?: IntegrationStatus
          readonly label?: string
          readonly access?: IntegrationAccess
          readonly accessExpiresAtMs?: number | null
        }
      ) {
        const now = yield* nowIso
        const fields: Record<string, unknown> = { updated_at: now }
        if (patch.status !== undefined) fields.status = patch.status
        if (patch.label !== undefined) fields.label = patch.label
        if (patch.access !== undefined) fields.access_json = encodeJson(IntegrationAccess, patch.access)
        if (patch.accessExpiresAtMs !== undefined) fields.access_expires_at_ms = patch.accessExpiresAtMs
        yield* exec(sql`UPDATE integrations SET ${sql.update(fields)} WHERE id = ${id}`)
      })

      const deleteIntegration = (id: IntegrationId) => exec(sql`DELETE FROM integrations WHERE id = ${id}`)

      const expiringIntegrations = (beforeMs: number) =>
        sql`SELECT * FROM integrations WHERE status = 'connected'
            AND access_expires_at_ms IS NOT NULL AND access_expires_at_ms < ${beforeMs}`.pipe(
          decodeRows(IntegrationRow)
        )

      const lockIntegrationRefresh = (id: IntegrationId, nowMs: number, untilMs: number) =>
        sql`UPDATE integrations SET refresh_lock_until_ms = ${untilMs}
            WHERE id = ${id} AND (refresh_lock_until_ms IS NULL OR refresh_lock_until_ms < ${nowMs})
            RETURNING id`.pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.orDie
        )

      const unlockIntegrationRefresh = (id: IntegrationId) =>
        exec(sql`UPDATE integrations SET refresh_lock_until_ms = NULL WHERE id = ${id}`)

      const putOAuthState = (row: OAuthStateRow) =>
        exec(sql`
          INSERT INTO oauth_states (state, user_id, project_id, message_id, scopes_json, expires_at_ms)
          VALUES (${row.state}, ${row.user_id}, ${row.project_id}, ${row.message_id},
                  ${encodeJson(Schema.Array(Schema.String), row.scopes_json)}, ${row.expires_at_ms})`)

      const takeOAuthState = (state: string, nowMs: number) =>
        Effect.gen(function* () {
          const row = yield* sql`DELETE FROM oauth_states WHERE state = ${state} RETURNING *`.pipe(
            decodeFirst(OAuthStateRow)
          )
          yield* exec(sql`DELETE FROM oauth_states WHERE expires_at_ms < ${nowMs}`)
          return row === undefined || row.expires_at_ms < nowMs ? Option.none() : Option.some(row)
        })

      return Connections.of({
        createModelConnection,
        modelConnection,
        modelConnections,
        connectedModel,
        updateModelConnection,
        deleteModelConnection,
        recordUsage,
        expiringChatGpt,
        lockModelRefresh,
        unlockModelRefresh,
        stalePending,
        createIntegration,
        integration,
        integrations,
        updateIntegration,
        deleteIntegration,
        expiringIntegrations,
        lockIntegrationRefresh,
        unlockIntegrationRefresh,
        putOAuthState,
        takeOAuthState
      })
    })
  )
}
