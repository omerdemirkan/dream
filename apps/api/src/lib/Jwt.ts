/**
 * Compact JWTs over WebCrypto: HS256 for Dream's own tokens, ES256 for the
 * provider JWTs Dream mints (APNs, App Store Connect), and RS256 verification
 * for Google ID tokens; RS256 or ES256 against any JWKS (Namespace's federation tokens).
 */
import { Data, Effect, Option, Schema } from "effect"
import { fromBase64, fromBase64Url, fromUtf8, toBase64Url, utf8, type WebCryptoKey } from "./Bytes.ts"

export class JwtError extends Data.TaggedError("JwtError")<{ readonly reason: string }> {}

const Header = Schema.Struct({
  alg: Schema.String,
  kid: Schema.optionalKey(Schema.String),
  typ: Schema.optionalKey(Schema.String)
})

const encodeSegment = (value: unknown): string => toBase64Url(utf8(JSON.stringify(value)))

export interface DecodedJwt {
  readonly header: typeof Header.Type
  readonly payload: unknown
  readonly signingInput: string
  readonly signature: Uint8Array<ArrayBuffer>
}

/** Splits and parses a JWT without checking its signature. */
export const decodeUnverified = (token: string): Effect.Effect<DecodedJwt, JwtError> =>
  Effect.gen(function* () {
    const parts = token.split(".")
    if (parts.length !== 3) return yield* new JwtError({ reason: "malformed token" })
    const [h, p, s] = parts as [string, string, string]
    const parsed = yield* Effect.try({
      try: () => ({ header: JSON.parse(fromUtf8(fromBase64Url(h))), payload: JSON.parse(fromUtf8(fromBase64Url(p))) }),
      catch: () => new JwtError({ reason: "malformed token" })
    })
    const header = yield* Schema.decodeUnknownEffect(Header)(parsed.header).pipe(
      Effect.mapError(() => new JwtError({ reason: "malformed header" }))
    )
    const signature = yield* Effect.try({
      try: () => fromBase64Url(s),
      catch: () => new JwtError({ reason: "malformed signature" })
    })
    return { header, payload: parsed.payload, signingInput: `${h}.${p}`, signature }
  })

// ---------------------------------------------------------------------------
// HS256
// ---------------------------------------------------------------------------

export const importHmacKey = (secret: Uint8Array<ArrayBuffer>): Effect.Effect<WebCryptoKey> =>
  Effect.promise(() =>
    crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
  )

export const signHs256 = (key: WebCryptoKey, payload: object): Effect.Effect<string> =>
  Effect.gen(function* () {
    const signingInput = `${encodeSegment({ alg: "HS256", typ: "JWT" })}.${encodeSegment(payload)}`
    const signature = yield* Effect.promise(() => crypto.subtle.sign("HMAC", key, utf8(signingInput)))
    return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`
  })

/** Verifies an HS256 token and decodes its payload with `schema`. Expiry is the schema's or the caller's concern. */
export const verifyHs256 = <S extends Schema.Codec<any, any, never, never>>(
  key: WebCryptoKey,
  token: string,
  schema: S
): Effect.Effect<S["Type"], JwtError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeUnverified(token)
    if (decoded.header.alg !== "HS256") return yield* new JwtError({ reason: "unexpected algorithm" })
    const valid = yield* Effect.promise(() =>
      crypto.subtle.verify("HMAC", key, decoded.signature, utf8(decoded.signingInput))
    )
    if (!valid) return yield* new JwtError({ reason: "bad signature" })
    return yield* Schema.decodeUnknownEffect(schema)(decoded.payload).pipe(
      Effect.mapError(() => new JwtError({ reason: "unexpected claims" }))
    )
  })

// ---------------------------------------------------------------------------
// ES256 (APNs, App Store Connect)
// ---------------------------------------------------------------------------

/** Imports a PKCS#8 PEM (the contents of an AuthKey_XXXX.p8 file) as an ECDSA P-256 signing key. */
export const importEs256Pem = (pem: string): Effect.Effect<WebCryptoKey, JwtError> =>
  Effect.tryPromise({
    try: () => {
      const body = pem
        .replace(/-----BEGIN [A-Z ]+-----/g, "")
        .replace(/-----END [A-Z ]+-----/g, "")
        .replace(/\s+/g, "")
      return crypto.subtle.importKey("pkcs8", fromBase64(body), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
    },
    catch: () => new JwtError({ reason: "invalid ES256 private key" })
  })

export const signEs256 = (key: WebCryptoKey, header: object, payload: object): Effect.Effect<string> =>
  Effect.gen(function* () {
    const signingInput = `${encodeSegment({ alg: "ES256", ...header })}.${encodeSegment(payload)}`
    // WebCrypto returns the raw r||s form JWS wants.
    const signature = yield* Effect.promise(() =>
      crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput))
    )
    return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`
  })

// ---------------------------------------------------------------------------
// RS256 verification against a JWKS (Google)
// ---------------------------------------------------------------------------

export const Jwk = Schema.Struct({
  kid: Schema.String,
  kty: Schema.String,
  alg: Schema.optionalKey(Schema.String),
  n: Schema.String,
  e: Schema.String
})
export type Jwk = typeof Jwk.Type

export const Jwks = Schema.Struct({ keys: Schema.Array(Jwk) })
export type Jwks = typeof Jwks.Type

export const verifyRs256 = (token: string, jwks: Jwks): Effect.Effect<unknown, JwtError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeUnverified(token)
    if (decoded.header.alg !== "RS256") return yield* new JwtError({ reason: "unexpected algorithm" })
    const jwk = Option.fromUndefinedOr(jwks.keys.find((key) => key.kid === decoded.header.kid))
    if (Option.isNone(jwk)) return yield* new JwtError({ reason: "unknown signing key" })
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.value.n, e: jwk.value.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"]
        ),
      catch: () => new JwtError({ reason: "invalid signing key" })
    })
    const valid = yield* Effect.promise(() =>
      crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decoded.signature, utf8(decoded.signingInput))
    )
    if (!valid) return yield* new JwtError({ reason: "bad signature" })
    return decoded.payload
  })

// ---------------------------------------------------------------------------
// RS256 or ES256 against a JWKS with either kind of key (Namespace federation)
// ---------------------------------------------------------------------------

export const AnyJwk = Schema.Struct({
  kid: Schema.String,
  kty: Schema.Literals(["RSA", "EC"]),
  n: Schema.optionalKey(Schema.String),
  e: Schema.optionalKey(Schema.String),
  crv: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.String),
  y: Schema.optionalKey(Schema.String)
})
export const AnyJwks = Schema.Struct({ keys: Schema.Array(Schema.Unknown) })
export type AnyJwk = typeof AnyJwk.Type

/** Verifies an RS256 or ES256 (P-256) token with the JWKS key its `kid` names; returns the unchecked payload. */
export const verifyJwt = (token: string, keys: ReadonlyArray<AnyJwk>): Effect.Effect<unknown, JwtError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeUnverified(token)
    const jwk = keys.find((key) => key.kid === decoded.header.kid)
    if (jwk === undefined) return yield* new JwtError({ reason: "unknown signing key" })
    const algorithm =
      decoded.header.alg === "RS256" && jwk.kty === "RSA" && jwk.n !== undefined && jwk.e !== undefined
        ? {
            import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            verify: { name: "RSASSA-PKCS1-v1_5" },
            jwk: { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }
          }
        : decoded.header.alg === "ES256" &&
            jwk.kty === "EC" &&
            jwk.crv === "P-256" &&
            jwk.x !== undefined &&
            jwk.y !== undefined
          ? {
              import: { name: "ECDSA", namedCurve: "P-256" },
              verify: { name: "ECDSA", hash: "SHA-256" },
              jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true }
            }
          : undefined
    if (algorithm === undefined) return yield* new JwtError({ reason: "unexpected algorithm" })
    const key = yield* Effect.tryPromise({
      try: () => crypto.subtle.importKey("jwk", algorithm.jwk, algorithm.import, false, ["verify"]),
      catch: () => new JwtError({ reason: "invalid signing key" })
    })
    const valid = yield* Effect.tryPromise({
      try: () => crypto.subtle.verify(algorithm.verify, key, decoded.signature, utf8(decoded.signingInput)),
      catch: () => new JwtError({ reason: "bad signature" })
    })
    if (!valid) return yield* new JwtError({ reason: "bad signature" })
    return decoded.payload
  })
