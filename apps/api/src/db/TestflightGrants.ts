/**
 * The `testflight_grants` table: which Namespace build Mac may fetch the App Store Connect key, once, before
 * when (see http/Testflight.ts).
 */
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { exec, nowIso } from "./Sql.ts"

export class TestflightGrants extends Context.Service<
  TestflightGrants,
  {
    /** Lets `instanceId` fetch the key once until `expiresAtMs` (replacing an earlier grant for it). */
    readonly grant: (instanceId: string, expiresAtMs: number) => Effect.Effect<void>
    /** Uses up the grant for `instanceId`; false if there is none, it expired, or it was used. */
    readonly consume: (instanceId: string, nowMs: number) => Effect.Effect<boolean>
  }
>()("@dream/api/TestflightGrants") {
  static readonly layer = Layer.effect(
    TestflightGrants,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const grant = Effect.fn("TestflightGrants.grant")(function* (instanceId: string, expiresAtMs: number) {
        const now = yield* nowIso
        yield* exec(sql`DELETE FROM testflight_grants WHERE expires_at_ms < ${expiresAtMs - 86_400_000}`)
        yield* exec(sql`
          INSERT INTO testflight_grants (instance_id, expires_at_ms, created_at) VALUES (${instanceId}, ${expiresAtMs}, ${now})
          ON CONFLICT (instance_id) DO UPDATE SET expires_at_ms = excluded.expires_at_ms, used_at = NULL,
            created_at = excluded.created_at`)
      })

      const consume = Effect.fn("TestflightGrants.consume")(function* (instanceId: string, nowMs: number) {
        const now = yield* nowIso
        return yield* sql`UPDATE testflight_grants SET used_at = ${now}
            WHERE instance_id = ${instanceId} AND used_at IS NULL AND expires_at_ms > ${nowMs}
            RETURNING instance_id`.pipe(
          Effect.map((rows) => rows.length === 1),
          Effect.orDie
        )
      })

      return TestflightGrants.of({ grant, consume })
    })
  )
}
