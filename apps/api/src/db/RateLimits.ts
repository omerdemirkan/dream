/**
 * Fixed-window counters (D1 `rate_limits`), for routes that call a rate-limited provider on the operator's behalf.
 * One UPSERT per hit, so concurrent requests in different isolates count against the same window.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { decodeFirst } from "./Sql.ts"

const CountRow = Schema.Struct({ count: Schema.Number })

export class RateLimits extends Context.Service<
  RateLimits,
  {
    /** Counts a hit on `key`; false when it's past `limit` hits in the current `windowMs` window. */
    readonly hit: (key: string, limit: number, windowMs: number, nowMs: number) => Effect.Effect<boolean>
  }
>()("@dream/api/RateLimits") {
  static readonly layer = Layer.effect(
    RateLimits,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const hit = Effect.fn("RateLimits.hit")(function* (key: string, limit: number, windowMs: number, nowMs: number) {
        const stale = nowMs - windowMs
        // SET expressions read the row's old values, so both CASEs see the same window start.
        const row = yield* sql`
          INSERT INTO rate_limits (key, window_start_ms, count) VALUES (${key}, ${nowMs}, 1)
          ON CONFLICT (key) DO UPDATE SET
            count = CASE WHEN window_start_ms <= ${stale} THEN 1 ELSE count + 1 END,
            window_start_ms = CASE WHEN window_start_ms <= ${stale} THEN excluded.window_start_ms ELSE window_start_ms END
          RETURNING count`.pipe(decodeFirst(CountRow))
        return row !== undefined && row.count <= limit
      })

      return RateLimits.of({ hit })
    })
  )
}
