/**
 * The `secrets` table: user credentials, AES-GCM envelope encrypted with the
 * master key from `DREAM_ENCRYPTION_KEY`. Values are decrypted only here,
 * inside the Worker, and only when something needs to send them (E2B egress
 * rules, token refreshes).
 */
import { type UserId } from "@dream/domain"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ApiConfig } from "../Config.ts"
import { newSecretId } from "../lib/Ids.ts"
import { makeSecretBox } from "../lib/SecretBox.ts"
import { decodeFirst, exec, jsonCodec, nowIso } from "./Sql.ts"

export const SecretKind = Schema.Literals([
  "claude_token",
  "chatgpt_tokens",
  "google_oauth",
  "api_key",
  "apple_asc",
  "sandbox_file",
  "auth_session"
])
export type SecretKind = typeof SecretKind.Type

const SecretRow = Schema.Struct({
  id: Schema.String,
  owner_id: Schema.String,
  kind: SecretKind,
  key_version: Schema.Int,
  wrapped_key: Schema.String,
  key_nonce: Schema.String,
  nonce: Schema.String,
  ciphertext: Schema.String
})

const aad = (id: string, ownerId: string, kind: SecretKind) => `dream-secret:v1:${id}:${ownerId}:${kind}`

export class Secrets extends Context.Service<
  Secrets,
  {
    /** Encrypts and stores `value` (JSON-encoded with `schema`); returns the secret id. */
    readonly put: <S extends Schema.Top>(
      ownerId: UserId,
      kind: SecretKind,
      schema: S,
      value: S["Type"]
    ) => Effect.Effect<string>
    readonly replace: <S extends Schema.Top>(id: string, schema: S, value: S["Type"]) => Effect.Effect<void>
    /** Decrypts a secret. A missing or undecryptable secret is a defect. */
    readonly get: <S extends Schema.Top>(id: string, schema: S) => Effect.Effect<S["Type"]>
    readonly remove: (id: string) => Effect.Effect<void>
  }
>()("@dream/api/Secrets") {
  static readonly layer = Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const config = yield* ApiConfig
      const box = yield* makeSecretBox(Redacted.value(config.encryptionKey)).pipe(Effect.orDie)

      const encode = <S extends Schema.Top>(schema: S, value: S["Type"]) =>
        Schema.encodeEffect(jsonCodec(schema))(value).pipe(Effect.orDie)

      const put = <S extends Schema.Top>(ownerId: UserId, kind: SecretKind, schema: S, value: S["Type"]) =>
        Effect.gen(function* () {
          const id = yield* newSecretId()
          const sealed = yield* box.seal(yield* encode(schema, value), aad(id, ownerId, kind))
          const now = yield* nowIso
          yield* exec(sql`
            INSERT INTO secrets (id, owner_id, kind, key_version, wrapped_key, key_nonce, nonce, ciphertext, created_at, updated_at)
            VALUES (${id}, ${ownerId}, ${kind}, ${sealed.keyVersion}, ${sealed.wrappedKey}, ${sealed.keyNonce},
                    ${sealed.nonce}, ${sealed.ciphertext}, ${now}, ${now})`)
          return id
        }).pipe(Effect.withSpan("Secrets.put", { attributes: { kind } }))

      const row = (id: string) =>
        sql`SELECT * FROM secrets WHERE id = ${id}`.pipe(
          decodeFirst(SecretRow),
          Effect.flatMap((found) =>
            found === undefined ? Effect.die(`secret ${id} is missing`) : Effect.succeed(found)
          )
        )

      const replace = <S extends Schema.Top>(id: string, schema: S, value: S["Type"]) =>
        Effect.gen(function* () {
          const existing = yield* row(id)
          const sealed = yield* box.seal(yield* encode(schema, value), aad(id, existing.owner_id, existing.kind))
          const now = yield* nowIso
          yield* exec(sql`
            UPDATE secrets SET key_version = ${sealed.keyVersion}, wrapped_key = ${sealed.wrappedKey},
              key_nonce = ${sealed.keyNonce}, nonce = ${sealed.nonce}, ciphertext = ${sealed.ciphertext}, updated_at = ${now}
            WHERE id = ${id}`)
        }).pipe(Effect.withSpan("Secrets.replace"))

      const get = <S extends Schema.Top>(id: string, schema: S) =>
        Effect.gen(function* () {
          const found = yield* row(id)
          const plaintext = yield* box
            .open(
              {
                keyVersion: found.key_version,
                wrappedKey: found.wrapped_key,
                keyNonce: found.key_nonce,
                nonce: found.nonce,
                ciphertext: found.ciphertext
              },
              aad(found.id, found.owner_id, found.kind)
            )
            .pipe(Effect.orDie)
          return yield* Schema.decodeUnknownEffect(jsonCodec(schema))(plaintext).pipe(Effect.orDie)
        }).pipe(Effect.withSpan("Secrets.get"))

      const remove = (id: string) => exec(sql`DELETE FROM secrets WHERE id = ${id}`)

      return Secrets.of({ put, replace, get, remove })
    })
  )
}
