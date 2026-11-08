/**
 * What projects made through the gateway that OpenAI keeps (D1 `openai_objects`): stored responses, WebRTC calls
 * and GPT-Live sessions, by OpenAI's id. A read, cancel or hang-up of one is forwarded only for the project that
 * made it. Background responses are remembered until something metered them, so the sweep can (`Gateway.ts`).
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { decodeFirst, decodeRows, exec } from "../db/Sql.ts"

export const ObjectKind = Schema.Literals(["response", "call", "live"])
export type ObjectKind = typeof ObjectKind.Type

const ObjectRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  owner_id: Schema.String,
  kind: ObjectKind,
  created_at_ms: Schema.Number
})
export type ObjectRow = typeof ObjectRow.Type

export class OpenAIObjects extends Context.Service<
  OpenAIObjects,
  {
    readonly record: (row: {
      readonly id: string
      readonly projectId: string
      readonly ownerId: string
      readonly kind: ObjectKind
      readonly background: boolean
      readonly nowMs: number
    }) => Effect.Effect<void>
    /** The project that made `id`, if one did through the gateway. */
    readonly projectOf: (id: string) => Effect.Effect<Option.Option<string>>
    readonly markMetered: (id: string) => Effect.Effect<void>
    /** Background responses nobody has metered yet, made between `fromMs` and `toMs`. */
    readonly unmetered: (fromMs: number, toMs: number, limit: number) => Effect.Effect<ReadonlyArray<ObjectRow>>
    /** Forgets what was made before `beforeMs` (OpenAI keeps responses 30 days). */
    readonly prune: (beforeMs: number) => Effect.Effect<void>
  }
>()("@dream/api/openai/OpenAIObjects") {
  static readonly layer = Layer.effect(
    OpenAIObjects,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return OpenAIObjects.of({
        record: (row) =>
          exec(sql`
            INSERT INTO openai_objects (id, project_id, owner_id, kind, background, metered, created_at_ms)
            VALUES (${row.id}, ${row.projectId}, ${row.ownerId}, ${row.kind}, ${row.background ? 1 : 0},
              0, ${row.nowMs})
            ON CONFLICT (id) DO NOTHING`),
        projectOf: (id) =>
          sql`SELECT project_id FROM openai_objects WHERE id = ${id}`.pipe(
            decodeFirst(Schema.Struct({ project_id: Schema.String })),
            Effect.map((row) => Option.map(Option.fromNullishOr(row), (r) => r.project_id))
          ),
        markMetered: (id) => exec(sql`UPDATE openai_objects SET metered = 1 WHERE id = ${id}`),
        unmetered: (fromMs, toMs, limit) =>
          sql`
            SELECT id, project_id, owner_id, kind, created_at_ms FROM openai_objects
            WHERE background = 1 AND metered = 0 AND created_at_ms >= ${fromMs} AND created_at_ms < ${toMs}
            ORDER BY created_at_ms LIMIT ${limit}`.pipe(decodeRows(ObjectRow)),
        prune: (beforeMs) => exec(sql`DELETE FROM openai_objects WHERE created_at_ms < ${beforeMs}`)
      })
    })
  )
}
