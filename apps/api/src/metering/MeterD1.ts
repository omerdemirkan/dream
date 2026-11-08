/**
 * Today's sink for `Meter`: the `meter_events` table in D1, one row per event, priced from the price book as it's
 * recorded so the app can sum estimates. Rows are never updated; a second event with a known id is dropped.
 */
import { DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { decodeRows, exec, nowIso } from "../db/Sql.ts"
import { Meter, type MeterEvent } from "./Meter.ts"
import { PriceBook, price } from "./Prices.ts"

/** D1 binds at most 100 parameters to a statement. */
const IdChunk = 90

const chunks = <A>(all: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> =>
  Array.from({ length: Math.ceil(all.length / size) }, (_, i) => all.slice(i * size, (i + 1) * size))

export const MeterD1 = Layer.effect(
  Meter,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const known = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const found = new Set<string>()
        for (const chunk of chunks(ids, IdChunk)) {
          const rows = yield* sql`SELECT id FROM meter_events WHERE ${sql.in("id", chunk)}`.pipe(
            decodeRows(Schema.Struct({ id: Schema.String }))
          )
          for (const row of rows) found.add(row.id)
        }
        return found
      })

    const insert = (event: MeterEvent, recordedAt: string) =>
      Effect.gen(function* () {
        const priced = price(event)
        if (priced.unknownModel !== undefined) {
          yield* Effect.logWarning("metered an OpenAI model the price book doesn't know, at $0", {
            model: priced.unknownModel,
            id: event.id
          })
        }
        yield* exec(sql`
          INSERT INTO meter_events (id, owner, meter, at, project_id, quantities_json, dimensions_json, center, payer,
            cost_usd, units, price_book, recorded_at)
          VALUES (${event.id}, ${event.owner}, ${event.meter}, ${DateTime.formatIso(event.at)},
            ${event.dimensions.project ?? null}, ${JSON.stringify(event.quantities)},
            ${JSON.stringify(event.dimensions)}, ${priced.center}, ${priced.payer}, ${priced.usd}, ${priced.units},
            ${PriceBook}, ${recordedAt})
          ON CONFLICT (id) DO NOTHING`)
      })

    const record = (events: ReadonlyArray<MeterEvent>) =>
      Effect.gen(function* () {
        if (events.length === 0) return
        const seen = yield* known(events.map((event) => event.id))
        const recordedAt = yield* nowIso
        for (const event of events) {
          if (seen.has(event.id)) continue
          seen.add(event.id)
          yield* insert(event, recordedAt)
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("couldn't record meter events", { count: events.length }, cause)),
        Effect.withSpan("Meter.record", { attributes: { count: events.length } })
      )

    return Meter.of({ record })
  })
)
