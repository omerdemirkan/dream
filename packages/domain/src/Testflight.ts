/**
 * Releasing the App Store Connect key for Dream's own TestFlight builds to a Namespace build Mac
 * (`apps/mobile/scripts/testflight-namespace.ts` ↔ the Worker's `/testflight/asc-key`).
 *
 * The Mac generates an ephemeral P-256 ECDH key pair and asks Namespace for an ID token
 * (`nsc auth issue-id-token`) whose audience is `TestflightKeyAudience(publicKey)`, which binds the token to
 * that key. The Worker verifies the token against Namespace's JWKS, checks the tenant, a single-use grant
 * for the token's `instance_id` (`TestflightGrantRequest`, operator only) and that the Mac is the tenant's only
 * running instance, then returns the `.p8` encrypted to the Mac's key: ECDH with a fresh Worker key, HKDF-SHA256
 * (salt = Mac public key ‖ Worker public key, info `TestflightKeyInfo`), AES-256-GCM with the instance id as
 * additional data. The key is never in an env var, a command line or a log.
 */
import { Schema } from "effect"

/** Namespace's federation issuer (OIDC discovery at `/.well-known/openid-configuration`). */
export const NamespaceFederationIssuer = "https://federation.namespaceapis.com"

/** The ID token's audience for a Mac public key: `dream-testflight:` + base64url(SHA-256(raw public key)). */
export const TestflightKeyAudience = (publicKeySha256Base64Url: string) =>
  `dream-testflight:${publicKeySha256Base64Url}`

/** HKDF `info` for the key-wrapping key. */
export const TestflightKeyInfo = "dream-testflight-asc-key/v1"

/** POST `Routes.testflightKey`, JSON. */
export const TestflightKeyRequest = Schema.Struct({
  /** Namespace ID token minted on the Mac (short-lived; audience bound to `publicKey`). */
  idToken: Schema.RedactedFromValue(Schema.NonEmptyString),
  /** The Mac's ephemeral P-256 ECDH public key, raw (uncompressed, 65 bytes), base64url. */
  publicKey: Schema.NonEmptyString
})
export type TestflightKeyRequest = typeof TestflightKeyRequest.Type

/** 200 response to `TestflightKeyRequest`; every field base64url. */
export const TestflightKeyRelease = Schema.Struct({
  /** The Worker's ephemeral P-256 ECDH public key, raw. */
  serverPublicKey: Schema.NonEmptyString,
  /** AES-GCM nonce, 12 bytes. */
  iv: Schema.NonEmptyString,
  /** AES-256-GCM ciphertext and tag of the `.p8` (PEM text). */
  ciphertext: Schema.NonEmptyString,
  /**
   * The stored distribution signing identity, if there is one: a `TestflightSigningIdentity` as JSON, AES-256-GCM
   * with the same key, nonce `identityIv`, additional data `<instance id>:identity`.
   */
  identityIv: Schema.optionalKey(Schema.NonEmptyString),
  identityCiphertext: Schema.optionalKey(Schema.NonEmptyString)
})
export type TestflightKeyRelease = typeof TestflightKeyRelease.Type

/**
 * The Apple Distribution certificate Dream's builds sign with, and its private key. Created once on a build Mac
 * (through the App Store Connect API) and kept by the Worker, encrypted, so every build reuses it instead of
 * minting a new certificate (Apple allows only a few per team).
 */
export const TestflightSigningIdentity = Schema.Struct({
  /** App Store Connect certificate id. */
  certificateId: Schema.NonEmptyString,
  /** The certificate, DER, base64. */
  certificate: Schema.NonEmptyString,
  /** Its RSA private key, PKCS#8 PEM. */
  privateKey: Schema.RedactedFromValue(Schema.NonEmptyString)
})
export type TestflightSigningIdentity = typeof TestflightSigningIdentity.Type

/**
 * The ID token's audience for storing `identity`: `dream-testflight-identity:` + base64url(SHA-256 of
 * `${certificateId}\n${certificate}\n${privateKey}`), which binds the token to what it stores.
 */
export const TestflightIdentityAudience = (identitySha256Base64Url: string) =>
  `dream-testflight-identity:${identitySha256Base64Url}`

/** POST `Routes.testflightIdentity`, JSON, from the build Mac that was just released the key. */
export const TestflightIdentityUpload = Schema.Struct({
  idToken: Schema.RedactedFromValue(Schema.NonEmptyString),
  identity: TestflightSigningIdentity
})
export type TestflightIdentityUpload = typeof TestflightIdentityUpload.Type

/** POST `Routes.testflightGrant`, JSON, with the operator's `x-dream-dev-secret`: lets one Mac fetch the key once. */
export const TestflightGrantRequest = Schema.Struct({
  /** The Namespace instance id of the build Mac. */
  instanceId: Schema.String.check(Schema.isPattern(/^[a-z0-9]{8,32}$/))
})
export type TestflightGrantRequest = typeof TestflightGrantRequest.Type

/** One of the app's builds as App Store Connect reports it, in `TestflightBuilds`. */
export const TestflightBuild = Schema.Struct({
  /** The build number (`CFBundleVersion`). */
  build: Schema.String,
  uploadedAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** `PROCESSING`, `FAILED`, `INVALID` or `VALID`. */
  processing: Schema.String,
  expired: Schema.Boolean,
  /** TestFlight states, e.g. `IN_BETA_TESTING`, `READY_FOR_BETA_SUBMISSION`, `MISSING_EXPORT_COMPLIANCE`. */
  internalState: Schema.optionalKey(Schema.String),
  externalState: Schema.optionalKey(Schema.String)
})
export type TestflightBuild = typeof TestflightBuild.Type

/** A build anywhere on the account, so an upload under another bundle id shows too. */
export const TestflightAccountBuild = Schema.Struct({
  build: Schema.String,
  uploadedAt: Schema.optionalKey(Schema.DateTimeUtc),
  processing: Schema.String,
  bundleId: Schema.optionalKey(Schema.String)
})
export type TestflightAccountBuild = typeof TestflightAccountBuild.Type

/**
 * 200 response to GET `Routes.testflightBuilds` (operator, `x-dream-dev-secret`; `?bundleId=` defaults to Dream's):
 * the latest builds, read by the Worker with the App Store Connect key it holds. `app` is absent when the account
 * has no app record for the bundle id.
 */
export const TestflightBuilds = Schema.Struct({
  app: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String, bundleId: Schema.String })),
  builds: Schema.Array(TestflightBuild),
  accountBuilds: Schema.Array(TestflightAccountBuild)
})
export type TestflightBuilds = typeof TestflightBuilds.Type
