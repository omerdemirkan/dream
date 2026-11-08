/**
 * What projects made through the gateway that OpenAI keeps (D1 `openai_objects`): stored responses, WebRTC calls
 * and GPT-Live sessions, by OpenAI's id. A read, cancel or hang-up of one is forwarded only for the project that
 * made it. A stored response is remembered as unmetered until something meters it (its stream's end, a poll, or
 * the sweep in `Gateway.ts`, which looks each one up at its `next_check_ms`).
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
  attempts: Schema.Number,
  created_at_ms: Schema.Number
})
export type ObjectRow = typeof ObjectRow.Type

export const RecordedEvent = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  at: Schema.String,
  quantities_json: Schema.String,
  dimensions_json: Schema.String,
  cost_usd: Schema.Number
})
export type RecordedEvent = typeof RecordedEvent.Type

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
      /** When the sweep first looks, if nothing metered it by then. */
      readonly firstCheckMs: number
    }) => Effect.Effect<void>
    /** The project that made `id`, if one did through the gateway. */
    readonly projectOf: (id: string) => Effect.Effect<Option.Option<string>>
    readonly markMetered: (id: string) => Effect.Effect<void>
    /** The sweep stops looking for this one. */
    readonly giveUp: (id: string) => Effect.Effect<void>
    /** Looks again at `nextCheckMs`. */
    readonly checkLater: (id: string, nextCheckMs: number) => Effect.Effect<void>
    /** Stored responses nobody has metered yet that are due a look at `nowMs`, the longest-waiting first. */
    readonly due: (nowMs: number, limit: number) => Effect.Effect<ReadonlyArray<ObjectRow>>
    /** Forgets what was made before `beforeMs` (OpenAI keeps responses 30 days). */
    readonly prune: (beforeMs: number) => Effect.Effect<void>
    /** What the ledger recorded for a project's model calls (`meter_events`), for the dev pseudo-projects' checks. */
    readonly recorded: (projectId: string) => Effect.Effect<ReadonlyArray<RecordedEvent>>
  }
>()("@dream/api/openai/OpenAIObjects") {
  static readonly layer = Layer.effect(
    OpenAIObjects,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return OpenAIObjects.of({
        record: (row) =>
          exec(sql`
            INSERT INTO openai_objects
              (id, project_id, owner_id, kind, background, metered, attempts, next_check_ms, created_at_ms)
            VALUES (${row.id}, ${row.projectId}, ${row.ownerId}, ${row.kind}, ${row.background ? 1 : 0},
              ${row.kind === "response" ? 0 : 1}, 0, ${row.firstCheckMs}, ${row.nowMs})
            ON CONFLICT (id) DO NOTHING`),
        projectOf: (id) =>
          sql`SELECT project_id FROM openai_objects WHERE id = ${id}`.pipe(
            decodeFirst(Schema.Struct({ project_id: Schema.String })),
            Effect.map((row) => Option.map(Option.fromNullishOr(row), (r) => r.project_id))
          ),
        markMetered: (id) => exec(sql`UPDATE openai_objects SET metered = 1 WHERE id = ${id}`),
        giveUp: (id) => exec(sql`UPDATE openai_objects SET metered = 2 WHERE id = ${id}`),
        checkLater: (id, nextCheckMs) =>
          exec(sql`UPDATE openai_objects SET attempts = attempts + 1, next_check_ms = ${nextCheckMs} WHERE id = ${id}`),
        due: (nowMs, limit) =>
          sql`
            SELECT id, project_id, owner_id, kind, attempts, created_at_ms FROM openai_objects
            WHERE metered = 0 AND kind = 'response' AND next_check_ms <= ${nowMs}
            ORDER BY next_check_ms LIMIT ${limit}`.pipe(decodeRows(ObjectRow)),
        prune: (beforeMs) => exec(sql`DELETE FROM openai_objects WHERE created_at_ms < ${beforeMs}`),
        recorded: (projectId) =>
          sql`
            SELECT id, owner, at, quantities_json, dimensions_json, cost_usd FROM meter_events
            WHERE meter = 'model_request' AND project_id = ${projectId} ORDER BY at`.pipe(decodeRows(RecordedEvent))
      })
    })
  )
}
