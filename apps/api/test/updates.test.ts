/**
 * The over-the-air update server: the Expo Updates protocol as expo-updates speaks it (headers, multipart parts,
 * signatures, directives), the signing round trip against the certificate the app embeds, and publishing,
 * channels and rollback through the operator's routes.
 */
import { createHash, verify, X509Certificate } from "node:crypto"
import { Routes, UpdatesSecretHeader } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { route } from "../src/http/Router.ts"
import { rollbackTarget } from "../src/http/Updates.ts"
import { fromBase64 } from "../src/lib/Bytes.ts"
import { makeCloud } from "./support/Cloud.ts"
import { makeR2 } from "./support/R2.ts"

const api = "https://api.dream.test"
const runtime = "14bf5883ff7e3ef551e61c1a2de76dbf4589a863"
const embeddedId = "0b3d8c1e-1f0a-4f47-9f3c-2d1a3c1e9a10"

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const send = (cloud: Cloud, path: string, init: RequestInit = {}) =>
  Effect.gen(function* () {
    const raw = new Request(`${api}${path}`, init)
    const response = yield* route(raw).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
      Effect.provide(Layer.succeedContext(cloud.workerContext))
    )
    const web = HttpServerResponse.toWeb(response)
    return { status: web.status, headers: web.headers, body: yield* Effect.promise(() => web.text()) }
  })

const operator = { [UpdatesSecretHeader]: "updates-secret" }

const admin = (cloud: Cloud, path: string, body?: unknown) =>
  send(cloud, path, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...operator, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })

/** What stock expo-updates sends for a manifest (FileDownloader.swift), with the build's channel header. */
const manifestHeaders = (overrides: Record<string, string> = {}) => ({
  accept: "multipart/mixed,application/expo+json,application/json",
  "expo-platform": "ios",
  "expo-protocol-version": "1",
  "expo-api-version": "1",
  "expo-updates-environment": "BARE",
  "expo-runtime-version": runtime,
  "expo-channel-name": "production",
  "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
  "expo-current-update-id": embeddedId,
  "expo-embedded-update-id": embeddedId,
  ...overrides
})

const askForUpdate = (cloud: Cloud, overrides: Record<string, string> = {}) =>
  send(cloud, Routes.updatesManifest, { headers: manifestHeaders(overrides) })

interface Part {
  readonly headers: Record<string, string>
  readonly body: string
}

/** Splits a multipart/mixed body the way expo-updates' reader does. */
const parts = (contentType: string, body: string): Record<string, Part> => {
  const boundary = /boundary=([^;]+)/.exec(contentType)![1]!
  const out: Record<string, Part> = {}
  for (const chunk of body.split(`--${boundary}`).slice(1, -1)) {
    const [head, ...rest] = chunk.replace(/^\r\n/, "").split("\r\n\r\n")
    const headers = Object.fromEntries(
      head!.split("\r\n").map((line) => {
        const i = line.indexOf(":")
        return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]
      })
    )
    const name = /name="([^"]+)"/.exec(headers["content-disposition"]!)![1]!
    out[name] = { headers, body: rest.join("\r\n\r\n").replace(/\r\n$/, "") }
  }
  return out
}

/** Checks a part's `expo-signature` against the certificate, like CodeSigningConfiguration.swift. */
const verifies = (certificatePem: string, part: Part) => {
  const header = part.headers["expo-signature"]
  if (header === undefined) return false
  const fields = Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
  assert.strictEqual(fields.keyid, "main")
  assert.strictEqual(fields.alg, "rsa-v1_5-sha256")
  const certificate = new X509Certificate(certificatePem)
  return verify("sha256", new TextEncoder().encode(part.body), certificate.publicKey, fromBase64(fields.sig!))
}

const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64url")

const upload = (cloud: Cloud, bytes: Uint8Array, contentType: string, hash = hashOf(bytes)) =>
  send(cloud, Routes.updatesUpload(hash), {
    method: "PUT",
    headers: { ...operator, "content-type": contentType },
    body: bytes as any
  })

const bundle = (text: string) => new TextEncoder().encode(text)

/** Uploads a bundle and an image and publishes them as an update. */
const publish = (cloud: Cloud, text: string, overrides: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const js = bundle(text)
    const png = bundle(`png:${text}`)
    assert.strictEqual((yield* upload(cloud, js, "application/javascript")).status, 201)
    assert.strictEqual((yield* upload(cloud, png, "image/png")).status, 201)
    return yield* admin(cloud, Routes.updatesPublish, {
      channel: "production",
      platform: "ios",
      runtimeVersion: runtime,
      launchAsset: { hash: hashOf(js), key: "bundle", contentType: "application/javascript" },
      assets: [
        { hash: hashOf(png), key: "0a328cd9c1afd0afe8e3b1ec5165b1b4", contentType: "image/png", fileExtension: ".png" }
      ],
      expoClient: { name: "Dream", extra: { backend: "live", apiUrl: "https://dream.omer.build" } },
      gitCommit: "a79fa56",
      message: text,
      ...overrides
    })
  })

const setUp = Effect.gen(function* () {
  const r2 = makeR2()
  const cloud = yield* makeCloud({}, { updates: r2.bucket })
  const key = yield* admin(cloud, Routes.updatesSigningKey, {})
  assert.strictEqual(key.status, 201)
  return { cloud, r2, certificatePem: JSON.parse(key.body).certificatePem as string }
})

describe("update signing key", () => {
  it.live("is created once, inside the Worker, with a code signing certificate expo-updates accepts", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud({}, { updates: makeR2().bucket })
      assert.strictEqual((yield* send(cloud, Routes.updatesCertificate)).status, 404)
      const created = yield* admin(cloud, Routes.updatesSigningKey, {})
      assert.strictEqual(created.status, 201)
      const first = JSON.parse(created.body)
      assert.isTrue(first.created)
      assert.notInclude(created.body, "PRIVATE KEY")

      const again = yield* admin(cloud, Routes.updatesSigningKey, {})
      assert.deepStrictEqual(JSON.parse(again.body), { certificatePem: first.certificatePem, created: false })
      const published = yield* send(cloud, Routes.updatesCertificate)
      assert.strictEqual(JSON.parse(published.body).certificatePem, first.certificatePem)

      // What CertificateChain.swift checks: self-signed and valid now, digitalSignature and codeSigning usages.
      const certificate = new X509Certificate(first.certificatePem)
      assert.strictEqual(certificate.subject, certificate.issuer)
      assert.isTrue(certificate.verify(certificate.publicKey))
      assert.isTrue(new Date(certificate.validFrom) < new Date() && new Date(certificate.validTo) > new Date())
      assert.deepStrictEqual(certificate.keyUsage, ["1.3.6.1.5.5.7.3.3"])
      const der = certificate.raw.toString("hex")
      assert.include(der, "0603551d0f0101ff040403020780", "keyUsage: critical, digitalSignature")
      assert.strictEqual(certificate.publicKey.asymmetricKeyDetails?.modulusLength, 2048)
    })
  )

  it.live("is only for the operator", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud({}, { updates: makeR2().bucket })
      for (const headers of [{}, { [UpdatesSecretHeader]: "wrong" }, { "x-dream-dev-secret": "dev-secret" }]) {
        const response = yield* send(cloud, Routes.updatesSigningKey, { method: "POST", headers })
        assert.strictEqual(response.status, 403)
      }
      const unset = yield* makeCloud({ updatesPublishSecret: Option.none() }, { updates: makeR2().bucket })
      assert.strictEqual((yield* send(unset, Routes.updatesStatus, { headers: operator })).status, 403)
    })
  )
})

describe("the manifest endpoint", () => {
  it.live("answers 204 with the protocol headers when nothing was published", () =>
    Effect.gen(function* () {
      const { cloud } = yield* setUp
      const response = yield* askForUpdate(cloud)
      assert.strictEqual(response.status, 204)
      assert.strictEqual(response.headers.get("expo-protocol-version"), "1")
      assert.strictEqual(response.headers.get("expo-sfv-version"), "0")
      assert.strictEqual(response.headers.get("cache-control"), "private, max-age=0")
    })
  )

  it.live("turns down requests it can't answer", () =>
    Effect.gen(function* () {
      const { cloud } = yield* setUp
      assert.strictEqual((yield* askForUpdate(cloud, { "expo-protocol-version": "0" })).status, 406)
      assert.strictEqual((yield* askForUpdate(cloud, { accept: "application/json" })).status, 406)
      assert.strictEqual((yield* askForUpdate(cloud, { "expo-platform": "android" })).status, 400)
      assert.strictEqual((yield* askForUpdate(cloud, { "expo-runtime-version": "" })).status, 400)
      assert.strictEqual((yield* askForUpdate(cloud, { "expo-channel-name": "Not A Channel" })).status, 400)
    })
  )

  it.live("serves the newest update, signed, to builds of its runtime version on its channel only", () =>
    Effect.gen(function* () {
      const { cloud, certificatePem } = yield* setUp
      yield* askForUpdate(cloud) // the build checks in
      const published = yield* publish(cloud, "first")
      assert.strictEqual(published.status, 201)
      const first = JSON.parse(published.body)
      yield* publish(cloud, "second")

      const response = yield* askForUpdate(cloud)
      assert.strictEqual(response.status, 200)
      assert.strictEqual(response.headers.get("expo-protocol-version"), "1")
      assert.match(response.headers.get("content-type")!, /^multipart\/mixed; boundary=/)
      const { manifest, extensions } = parts(response.headers.get("content-type")!, response.body)
      assert.isTrue(verifies(certificatePem, manifest!))
      assert.match(manifest!.headers["content-type"]!, /^application\/json/)
      assert.deepStrictEqual(JSON.parse(extensions!.body), { assetRequestHeaders: {} })

      const body = JSON.parse(manifest!.body)
      const js = bundle("second")
      assert.notStrictEqual(body.id, first.id)
      assert.match(body.id, /^[0-9a-f-]{36}$/)
      assert.strictEqual(body.runtimeVersion, runtime)
      assert.deepStrictEqual(body.launchAsset, {
        hash: hashOf(js),
        key: "bundle",
        contentType: "application/javascript",
        url: `${api}/updates/assets/${hashOf(js)}`
      })
      assert.strictEqual(body.assets[0].fileExtension, ".png")
      assert.deepStrictEqual(body.metadata, {})
      assert.strictEqual(body.extra.expoClient.extra.backend, "live")
      assert.isTrue(new Date(body.createdAt) > new Date(first.createdAt))

      // A tampered body doesn't verify.
      assert.isFalse(
        verifies(certificatePem, { ...manifest!, body: manifest!.body.replace(runtime, `0${runtime.slice(1)}`) })
      )

      // The assets it names are there, by hash.
      const asset = yield* send(cloud, `/updates/assets/${hashOf(js)}`)
      assert.strictEqual(asset.status, 200)
      assert.strictEqual(asset.body, "second")
      assert.strictEqual(asset.headers.get("content-type"), "application/javascript")
      assert.strictEqual(asset.headers.get("cache-control"), "public, max-age=31536000, immutable")

      // Another runtime version, channel or platform gets nothing.
      assert.strictEqual((yield* askForUpdate(cloud, { "expo-runtime-version": "other" })).status, 204)
      assert.strictEqual((yield* askForUpdate(cloud, { "expo-channel-name": "development" })).status, 204)
    })
  )

  it.live("records what each runtime version's builds run", () =>
    Effect.gen(function* () {
      const { cloud } = yield* setUp
      yield* askForUpdate(cloud)
      const update = JSON.parse((yield* publish(cloud, "first")).body)
      yield* askForUpdate(cloud, { "expo-current-update-id": update.id })
      const status = JSON.parse((yield* admin(cloud, `${Routes.updatesStatus}?channel=production`)).body)
      assert.strictEqual(status.runtimes.length, 1)
      assert.strictEqual(status.runtimes[0].runtimeVersion, runtime)
      assert.strictEqual(status.runtimes[0].checkIn.runningUpdateId, update.id)
      assert.strictEqual(status.runtimes[0].checkIn.embeddedUpdateId, embeddedId)
      assert.strictEqual(status.runtimes[0].releases[0].id, update.id)
      assert.strictEqual(status.runtimes[0].releases[0]._tag, "Update")
    })
  )
})

describe("publishing", () => {
  it.live("checks every asset's bytes and that they were uploaded", () =>
    Effect.gen(function* () {
      const { cloud } = yield* setUp
      const wrong = yield* upload(cloud, bundle("x"), "application/javascript", hashOf(bundle("y")))
      assert.strictEqual(wrong.status, 400)
      const noType = yield* upload(cloud, bundle("x"), "")
      assert.strictEqual(noType.status, 400)
      yield* askForUpdate(cloud)
      const missing = yield* admin(cloud, Routes.updatesPublish, {
        channel: "production",
        platform: "ios",
        runtimeVersion: runtime,
        launchAsset: { hash: hashOf(bundle("never uploaded")), key: "bundle", contentType: "application/javascript" },
        assets: [],
        expoClient: {},
        gitCommit: "a79fa56",
        message: ""
      })
      assert.strictEqual(missing.status, 400)
      assert.include(missing.body, "Upload these assets first")
      const exists = yield* send(cloud, Routes.updatesUpload(hashOf(bundle("x"))), {
        method: "HEAD",
        headers: operator
      })
      assert.strictEqual(exists.status, 404)
    })
  )

  it.live("refuses a runtime version no build on the channel has asked with, unless forced", () =>
    Effect.gen(function* () {
      const { cloud } = yield* setUp
      const refused = yield* publish(cloud, "first")
      assert.strictEqual(refused.status, 409)
      assert.include(refused.body, "has asked for updates")
      // A check-in on another channel doesn't count.
      yield* askForUpdate(cloud, { "expo-channel-name": "development" })
      assert.strictEqual((yield* publish(cloud, "first")).status, 409)
      assert.strictEqual((yield* publish(cloud, "first", { force: true })).status, 201)
    })
  )

  it.live("needs the signing key first", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud({}, { updates: makeR2().bucket })
      const response = yield* publish(cloud, "first", { force: true })
      assert.strictEqual(response.status, 409)
      assert.include(response.body, "init")
    })
  )
})

describe("rollback", () => {
  it.live("republishes the previous update as a new one, then falls back to the embedded bundle", () =>
    Effect.gen(function* () {
      const { cloud, certificatePem } = yield* setUp
      yield* askForUpdate(cloud)
      const first = JSON.parse((yield* publish(cloud, "first")).body)
      const second = JSON.parse((yield* publish(cloud, "second")).body)
      const rollback = (to?: string) =>
        admin(cloud, Routes.updatesRollback, {
          channel: "production",
          platform: "ios",
          runtimeVersion: runtime,
          ...(to === undefined ? {} : { to })
        })
      const live = () =>
        Effect.gen(function* () {
          const response = yield* askForUpdate(cloud)
          return parts(response.headers.get("content-type")!, response.body)
        })

      const back = yield* rollback()
      assert.strictEqual(back.status, 201)
      const republished = JSON.parse(back.body)
      assert.strictEqual(republished.republishOf, first.id)
      assert.strictEqual(republished.message, "first")
      const served = JSON.parse((yield* live()).manifest!.body)
      // A new id and a later createdAt, since expo-updates only takes updates newer than the one it runs.
      assert.strictEqual(served.id, republished.id)
      assert.isTrue(new Date(served.createdAt) > new Date(second.createdAt))
      assert.strictEqual(served.launchAsset.hash, hashOf(bundle("first")))

      const toEmbedded = JSON.parse((yield* rollback()).body)
      assert.strictEqual(toEmbedded._tag, "RollBackToEmbedded")
      const { directive, manifest } = yield* live()
      assert.isUndefined(manifest)
      assert.isTrue(verifies(certificatePem, directive!))
      const parsed = JSON.parse(directive!.body)
      assert.strictEqual(parsed.type, "rollBackToEmbedded")
      assert.isTrue(new Date(parsed.parameters.commitTime) > new Date(served.createdAt))

      assert.strictEqual((yield* rollback()).status, 409)

      // Rolling forward again names the update.
      const forward = JSON.parse((yield* rollback(second.id)).body)
      assert.strictEqual(forward.republishOf, second.id)
      assert.strictEqual(JSON.parse((yield* live()).manifest!.body).launchAsset.hash, hashOf(bundle("second")))
      assert.strictEqual((yield* rollback("6f1c2b0e-0000-4000-8000-000000000000")).status, 404)
    })
  )

  it.effect("finds the update before the live one's original", () =>
    Effect.gen(function* () {
      const update = (id: string, republishOf?: string) => ({
        release: { _tag: "Update", id, republishOf } as any,
        content: { _tag: "None" } as any
      })
      // Newest first: c republishes b, so the one to go back to is the original before b.
      const target = yield* rollbackTarget([update("c", "b"), update("b"), update("a")])
      assert.strictEqual(target === "embedded" ? target : target.release.id, "a")
      assert.strictEqual(yield* rollbackTarget([update("a")]), "embedded")
    })
  )
})
