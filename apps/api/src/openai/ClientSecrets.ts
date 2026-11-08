/**
 * Realtime client secrets, wrapped. A browser starts a WebRTC call with a short-lived secret its app's server minted
 * (`POST /v1/realtime/client_secrets`). Handed OpenAI's `ek_…` as it is, the browser could start the call with OpenAI
 * directly, where the gateway can't see it, so the app gets a Dream secret instead: OpenAI's, sealed with who it's
 * for, which only the gateway can open, at `POST /v1/realtime/calls` (or a browser's realtime WebSocket). It
 * expires when OpenAI's does. Nothing is stored.
 */
import { Context, Data, Effect, Layer, Redacted, Schema } from "effect"
import { ApiConfig } from "../Config.ts"
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "../lib/Bytes.ts"
import { makeSecretBox } from "../lib/SecretBox.ts"

export const WrappedPrefix = "dream_ek_"
const AdditionalData = "openai-client-secret"

export const ClientSecretClaims = Schema.Struct({
  /** OpenAI's `ek_…`. */
  secret: Schema.String,
  projectId: Schema.String,
  userId: Schema.String,
  model: Schema.optionalKey(Schema.String),
  /** Unix seconds, OpenAI's `expires_at`. */
  expiresAt: Schema.Number
})
export type ClientSecretClaims = typeof ClientSecretClaims.Type

const Sealed = Schema.Struct({
  keyVersion: Schema.Number,
  wrappedKey: Schema.String,
  keyNonce: Schema.String,
  nonce: Schema.String,
  ciphertext: Schema.String
})
const SealedJson = Schema.fromJsonString(Sealed)
const ClaimsJson = Schema.fromJsonString(ClientSecretClaims)

export class InvalidClientSecret extends Data.TaggedError("InvalidClientSecret")<{ readonly reason: string }> {}

export class ClientSecrets extends Context.Service<
  ClientSecrets,
  {
    readonly wrap: (claims: ClientSecretClaims) => Effect.Effect<string>
    /** The claims of a wrapped secret that hasn't expired at `nowMs`. */
    readonly unwrap: (wrapped: string, nowMs: number) => Effect.Effect<ClientSecretClaims, InvalidClientSecret>
  }
>()("@dream/api/openai/ClientSecrets") {
  static readonly layer = Layer.effect(
    ClientSecrets,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const box = yield* makeSecretBox(Redacted.value(config.encryptionKey)).pipe(Effect.orDie)
      const invalid = (reason: string) => new InvalidClientSecret({ reason })

      return ClientSecrets.of({
        wrap: (claims) =>
          Effect.map(
            box.seal(Schema.encodeSync(ClaimsJson)(claims), AdditionalData),
            (sealed) => `${WrappedPrefix}${toBase64Url(utf8(Schema.encodeSync(SealedJson)(sealed)))}`
          ),
        unwrap: (wrapped, nowMs) =>
          Effect.gen(function* () {
            if (!wrapped.startsWith(WrappedPrefix)) return yield* invalid("not a Dream client secret")
            const sealed = yield* Effect.try({
              try: () => fromUtf8(fromBase64Url(wrapped.slice(WrappedPrefix.length))),
              catch: () => invalid("malformed")
            }).pipe(
              Effect.flatMap((json) =>
                Schema.decodeUnknownEffect(SealedJson)(json).pipe(Effect.mapError(() => invalid("malformed")))
              )
            )
            const plaintext = yield* box.open(sealed, AdditionalData).pipe(Effect.mapError(() => invalid("forged")))
            const claims = yield* Schema.decodeUnknownEffect(ClaimsJson)(plaintext).pipe(
              Effect.mapError(() => invalid("malformed"))
            )
            if (claims.expiresAt * 1000 <= nowMs) return yield* invalid("expired")
            return claims
          })
      })
    })
  )
}
