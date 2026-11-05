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
  ciphertext: Schema.NonEmptyString
})
export type TestflightKeyRelease = typeof TestflightKeyRelease.Type

/** POST `Routes.testflightGrant`, JSON, with the operator's `x-dream-dev-secret`: lets one Mac fetch the key once. */
export const TestflightGrantRequest = Schema.Struct({
  /** The Namespace instance id of the build Mac. */
  instanceId: Schema.String.check(Schema.isPattern(/^[a-z0-9]{8,32}$/))
})
export type TestflightGrantRequest = typeof TestflightGrantRequest.Type
