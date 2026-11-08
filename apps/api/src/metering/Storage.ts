/**
 * R2 storage in the ledger: once a UTC day has ended, each project's stored bytes (its media and the attachments
 * sent to it, as uploaded) become one `storage_day` for that day. Runs with the hourly metering; the id is per
 * project and day, so the first run after midnight records it and the rest record nothing.
 *
 * The bytes are read from D1's records of what was uploaded rather than by listing the bucket, which is what each
 * object's row says it holds. The updates bucket (the app's own releases) is Dream's and not metered.
 */
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { decodeRows } from "../db/Sql.ts"
import { Meter, type MeterEvent } from "./Meter.ts"

const StoredRow = Schema.Struct({ project_id: Schema.String, user_id: Schema.String, bytes: Schema.Finite })

const recordDay = (sql: SqlClient.SqlClient, meter: Meter["Service"]) =>
  Effect.gen(function* () {
    const today = DateTime.startOf(yield* DateTime.now, "day")
    const day = DateTime.formatIsoDate(DateTime.subtract(today, { days: 1 }))
    const rows = yield* sql`
    SELECT project_id, user_id, SUM(COALESCE(json_extract(ref_json, '$.sizeBytes'), 0)) AS bytes FROM (
      SELECT project_id, user_id, ref_json FROM media WHERE uploaded_at IS NOT NULL
      UNION ALL
      SELECT project_id, user_id, ref_json FROM attachments WHERE uploaded_at IS NOT NULL AND project_id IS NOT NULL
    ) GROUP BY project_id, user_id`.pipe(decodeRows(StoredRow))
    // The day's end: the gauge's reading stands for the whole day just finished.
    const at = DateTime.subtract(today, { milliseconds: 1 })
    yield* meter.record(
      rows
        .filter((row) => row.bytes > 0)
        .map(
          (row): MeterEvent => ({
            id: `r2:${row.project_id}:${day}`,
            owner: row.user_id,
            meter: "storage_day",
            at,
            quantities: { bytes: row.bytes },
            dimensions: { project: row.project_id, payer: "dream", provider: "r2" }
          })
        )
    )
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("couldn't record storage", cause)),
    Effect.withSpan("StorageMeter.recordDay")
  )

export class StorageMeter extends Context.Service<
  StorageMeter,
  {
    /** Records yesterday's `storage_day` for every project with something stored. */
    readonly recordDay: Effect.Effect<void>
  }
>()("@dream/api/metering/StorageMeter") {
  static readonly layer = Layer.effect(
    StorageMeter,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const meter = yield* Meter
      return StorageMeter.of({ recordDay: recordDay(sql, meter) })
    })
  )
}
