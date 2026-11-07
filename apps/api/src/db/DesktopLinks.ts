/**
 * Emailed links to finish an access request on a computer (D1 `desktop_links`). Rows hold hashes of the emailed
 * token and of the one browser session that opened it, never the values. Every change is one conditional UPDATE,
 * so two browsers racing for the same link can't both open it.
 */
import { MessageId, ProjectId, UserId } from "@dream/domain"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { decodeFirst, exec } from "./Sql.ts"

const DesktopLinkRow = Schema.Struct({
  id: Schema.String,
  token_hash: Schema.String,
  user_id: UserId,
  project_id: ProjectId,
  message_id: MessageId,
  created_at_ms: Schema.Number,
  expires_at_ms: Schema.Number,
  opened_at_ms: Schema.NullOr(Schema.Number),
  session_hash: Schema.NullOr(Schema.String),
  session_expires_at_ms: Schema.NullOr(Schema.Number),
  finished_at_ms: Schema.NullOr(Schema.Number),
  revoked_at_ms: Schema.NullOr(Schema.Number)
})
export type DesktopLinkRow = typeof DesktopLinkRow.Type

export class DesktopLinks extends Context.Service<
  DesktopLinks,
  {
    readonly insert: (row: {
      readonly id: string
      readonly tokenHash: string
      readonly userId: UserId
      readonly projectId: ProjectId
      readonly messageId: MessageId
      readonly nowMs: number
      readonly expiresAtMs: number
    }) => Effect.Effect<void>
    /** How many links they had sent since `sinceMs`: for this request, and in all. */
    readonly sentSince: (
      userId: UserId,
      projectId: ProjectId,
      messageId: MessageId,
      sinceMs: number
    ) => Effect.Effect<{ readonly forMessage: number; readonly forUser: number }>
    /** Ends every unfinished link for the request (a newer one replaces them, or it's no longer waiting). */
    readonly revokeFor: (projectId: ProjectId, messageId: MessageId, nowMs: number) => Effect.Effect<void>
    readonly revoke: (id: string, nowMs: number) => Effect.Effect<void>
    readonly byTokenHash: (tokenHash: string) => Effect.Effect<Option.Option<DesktopLinkRow>>
    readonly byId: (id: string) => Effect.Effect<Option.Option<DesktopLinkRow>>
    /** Opens an unopened, live link for one browser session; false if anyone got there first. */
    readonly open: (
      id: string,
      sessionHash: string,
      nowMs: number,
      sessionExpiresAtMs: number
    ) => Effect.Effect<boolean>
    /** Marks it finished, once; false if it already was, or isn't live. */
    readonly finish: (id: string, nowMs: number) => Effect.Effect<boolean>
  }
>()("@dream/api/DesktopLinks") {
  static readonly layer = Layer.effect(
    DesktopLinks,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const insert = (row: Parameters<DesktopLinks["Service"]["insert"]>[0]) =>
        Effect.gen(function* () {
          // Rows a day past their session have no further use.
          yield* exec(sql`DELETE FROM desktop_links WHERE created_at_ms < ${row.nowMs - 86_400_000}`)
          yield* exec(sql`
            INSERT INTO desktop_links (id, token_hash, user_id, project_id, message_id, created_at_ms, expires_at_ms)
            VALUES (${row.id}, ${row.tokenHash}, ${row.userId}, ${row.projectId}, ${row.messageId}, ${row.nowMs},
                    ${row.expiresAtMs})`)
        })

      const count = (statement: Effect.Effect<ReadonlyArray<unknown>, unknown>) =>
        statement.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ n: Schema.Number })]))),
          Effect.map(([row]) => row.n),
          Effect.orDie
        )

      const sentSince = (userId: UserId, projectId: ProjectId, messageId: MessageId, sinceMs: number) =>
        Effect.all({
          forMessage: count(sql`SELECT COUNT(*) AS n FROM desktop_links
              WHERE project_id = ${projectId} AND message_id = ${messageId} AND created_at_ms >= ${sinceMs}`),
          forUser: count(
            sql`SELECT COUNT(*) AS n FROM desktop_links WHERE user_id = ${userId} AND created_at_ms >= ${sinceMs}`
          )
        })

      const revokeFor = (projectId: ProjectId, messageId: MessageId, nowMs: number) =>
        exec(sql`UPDATE desktop_links SET revoked_at_ms = ${nowMs}
            WHERE project_id = ${projectId} AND message_id = ${messageId}
              AND revoked_at_ms IS NULL AND finished_at_ms IS NULL`)

      const revoke = (id: string, nowMs: number) =>
        exec(sql`UPDATE desktop_links SET revoked_at_ms = ${nowMs} WHERE id = ${id} AND revoked_at_ms IS NULL`)

      const byTokenHash = (tokenHash: string) =>
        sql`SELECT * FROM desktop_links WHERE token_hash = ${tokenHash}`.pipe(
          decodeFirst(DesktopLinkRow),
          Effect.map(Option.fromUndefinedOr)
        )

      const byId = (id: string) =>
        sql`SELECT * FROM desktop_links WHERE id = ${id}`.pipe(
          decodeFirst(DesktopLinkRow),
          Effect.map(Option.fromUndefinedOr)
        )

      const open = (id: string, sessionHash: string, nowMs: number, sessionExpiresAtMs: number) =>
        sql`UPDATE desktop_links SET opened_at_ms = ${nowMs}, session_hash = ${sessionHash},
                session_expires_at_ms = ${sessionExpiresAtMs}
            WHERE id = ${id} AND opened_at_ms IS NULL AND revoked_at_ms IS NULL AND finished_at_ms IS NULL
              AND expires_at_ms > ${nowMs}
            RETURNING id`.pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.orDie
        )

      const finish = (id: string, nowMs: number) =>
        sql`UPDATE desktop_links SET finished_at_ms = ${nowMs}
            WHERE id = ${id} AND finished_at_ms IS NULL AND revoked_at_ms IS NULL
            RETURNING id`.pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.orDie
        )

      return DesktopLinks.of({ insert, sentSince, revokeFor, revoke, byTokenHash, byId, open, finish })
    })
  )
}
