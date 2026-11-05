/**
 * Releases the App Store Connect key for Dream's own TestFlight builds (`ASC_TESTFLIGHT_KEY_P8`, set by the
 * founder in the dashboard) to a Namespace build Mac, encrypted to a key the Mac generated, so it never sits
 * in an env var, a command line or a log. The protocol is in `@dream/domain` (Testflight.ts).
 *
 * Every Namespace instance of the tenant can mint ID tokens with any audience, and with `instance/*`
 * permissions it can also reach the other instances, so a valid token alone proves little. The key is
 * released only when all of these hold:
 * - the ID token verifies against Namespace's JWKS, is from our tenant, unexpired and short-lived, and its
 *   audience binds it to the public key in the request;
 * - the operator granted that instance id (`grantAscKey`, behind DEV_LOGIN_SECRET) within the last
 *   15 minutes, and the grant hasn't been used;
 * - the Mac is RUNNING, labeled `dream=testflight`, and the tenant's only instance (Namespace's own listing,
 *   through the Worker's token), so no other Mac, an agent's included, is up to reach it.
 *
 * The release also carries the distribution signing identity (certificate and private key) the builds reuse, if
 * one is stored. The first build Mac creates it and stores it with `storeSigningIdentity`, under the same checks
 * except that its grant must have been used in the last 30 minutes (it was just released the key).
 */
import {
  TestflightGrantRequest,
  TestflightIdentityAudience,
  TestflightIdentityUpload,
  TestflightKeyAudience,
  TestflightKeyInfo,
  type TestflightKeyRelease,
  TestflightKeyRequest,
  TestflightSigningIdentity,
  UpstreamFailure
} from "@dream/domain"
import { Data, DateTime, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Namespace } from "../brokers/Namespace.ts"
import { ApiConfig, required } from "../Config.ts"
import { jsonCodec } from "../db/Sql.ts"
import { TestflightGrants } from "../db/TestflightGrants.ts"
import { TestflightIdentity } from "../db/TestflightIdentity.ts"
import { describe, okOrFail } from "../e2b/E2B.ts"
import { fromBase64Url, randomBytes, toBase64Url, utf8 } from "../lib/Bytes.ts"
import { AnyJwk, AnyJwks, verifyJwt } from "../lib/Jwt.ts"

export class TestflightDenied extends Data.TaggedError("TestflightDenied")<{ readonly reason: string }> {}

/** How long a grant lasts, and the longest ID token lifetime accepted. */
export const grantTtlMs = 15 * 60_000
const maxTokenLifetimeSec = 15 * 60
const skewSec = 60

const Claims = Schema.Struct({
  iss: Schema.String,
  sub: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Number,
  iat: Schema.Number,
  nbf: Schema.optionalKey(Schema.Number),
  tenant_id: Schema.String,
  instance_id: Schema.String
})

const deny = (reason: string) => Effect.fail(new TestflightDenied({ reason }))

const sha256 = (bytes: Uint8Array<ArrayBuffer>) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(Effect.map((d) => new Uint8Array(d)))

/** A raw uncompressed P-256 public key (65 bytes, 0x04 ‖ x ‖ y). */
export const decodePublicKey = (publicKey: string): Effect.Effect<Uint8Array<ArrayBuffer>, TestflightDenied> =>
  Effect.try({
    try: () => fromBase64Url(publicKey),
    catch: () => new TestflightDenied({ reason: "bad public key" })
  }).pipe(
    Effect.filterOrFail(
      (bytes) => bytes.length === 65 && bytes[0] === 4,
      () => new TestflightDenied({ reason: "bad public key" })
    )
  )

/** The audience binding a key-release token to `publicKey`. */
export const keyAudience = (publicKey: Uint8Array<ArrayBuffer>) =>
  sha256(publicKey).pipe(Effect.map((digest) => TestflightKeyAudience(toBase64Url(digest))))

/** The audience binding an identity-upload token to `identity`. */
export const identityAudience = (identity: TestflightSigningIdentity) =>
  sha256(utf8(`${identity.certificateId}\n${identity.certificate}\n${Redacted.value(identity.privateKey)}`)).pipe(
    Effect.map((digest) => TestflightIdentityAudience(toBase64Url(digest)))
  )

/** Checks a Namespace ID token for a build Mac of `tenantId` issued for `audience`; returns its instance id. */
export const verifyBuildMacToken = (
  idToken: string,
  audience: string,
  keys: ReadonlyArray<AnyJwk>,
  options: { readonly issuer: string; readonly tenantId: string; readonly nowSec: number }
): Effect.Effect<string, TestflightDenied> =>
  Effect.gen(function* () {
    const payload = yield* verifyJwt(idToken, keys).pipe(
      Effect.mapError((e) => new TestflightDenied({ reason: `ID token: ${e.reason}` }))
    )
    const claims = yield* Schema.decodeUnknownEffect(Claims)(payload).pipe(
      Effect.mapError(() => new TestflightDenied({ reason: "ID token: unexpected claims" }))
    )
    const { nowSec } = options
    if (claims.iss !== options.issuer) return yield* deny("ID token: wrong issuer")
    if (claims.tenant_id !== options.tenantId || claims.sub !== `${options.tenantId}/${claims.instance_id}`)
      return yield* deny("ID token: another workspace")
    const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud
    if (!audiences.includes(audience)) return yield* deny("ID token: not bound to this request")
    if (claims.exp <= nowSec || (claims.nbf ?? claims.iat) > nowSec + skewSec) return yield* deny("ID token: expired")
    if (claims.exp - claims.iat > maxTokenLifetimeSec) return yield* deny("ID token: lives too long")
    return claims.instance_id
  })

type EcdhPair = { readonly privateKey: CryptoKey; readonly publicKey: CryptoKey }
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>

/**
 * Encrypts `plaintext` to the Mac's ECDH public key: a fresh Worker key pair, HKDF-SHA256 over the shared
 * secret (salt = Mac key ‖ Worker key, info `TestflightKeyInfo`), AES-256-GCM with the instance id as AAD.
 * `identity` (JSON) is encrypted with the same key under its own nonce, AAD `<instance id>:identity`.
 */
export const sealForMac = (
  macPublicKey: Uint8Array<ArrayBuffer>,
  instanceId: string,
  plaintext: string,
  identity?: string
): Effect.Effect<TestflightKeyRelease, TestflightDenied> =>
  Effect.tryPromise({
    try: async () => {
      const subtle = crypto.subtle
      const mac = await subtle.importKey("raw", macPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, [])
      const pair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits"
      ])) as unknown as EcdhPair
      const shared = await subtle.deriveBits({ name: "ECDH", public: mac } as any, pair.privateKey, 256)
      const server = new Uint8Array((await subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer)
      const salt = new Uint8Array(macPublicKey.length + server.length)
      salt.set(macPublicKey)
      salt.set(server, macPublicKey.length)
      const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"])
      const aes = await subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info: utf8(TestflightKeyInfo) },
        hkdf,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"]
      )
      const iv = randomBytes(12)
      const ciphertext = await subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: utf8(instanceId) },
        aes,
        utf8(plaintext)
      )
      const release: TestflightKeyRelease = {
        serverPublicKey: toBase64Url(server),
        iv: toBase64Url(iv),
        ciphertext: toBase64Url(new Uint8Array(ciphertext))
      }
      if (identity === undefined) return release
      const identityIv = randomBytes(12)
      const sealed = await subtle.encrypt(
        { name: "AES-GCM", iv: identityIv, additionalData: utf8(`${instanceId}:identity`) },
        aes,
        utf8(identity)
      )
      return {
        ...release,
        identityIv: toBase64Url(identityIv),
        identityCiphertext: toBase64Url(new Uint8Array(sealed))
      }
    },
    catch: () => new TestflightDenied({ reason: "bad public key" })
  })

const fetchJwks = Effect.gen(function* () {
  const config = yield* ApiConfig
  const http = yield* HttpClient.HttpClient
  const jwks = yield* HttpClientRequest.get(`${config.namespaceFederationUrl}/.well-known/jwks.json`).pipe(
    http.execute,
    Effect.flatMap(okOrFail),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(AnyJwks)),
    Effect.mapError(
      (cause) => new UpstreamFailure({ service: "Namespace", message: `Reading the JWKS failed: ${describe(cause)}` })
    )
  )
  return jwks.keys.flatMap((key) => Option.toArray(Schema.decodeUnknownOption(AnyJwk)(key)))
})

/** Verifies the token and that its Mac is a running build Mac and the tenant's only instance. */
const buildMac = (idToken: string, audience: string) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const namespace = yield* Namespace
    const now = yield* DateTime.now
    const instanceId = yield* verifyBuildMacToken(idToken, audience, yield* fetchJwks, {
      issuer: config.namespaceFederationUrl,
      tenantId: config.namespaceTenantId,
      nowSec: Math.floor(DateTime.toEpochMillis(now) / 1000)
    })
    const instances = yield* namespace.list
    const self = instances.find((i) => i.instanceId === instanceId)
    if (self?.status !== "RUNNING" || self.labels?.dream !== "testflight") return yield* deny("not a running build Mac")
    if (instances.some((i) => i.instanceId !== instanceId && i.status !== "DESTROYED"))
      return yield* deny("another instance is running")
    return { instanceId, nowMs: DateTime.toEpochMillis(now) }
  })

/** `Routes.testflightKey`: a granted build Mac gets the `.p8` (and the signing identity), encrypted to its key. */
export const releaseAscKey = Effect.fn("Testflight.releaseAscKey")(function* (body: unknown) {
  const config = yield* ApiConfig
  const grants = yield* TestflightGrants
  const identities = yield* TestflightIdentity
  const pem = yield* required(config.ascTestflightKey, "App Store Connect", "ASC_TESTFLIGHT_KEY_P8")
  const request = yield* Schema.decodeUnknownEffect(TestflightKeyRequest)(body).pipe(
    Effect.mapError(() => new TestflightDenied({ reason: "malformed request" }))
  )
  const publicKey = yield* decodePublicKey(request.publicKey)
  const { instanceId, nowMs } = yield* buildMac(Redacted.value(request.idToken), yield* keyAudience(publicKey))
  if (!(yield* grants.consume(instanceId, nowMs))) return yield* deny("no grant")
  const identity = yield* identities.get
  const identityJson = Option.isSome(identity)
    ? yield* Schema.encodeEffect(jsonCodec(TestflightSigningIdentity))(identity.value).pipe(Effect.orDie)
    : undefined
  yield* Effect.logInfo("released the App Store Connect key to a build Mac", {
    instanceId,
    withIdentity: identityJson !== undefined
  })
  return yield* sealForMac(publicKey, instanceId, Redacted.value(pem), identityJson)
})

/** How recently a Mac must have been released the key to store a signing identity. */
const identityWindowMs = 30 * 60_000

/** `Routes.testflightIdentity`: the build Mac that was just released the key stores the identity it created. */
export const storeSigningIdentity = Effect.fn("Testflight.storeSigningIdentity")(function* (body: unknown) {
  const grants = yield* TestflightGrants
  const identities = yield* TestflightIdentity
  const upload = yield* Schema.decodeUnknownEffect(TestflightIdentityUpload)(body).pipe(
    Effect.mapError(() => new TestflightDenied({ reason: "malformed request" }))
  )
  const { identity } = upload
  if (
    !/^[A-Z0-9]{6,20}$/.test(identity.certificateId) ||
    identity.certificate.length > 16_384 ||
    !Redacted.value(identity.privateKey).includes("-----BEGIN PRIVATE KEY-----")
  )
    return yield* deny("malformed identity")
  const { instanceId, nowMs } = yield* buildMac(Redacted.value(upload.idToken), yield* identityAudience(identity))
  if (!(yield* grants.usedSince(instanceId, nowMs - identityWindowMs))) return yield* deny("no recent release")
  yield* identities.put(identity)
  yield* Effect.logInfo("stored the TestFlight signing identity", {
    instanceId,
    certificateId: identity.certificateId
  })
  return identity.certificateId
})

/** `Routes.testflightGrant` (operator): lets one build Mac fetch the key once in the next 15 minutes. */
export const grantAscKey = Effect.fn("Testflight.grantAscKey")(function* (body: unknown) {
  const grants = yield* TestflightGrants
  const request = yield* Schema.decodeUnknownEffect(TestflightGrantRequest)(body).pipe(
    Effect.mapError(() => new TestflightDenied({ reason: "malformed request" }))
  )
  const now = yield* DateTime.now
  yield* grants.grant(request.instanceId, DateTime.toEpochMillis(now) + grantTtlMs)
  return request.instanceId
})
