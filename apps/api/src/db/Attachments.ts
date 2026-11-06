/**
 * Photos and files they attach (D1 `attachments`, bytes in R2). An upload is the person's until a message or a new
 * idea takes it (`claim`); from then on it belongs to that project, goes when the project is deleted, and dreamd
 * may fetch it with that project's token.
 */
import {
  Attachment,
  InvalidRequest,
  MediaId,
  type MessageId,
  ProjectId,
  UserId,
  uniqueAttachmentNames
} from "@dream/domain"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { decodeFirst, decodeRows, encodeJson, exec, IsoDate, JsonColumn, nowIso } from "./Sql.ts"

const AttachmentRow = Schema.Struct({
  id: MediaId,
  user_id: UserId,
  project_id: Schema.NullOr(ProjectId),
  claim: Schema.NullOr(Schema.String),
  object_key: Schema.String,
  ref_json: JsonColumn(Attachment),
  uploaded_at: Schema.NullOr(IsoDate)
})
export type AttachmentRow = typeof AttachmentRow.Type

export class Attachments extends Context.Service<
  Attachments,
  {
    readonly insert: (row: {
      readonly attachment: Attachment
      readonly userId: UserId
      readonly objectKey: string
    }) => Effect.Effect<void>
    readonly find: (id: MediaId) => Effect.Effect<Option.Option<AttachmentRow>>
    readonly markUploaded: (id: MediaId, at: DateTime.Utc) => Effect.Effect<void>
    /**
     * Give their uploads to a message (`claim` is its id, or a new idea's project id) and return them in order, with
     * repeated names numbered. Taking them again for the same claim is fine (a retry); anything not theirs, not
     * uploaded, or taken by something else is refused.
     */
    readonly claim: (
      userId: UserId,
      projectId: ProjectId,
      claim: MessageId | ProjectId,
      ids: ReadonlyArray<MediaId>
    ) => Effect.Effect<ReadonlyArray<Attachment>, InvalidRequest>
    /** The R2 keys of a project's attachments. */
    readonly keysForProject: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<string>>
    readonly removeForProject: (projectId: ProjectId) => Effect.Effect<void>
  }
>()("@dream/api/Attachments") {
  static readonly layer = Layer.effect(
    Attachments,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const find = (id: MediaId) =>
        sql`SELECT * FROM attachments WHERE id = ${id}`.pipe(
          decodeFirst(AttachmentRow),
          Effect.map(Option.fromUndefinedOr)
        )

      const claim = Effect.fn("Attachments.claim")(function* (
        userId: UserId,
        projectId: ProjectId,
        claim: MessageId | ProjectId,
        ids: ReadonlyArray<MediaId>
      ) {
        if (ids.length === 0) return []
        if (new Set(ids).size !== ids.length) {
          return yield* new InvalidRequest({ message: "The same attachment is in this message twice." })
        }
        const rows = yield* sql`SELECT * FROM attachments WHERE ${sql.in("id", ids)}`.pipe(decodeRows(AttachmentRow))
        const byId = new Map(rows.map((row) => [row.id, row]))
        const ordered: Array<AttachmentRow> = []
        for (const id of ids) {
          const row = byId.get(id)
          if (row === undefined || row.user_id !== userId) {
            return yield* new InvalidRequest({ message: `There's no attachment ${id}.` })
          }
          if (row.uploaded_at === null) {
            return yield* new InvalidRequest({ message: `${row.ref_json.name} hasn't finished uploading.` })
          }
          if (row.claim !== null && (row.claim !== claim || row.project_id !== projectId)) {
            return yield* new InvalidRequest({ message: `${row.ref_json.name} was already sent with another message.` })
          }
          ordered.push(row)
        }
        yield* exec(sql`UPDATE attachments SET project_id = ${projectId}, claim = ${claim} WHERE ${sql.in("id", ids)}`)
        return uniqueAttachmentNames(ordered.map((row) => row.ref_json))
      })

      return Attachments.of({
        insert: ({ attachment, userId, objectKey }) =>
          Effect.gen(function* () {
            const now = yield* nowIso
            yield* exec(sql`
              INSERT INTO attachments (id, user_id, object_key, ref_json, created_at)
              VALUES (${attachment.id}, ${userId}, ${objectKey}, ${encodeJson(Attachment, attachment)}, ${now})`)
          }),
        find,
        markUploaded: (id, at) =>
          exec(sql`UPDATE attachments SET uploaded_at = ${DateTime.formatIso(at)} WHERE id = ${id}`),
        claim,
        keysForProject: (projectId) =>
          sql`SELECT object_key FROM attachments WHERE project_id = ${projectId}`.pipe(
            decodeRows(Schema.Struct({ object_key: Schema.String })),
            Effect.map((rows) => rows.map((row) => row.object_key))
          ),
        removeForProject: (projectId) => exec(sql`DELETE FROM attachments WHERE project_id = ${projectId}`)
      })
    })
  )
}
