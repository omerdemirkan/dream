/**
 * The `testflight_identity` table: the distribution signing identity Dream's TestFlight builds reuse, sealed with
 * the master key (see http/Testflight.ts). Decrypted only to release it to a granted build Mac.
 */
import { TestflightSigningIdentity } from "@dream/domain"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ApiConfig } from "../Config.ts"
import { makeSecretBox } from "../lib/SecretBox.ts"
import { decodeFirst, exec, jsonCodec, nowIso } from "./Sql.ts"

const Row = Schema.Struct({
  certificate_id: Schema.String,
  key_version: Schema.Int,
  wrapped_key: Schema.String,
  key_nonce: Schema.String,
  nonce: Schema.String,
  ciphertext: Schema.String
})

const name = "distribution"
const aad = (certificateId: string) => `dream-testflight-identity:v1:${name}:${certificateId}`
const codec = jsonCodec(TestflightSigningIdentity)

export class TestflightIdentity extends Context.Service<
  TestflightIdentity,
  {
    readonly get: Effect.Effect<Option.Option<TestflightSigningIdentity>>
    /** Stores `identity`, replacing the one before. */
    readonly put: (identity: TestflightSigningIdentity) => Effect.Effect<void>
  }
>()("@dream/api/TestflightIdentity") {
  static readonly layer = Layer.effect(
    TestflightIdentity,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const config = yield* ApiConfig
      const box = yield* makeSecretBox(Redacted.value(config.encryptionKey)).pipe(Effect.orDie)

      const get = Effect.gen(function* () {
        const row = yield* sql`SELECT * FROM testflight_identity WHERE name = ${name}`.pipe(decodeFirst(Row))
        if (row === undefined) return Option.none()
        const json = yield* box
          .open(
            {
              keyVersion: row.key_version,
              wrappedKey: row.wrapped_key,
              keyNonce: row.key_nonce,
              nonce: row.nonce,
              ciphertext: row.ciphertext
            },
            aad(row.certificate_id)
          )
          .pipe(Effect.orDie)
        return Option.some(yield* Schema.decodeEffect(codec)(json).pipe(Effect.orDie))
      }).pipe(Effect.withSpan("TestflightIdentity.get"))

      const put = Effect.fn("TestflightIdentity.put")(function* (identity: TestflightSigningIdentity) {
        const json = yield* Schema.encodeEffect(codec)(identity).pipe(Effect.orDie)
        const sealed = yield* box.seal(json, aad(identity.certificateId))
        const now = yield* nowIso
        yield* exec(sql`
          INSERT INTO testflight_identity (name, certificate_id, key_version, wrapped_key, key_nonce, nonce, ciphertext, created_at)
          VALUES (${name}, ${identity.certificateId}, ${sealed.keyVersion}, ${sealed.wrappedKey}, ${sealed.keyNonce},
            ${sealed.nonce}, ${sealed.ciphertext}, ${now})
          ON CONFLICT (name) DO UPDATE SET certificate_id = excluded.certificate_id, key_version = excluded.key_version,
            wrapped_key = excluded.wrapped_key, key_nonce = excluded.key_nonce, nonce = excluded.nonce,
            ciphertext = excluded.ciphertext, created_at = excluded.created_at`)
      })

      return TestflightIdentity.of({ get, put })
    })
  )
}
