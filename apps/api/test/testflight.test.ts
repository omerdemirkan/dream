/**
 * Releasing the App Store Connect key to a Namespace build Mac: the token checks, the encryption the Mac
 * undoes, and the whole release against fakes (grant, single use, the only-instance rule).
 */
import { TestflightKeyAudience, TestflightKeyInfo, type TestflightKeyRelease } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { D1Client } from "@effect/sql-d1"
import { Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { Namespace } from "../src/brokers/Namespace.ts"
import { ApiConfig } from "../src/Config.ts"
import { TestflightGrants } from "../src/db/TestflightGrants.ts"
import { TestflightIdentity } from "../src/db/TestflightIdentity.ts"
import {
  grantAscKey,
  identityAudience,
  releaseAscKey,
  sealForMac,
  storeSigningIdentity,
  verifyBuildMacToken
} from "../src/http/Testflight.ts"
import { fromBase64Url, fromUtf8, toBase64Url, utf8, type WebCryptoKey } from "../src/lib/Bytes.ts"
import type { AnyJwk } from "../src/lib/Jwt.ts"
import { makeD1 } from "./support/Sqlite.ts"

const issuer = "https://federation.namespaceapis.com"
const tenant = "tenant_test"
const pem = "-----BEGIN PRIVATE KEY-----\nZHJlYW0tdGVzdC1rZXk=\n-----END PRIVATE KEY-----\n"
const subtle = crypto.subtle as any

/** The federation issuer's signing key, and a JWKS for it. */
const issuerKey = Effect.promise(async () => {
  const pair = await subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )
  const jwk = await subtle.exportKey("jwk", pair.publicKey)
  return { privateKey: pair.privateKey as WebCryptoKey, jwk: { kid: "k1", kty: "RSA", n: jwk.n, e: jwk.e } as AnyJwk }
})

const segment = (value: object) => toBase64Url(utf8(JSON.stringify(value)))

const mintToken = (privateKey: WebCryptoKey, claims: object) =>
  Effect.promise(async () => {
    const input = `${segment({ alg: "RS256", kid: "k1", typ: "JWT" })}.${segment(claims)}`
    const signature = new Uint8Array(await subtle.sign("RSASSA-PKCS1-v1_5", privateKey, utf8(input)))
    return `${input}.${toBase64Url(signature)}`
  })

/** What the Mac does: an ephemeral ECDH key, and the audience that binds a token to it. */
const macKey = Effect.promise(async () => {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey)) as Uint8Array<ArrayBuffer>
  const digest = new Uint8Array(await subtle.digest("SHA-256", raw))
  return { privateKey: pair.privateKey, raw, audience: TestflightKeyAudience(toBase64Url(digest)) }
})

/** The Mac's side of `sealForMac` (testflight-namespace.ts runs the same steps with node:crypto). */
const openOnMac = (
  mac: { privateKey: unknown; raw: Uint8Array<ArrayBuffer> },
  instanceId: string,
  r: TestflightKeyRelease,
  part: "key" | "identity" = "key"
) =>
  Effect.promise(async () => {
    const server = fromBase64Url(r.serverPublicKey)
    const serverKey = await subtle.importKey("raw", server, { name: "ECDH", namedCurve: "P-256" }, false, [])
    const shared = await subtle.deriveBits({ name: "ECDH", public: serverKey }, mac.privateKey, 256)
    const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"])
    const salt = new Uint8Array([...mac.raw, ...server])
    const aes = await subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: utf8(TestflightKeyInfo) },
      hkdf,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    )
    const [iv, ciphertext, aad] =
      part === "key"
        ? [r.iv, r.ciphertext, instanceId]
        : [r.identityIv ?? "", r.identityCiphertext ?? "", `${instanceId}:identity`]
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: utf8(aad) },
      aes,
      fromBase64Url(ciphertext)
    )
    return fromUtf8(new Uint8Array(plain))
  })

const nowSec = () => Math.floor(Date.now() / 1000)
const claimsFor = (instanceId: string, audience: string, overrides: object = {}) => ({
  iss: issuer,
  sub: `${tenant}/${instanceId}`,
  aud: [audience],
  iat: nowSec(),
  nbf: nowSec() - 60,
  exp: nowSec() + 300,
  tenant_id: tenant,
  instance_id: instanceId,
  ...overrides
})

describe("verifyBuildMacToken", () => {
  it.effect("accepts a fresh token of the tenant bound to the public key, and nothing else", () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* issuerKey
      const mac = yield* macKey
      const options = { issuer, tenantId: tenant, nowSec: nowSec() }
      const check = (claims: object, keys: ReadonlyArray<AnyJwk> = [jwk]) =>
        mintToken(privateKey, claims).pipe(
          Effect.flatMap((token) => verifyBuildMacToken(token, mac.audience, keys, options)),
          Effect.match({ onSuccess: (id) => id, onFailure: (e) => e.reason })
        )

      assert.strictEqual(yield* check(claimsFor("buildmac0001", mac.audience)), "buildmac0001")
      assert.strictEqual(
        yield* check(claimsFor("buildmac0001", "dream-testflight:other")),
        "ID token: not bound to this request"
      )
      assert.strictEqual(
        yield* check(
          claimsFor("buildmac0001", mac.audience, { tenant_id: "tenant_other", sub: "tenant_other/buildmac0001" })
        ),
        "ID token: another workspace"
      )
      assert.strictEqual(
        yield* check(claimsFor("buildmac0001", mac.audience, { sub: `${tenant}/buildmac0002` })),
        "ID token: another workspace"
      )
      assert.strictEqual(
        yield* check(claimsFor("buildmac0001", mac.audience, { iss: "https://evil.test" })),
        "ID token: wrong issuer"
      )
      assert.strictEqual(
        yield* check(claimsFor("buildmac0001", mac.audience, { iat: nowSec() - 600, exp: nowSec() - 1 })),
        "ID token: expired"
      )
      assert.strictEqual(
        yield* check(claimsFor("buildmac0001", mac.audience, { exp: nowSec() + 3600 })),
        "ID token: lives too long"
      )
      assert.strictEqual(
        yield* check(claimsFor("buildmac0001", mac.audience), [{ ...jwk, kid: "k2" }]),
        "ID token: unknown signing key"
      )
      // Signed by someone else under the issuer's kid.
      const other = yield* issuerKey
      assert.strictEqual(yield* check(claimsFor("buildmac0001", mac.audience), [other.jwk]), "ID token: bad signature")
    })
  )
})

describe("sealForMac", () => {
  it.effect("only the Mac's key opens it, and only for its instance id", () =>
    Effect.gen(function* () {
      const mac = yield* macKey
      const sealed = yield* sealForMac(mac.raw, "buildmac0001", pem)
      assert.strictEqual(yield* openOnMac(mac, "buildmac0001", sealed), pem)
      const wrongInstance = yield* openOnMac(mac, "buildmac0002", sealed).pipe(Effect.exit)
      assert.strictEqual(wrongInstance._tag, "Failure")
      const other = yield* macKey
      const wrongKey = yield* openOnMac(other, "buildmac0001", sealed).pipe(Effect.exit)
      assert.strictEqual(wrongKey._tag, "Failure")
    })
  )
})

describe("releaseAscKey", () => {
  const world = (
    instances: Array<{ instanceId: string; status: string; labels?: Record<string, string> }>,
    jwk: AnyJwk
  ) => {
    const { d1 } = makeD1()
    const namespace = Layer.succeed(Namespace, {
      list: Effect.sync(() => instances)
    } as unknown as Namespace["Service"])
    const jwks = Layer.succeed(FetchHttpClient.Fetch, (async (input: RequestInfo | URL) => {
      assert.strictEqual(String(input), `${issuer}/.well-known/jwks.json`)
      return new Response(JSON.stringify({ keys: [jwk, { kid: "ec", kty: "EC", crv: "P-256", x: "a", y: "b" }] }), {
        headers: { "content-type": "application/json" }
      })
    }) as typeof fetch)
    const config = ApiConfig.layerTest({ ascTestflightKey: Option.some(Redacted.make(pem)), namespaceTenantId: tenant })
    return Layer.mergeAll(
      Layer.mergeAll(TestflightGrants.layer, TestflightIdentity.layer).pipe(
        Layer.provide(D1Client.layer({ db: d1 }).pipe(Layer.orDie)),
        Layer.provide(config)
      ),
      namespace,
      FetchHttpClient.layer.pipe(Layer.provide(jwks)),
      config
    )
  }

  it.live("releases once to a granted, running, sole build Mac", () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* issuerKey
      const mac = yield* macKey
      const instances = [{ instanceId: "buildmac0001", status: "RUNNING", labels: { dream: "testflight" } }]
      const request = {
        idToken: yield* mintToken(privateKey, claimsFor("buildmac0001", mac.audience)),
        publicKey: toBase64Url(mac.raw)
      }
      const outcome = releaseAscKey(request).pipe(
        Effect.match({ onSuccess: (r) => r, onFailure: (e) => (e._tag === "TestflightDenied" ? e.reason : e._tag) })
      )

      yield* Effect.gen(function* () {
        assert.strictEqual(yield* outcome, "no grant")
        yield* grantAscKey({ instanceId: "buildmac0001" })
        const release = yield* outcome
        assert.notStrictEqual(typeof release, "string")
        assert.strictEqual(yield* openOnMac(mac, "buildmac0001", release as TestflightKeyRelease), pem)
        assert.strictEqual(yield* outcome, "no grant")
      }).pipe(Effect.provide(world(instances, jwk)))

      // Another Mac in the workspace (an agent's, say) blocks the release, grant or not.
      yield* Effect.gen(function* () {
        yield* grantAscKey({ instanceId: "buildmac0001" })
        assert.strictEqual(yield* outcome, "another instance is running")
      }).pipe(Effect.provide(world([...instances, { instanceId: "agentmac0001", status: "RUNNING" }], jwk)))

      // Unlabeled or not running: not a build Mac.
      yield* Effect.gen(function* () {
        yield* grantAscKey({ instanceId: "buildmac0001" })
        assert.strictEqual(yield* outcome, "not a running build Mac")
      }).pipe(Effect.provide(world([{ instanceId: "buildmac0001", status: "RUNNING" }], jwk)))
    })
  )
  it.live("stores the identity the just-released Mac created, and releases it with the key from then on", () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* issuerKey
      const mac = yield* macKey
      const instances = [{ instanceId: "buildmac0001", status: "RUNNING", labels: { dream: "testflight" } }]
      const identity = {
        certificateId: "ABCDEF1234",
        certificate: "MIIBcert",
        privateKey: Redacted.make("-----BEGIN PRIVATE KEY-----\nMIIEkey\n-----END PRIVATE KEY-----\n")
      }
      const upload = (audience: string) =>
        mintToken(privateKey, claimsFor("buildmac0001", audience)).pipe(
          Effect.flatMap((idToken) =>
            storeSigningIdentity({
              idToken,
              identity: { ...identity, privateKey: Redacted.value(identity.privateKey) }
            })
          ),
          Effect.match({ onSuccess: (id) => id, onFailure: (e) => (e._tag === "TestflightDenied" ? e.reason : e._tag) })
        )
      const release = Effect.gen(function* () {
        const request = {
          idToken: yield* mintToken(privateKey, claimsFor("buildmac0001", mac.audience)),
          publicKey: toBase64Url(mac.raw)
        }
        return yield* releaseAscKey(request)
      })

      yield* Effect.gen(function* () {
        const audience = yield* identityAudience(identity)
        // Only a Mac that was just released the key may store one.
        assert.strictEqual(yield* upload(audience), "no recent release")
        yield* grantAscKey({ instanceId: "buildmac0001" })
        const first = yield* release
        assert.strictEqual(first.identityCiphertext, undefined)
        // A token bound to some other identity doesn't store this one.
        assert.strictEqual(yield* upload("dream-testflight-identity:other"), "ID token: not bound to this request")
        assert.strictEqual(yield* upload(audience), "ABCDEF1234")
        yield* grantAscKey({ instanceId: "buildmac0001" })
        const second = yield* release
        const opened = JSON.parse(yield* openOnMac(mac, "buildmac0001", second, "identity"))
        assert.deepStrictEqual(opened, { ...identity, privateKey: Redacted.value(identity.privateKey) })
        assert.strictEqual(yield* openOnMac(mac, "buildmac0001", second), pem)
      }).pipe(Effect.provide(world(instances, jwk)))
    })
  )
})
