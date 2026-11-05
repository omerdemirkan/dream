/**
 * Over-the-air updates of the iPhone app: an Expo Updates protocol v1 server (https://docs.expo.dev/technical-specs/expo-updates-1/),
 * nothing more, so stock expo-updates talks to it exactly as it would to EAS Update.
 *
 * - `GET /updates/manifest` answers with the newest release for the request's `expo-platform`,
 *   `expo-runtime-version` and `expo-channel-name`: a multipart response with a signed `manifest` part (and an
 *   empty `extensions` part), a signed `rollBackToEmbedded` `directive` part, or 204 when nothing was published.
 * - `GET /updates/assets/:hash` serves a bundle or asset from R2 by its base64url SHA-256, immutable.
 * - The admin routes (upload, publish, rollback, status, signing key) need `UPDATES_PUBLISH_SECRET` in
 *   `UpdatesSecretHeader`; `apps/mobile/scripts/updates.ts` is their client.
 *
 * The signing key is generated here and never leaves the Worker: its private half is sealed in D1 with the master
 * key (db/Updates.ts), and every manifest and directive is signed as it's served. A publisher can only make the
 * Worker sign updates made of assets whose hashes it checked on upload.
 */
import type { R2Bucket } from "@cloudflare/workers-types"
import {
  AssetHash,
  PublishUpdateRequest,
  RollbackUpdateRequest,
  RuntimeVersion,
  UpdateChannel,
  UpdateId,
  UpdatePlatform,
  UpdateRelease,
  UpdatesCertificate,
  UpdatesKeyId,
  UpdatesSecretHeader,
  UpdatesStatus,
  type RuntimeUpdates,
  Routes
} from "@dream/domain"
import { Context, Data, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect"
import type { HttpServerRequest } from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { ApiConfig } from "../Config.ts"
import { type RuntimeKey, type StoredRelease, type UpdateContent, UpdateStore } from "../db/Updates.ts"
import { randomBytes, timingSafeEqual, toBase64Url, toHex } from "../lib/Bytes.ts"
import { signatureHeader } from "../lib/CodeSigning.ts"

export class UpdateAssets extends Context.Service<UpdateAssets, { readonly bucket: Option.Option<R2Bucket> }>()(
  "@dream/api/UpdateAssets"
) {
  static readonly layer = (bucket: R2Bucket | undefined) =>
    Layer.succeed(UpdateAssets, UpdateAssets.of({ bucket: Option.fromUndefinedOr(bucket) }))
}

/** A request the update routes turn down, with the status to answer with. */
export class UpdatesRefused extends Data.TaggedError("UpdatesRefused")<{
  readonly status: number
  readonly message: string
}> {}

const refuse = (status: number, message: string) => Effect.fail(new UpdatesRefused({ status, message }))

const objectKey = (hash: string) => `assets/${hash}`

/** How many releases per runtime version the status lists. */
const statusDepth = 20

const json = <S extends Schema.Top>(schema: S, value: S["Type"], status = 200) =>
  HttpServerResponse.jsonUnsafe(Schema.encodeSync(Schema.toCodecJson(schema) as any)(value), { status })

const decodeHeader = <S extends Schema.Codec<any, string, never, never>>(
  schema: S,
  value: string | undefined,
  name: string
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new UpdatesRefused({ status: 400, message: `missing or invalid ${name}` }))
  )

const decodeBody = <S extends Schema.Codec<any, any, never, never>>(schema: S, request: HttpServerRequest) =>
  request.json.pipe(
    Effect.orElseSucceed(() => null),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((e) => new UpdatesRefused({ status: 400, message: String(e) }))
  )

const bucket = Effect.gen(function* () {
  const assets = yield* UpdateAssets
  if (Option.isNone(assets.bucket)) return yield* refuse(503, "Update storage isn't enabled on this deployment.")
  return assets.bucket.value
})

const sha256Base64Url = (bytes: ArrayBuffer) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) => toBase64Url(new Uint8Array(digest)))
  )

// The protocol.

const protocolHeaders = {
  "expo-protocol-version": "1",
  "expo-sfv-version": "0",
  "cache-control": "private, max-age=0"
}

const multipart = (
  parts: ReadonlyArray<{ readonly name: string; readonly body: string; readonly signature?: string }>
) => {
  const boundary = `dream-${toHex(randomBytes(12))}`
  const body =
    parts
      .map(
        (part) =>
          `--${boundary}\r\ncontent-disposition: form-data; name="${part.name}"\r\n` +
          `content-type: application/json; charset=utf-8\r\n` +
          (part.signature === undefined ? "" : `expo-signature: ${part.signature}\r\n`) +
          `\r\n${part.body}\r\n`
      )
      .join("") + `--${boundary}--\r\n`
  return HttpServerResponse.raw(
    new Response(body, {
      status: 200,
      headers: { ...protocolHeaders, "content-type": `multipart/mixed; boundary=${boundary}` }
    })
  )
}

/** The manifest body (the spec's `Manifest`): asset URLs on this API, the app config as `extra.expoClient`. */
export const manifestBody = (
  apiUrl: string,
  runtimeVersion: string,
  release: Extract<UpdateRelease, { _tag: "Update" }>,
  content: UpdateContent
) => {
  const asset = (a: UpdateContent["launchAsset"]) => ({
    hash: a.hash,
    key: a.key,
    contentType: a.contentType,
    ...(a.fileExtension === undefined ? {} : { fileExtension: a.fileExtension }),
    url: `${apiUrl}${Routes.updatesAsset(a.hash)}`
  })
  const { fileExtension: _, ...launchAsset } = asset(content.launchAsset)
  return JSON.stringify({
    id: release.id,
    createdAt: DateTime.formatIso(release.createdAt),
    runtimeVersion,
    launchAsset,
    assets: content.assets.map(asset),
    metadata: {},
    extra: { expoClient: content.expoClient }
  })
}

/** GET `Routes.updatesManifest`. */
export const serveManifest = (request: HttpServerRequest) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const store = yield* UpdateStore
    const headers = request.headers
    if (headers["expo-protocol-version"] !== "1")
      return yield* refuse(406, "This server speaks Expo Updates protocol version 1.")
    const accept = headers["accept"] ?? "*/*"
    if (!/multipart\/mixed|\*\/\*/.test(accept))
      return yield* refuse(406, "Responses are multipart/mixed (they can carry directives).")
    const key: RuntimeKey = {
      platform: yield* decodeHeader(UpdatePlatform, headers["expo-platform"], "expo-platform"),
      runtimeVersion: yield* decodeHeader(RuntimeVersion, headers["expo-runtime-version"], "expo-runtime-version"),
      channel: yield* decodeHeader(UpdateChannel, headers["expo-channel-name"], "expo-channel-name")
    }
    const reported = (name: string) => Option.getOrUndefined(Schema.decodeUnknownOption(UpdateId)(headers[name]))
    const running = reported("expo-current-update-id")
    const embedded = reported("expo-embedded-update-id")
    yield* store.checkIn(key, {
      lastCheckAt: yield* DateTime.now,
      ...(running === undefined || running === embedded ? {} : { runningUpdateId: running }),
      ...(embedded === undefined ? {} : { embeddedUpdateId: embedded })
    })

    const [latest] = yield* store.releases(key, 1)
    if (latest === undefined) return HttpServerResponse.empty({ status: 204, headers: protocolHeaders })
    const signing = yield* store.signingKey
    if (Option.isNone(signing)) return yield* refuse(503, "There's no signing key yet.")
    const sign = (body: string) => signatureHeader(signing.value.key, body, UpdatesKeyId)

    if (latest.release._tag === "RollBackToEmbedded") {
      const body = JSON.stringify({
        type: "rollBackToEmbedded",
        parameters: { commitTime: DateTime.formatIso(latest.release.createdAt) }
      })
      return multipart([{ name: "directive", body, signature: yield* sign(body) }])
    }
    const content = Option.getOrThrow(latest.content)
    const body = manifestBody(config.apiUrl, key.runtimeVersion, latest.release, content)
    return multipart([
      { name: "manifest", body, signature: yield* sign(body) },
      { name: "extensions", body: JSON.stringify({ assetRequestHeaders: {} }) }
    ])
  })

/** GET or HEAD `Routes.updatesAsset(hash)`. */
export const serveAsset = (request: HttpServerRequest, rawHash: string) =>
  Effect.gen(function* () {
    const hash = Schema.decodeUnknownOption(AssetHash)(rawHash)
    if (Option.isNone(hash)) return yield* refuse(404, "Not found.")
    const r2 = yield* bucket
    const object =
      request.method === "HEAD"
        ? yield* Effect.promise(() => r2.head(objectKey(hash.value)))
        : yield* Effect.promise(() => r2.get(objectKey(hash.value)))
    if (object === null) return yield* refuse(404, "Not found.")
    const headers = {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "content-length": String(object.size),
      "cache-control": "public, max-age=31536000, immutable"
    }
    const body = "body" in object ? (object.body as any) : null
    return HttpServerResponse.raw(new Response(request.method === "HEAD" ? null : body, { status: 200, headers }))
  })

/** GET `Routes.updatesCertificate`: public, like the copy inside the app. */
export const serveCertificate = Effect.gen(function* () {
  const store = yield* UpdateStore
  const certificate = yield* store.certificate
  if (Option.isNone(certificate)) return yield* refuse(404, "There's no signing key yet.")
  return json(UpdatesCertificate, { certificatePem: certificate.value, created: false })
})

// The operator's routes.

/** Whether the request carries `UPDATES_PUBLISH_SECRET`. */
export const isPublisher = (request: HttpServerRequest) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const secret = request.headers[UpdatesSecretHeader]
    const expected = Option.map(config.updatesPublishSecret, Redacted.value)
    return secret !== undefined && Option.isSome(expected) && timingSafeEqual(secret, expected.value)
  })

/** HEAD (exists?) or PUT (store, after checking the hash) `Routes.updatesUpload(hash)`. */
export const uploadAsset = (request: HttpServerRequest, rawHash: string, raw: Request) =>
  Effect.gen(function* () {
    const hash = yield* decodeHeader(AssetHash, rawHash, "asset hash")
    const r2 = yield* bucket
    if (request.method === "HEAD") {
      const existing = yield* Effect.promise(() => r2.head(objectKey(hash)))
      return HttpServerResponse.empty({ status: existing === null ? 404 : 200 })
    }
    const contentType = request.headers["content-type"] ?? ""
    if (!/^[a-z]+\/[A-Za-z0-9.+-]+$/.test(contentType)) return yield* refuse(400, "Give the asset's content-type.")
    const bytes = yield* Effect.promise(() => raw.arrayBuffer())
    if ((yield* sha256Base64Url(bytes)) !== hash) return yield* refuse(400, "The bytes don't match the hash.")
    yield* Effect.promise(() => r2.put(objectKey(hash), bytes, { httpMetadata: { contentType } }))
    return HttpServerResponse.empty({ status: 201 })
  })

/** POST `Routes.updatesPublish`. */
export const publishUpdate = (request: HttpServerRequest) =>
  Effect.gen(function* () {
    const store = yield* UpdateStore
    const r2 = yield* bucket
    const publish = yield* decodeBody(PublishUpdateRequest, request)
    const key: RuntimeKey = {
      channel: publish.channel,
      platform: publish.platform,
      runtimeVersion: publish.runtimeVersion
    }
    if (Option.isNone(yield* store.certificate))
      return yield* refuse(409, "There's no signing key yet: run `scripts/updates.ts init` first.")
    const missing: Array<string> = []
    for (const asset of [publish.launchAsset, ...publish.assets]) {
      if ((yield* Effect.promise(() => r2.head(objectKey(asset.hash)))) === null) missing.push(asset.hash)
    }
    if (missing.length > 0) return yield* refuse(400, `Upload these assets first: ${missing.join(", ")}`)
    if (publish.force !== true) {
      const known = (yield* store.runtimes(key.channel)).some(
        (r) => r.platform === key.platform && r.runtimeVersion === key.runtimeVersion && r.checkIn !== undefined
      )
      if (!known)
        return yield* refuse(
          409,
          `No ${key.platform} build on channel "${key.channel}" has asked for updates with runtime version ` +
            `${key.runtimeVersion}. Open the build once (or pass --force if it isn't out yet).`
        )
    }
    const stored = yield* store.append(key, {
      release: UpdateRelease.cases.Update.make({
        id: crypto.randomUUID(),
        createdAt: yield* DateTime.now,
        gitCommit: publish.gitCommit,
        message: publish.message
      }),
      content: Option.some({
        launchAsset: publish.launchAsset,
        assets: publish.assets,
        expoClient: publish.expoClient
      })
    })
    yield* Effect.logInfo("published an update", { ...key, id: stored.release.id })
    return json(UpdateRelease, stored.release, 201)
  })

/** The update a rollback with no `to` returns to: the original published before the live one's original. */
export const rollbackTarget = (
  history: ReadonlyArray<StoredRelease>
): Effect.Effect<StoredRelease | "embedded", UpdatesRefused> => {
  const [live] = history
  if (live === undefined) return refuse(409, "Nothing was published for this runtime version.")
  if (live.release._tag === "RollBackToEmbedded") return refuse(409, "It's already back on the embedded bundle.")
  const liveSource = live.release.republishOf ?? live.release.id
  const originals = history.filter((r) => r.release._tag === "Update" && r.release.republishOf === undefined)
  const index = originals.findIndex((r) => r.release.id === liveSource)
  if (index === -1) return refuse(409, "The live update's original is too old to find; name one with --to.")
  return Effect.succeed(originals[index + 1] ?? "embedded")
}

/** POST `Routes.updatesRollback`: a new release that makes an earlier update (or the embedded bundle) live. */
export const rollbackUpdate = (request: HttpServerRequest) =>
  Effect.gen(function* () {
    const store = yield* UpdateStore
    const rollback = yield* decodeBody(RollbackUpdateRequest, request)
    const key: RuntimeKey = {
      channel: rollback.channel,
      platform: rollback.platform,
      runtimeVersion: rollback.runtimeVersion
    }
    const target =
      rollback.to === undefined
        ? yield* rollbackTarget(yield* store.releases(key, 1000))
        : rollback.to === "embedded"
          ? ("embedded" as const)
          : Option.getOrUndefined(yield* store.release(key, rollback.to))
    if (target === undefined) return yield* refuse(404, `There's no update ${rollback.to} for this runtime version.`)
    const createdAt = yield* DateTime.now
    const id = crypto.randomUUID()
    if (target === "embedded") {
      const stored = yield* store.append(key, {
        release: UpdateRelease.cases.RollBackToEmbedded.make({ id, createdAt }),
        content: Option.none()
      })
      return json(UpdateRelease, stored.release, 201)
    }
    if (target.release._tag !== "Update") return yield* refuse(400, "That release is a rollback, not an update.")
    const stored = yield* store.append(key, {
      release: UpdateRelease.cases.Update.make({
        id,
        createdAt,
        gitCommit: target.release.gitCommit,
        message: target.release.message,
        republishOf: target.release.republishOf ?? target.release.id
      }),
      content: target.content
    })
    yield* Effect.logInfo("rolled an update back", { ...key, id, to: target.release.id })
    return json(UpdateRelease, stored.release, 201)
  })

/** GET `Routes.updatesStatus?channel=…`. */
export const updatesStatus = (url: URL) =>
  Effect.gen(function* () {
    const store = yield* UpdateStore
    const channel = yield* decodeHeader(UpdateChannel, url.searchParams.get("channel") ?? undefined, "channel")
    const runtimes: Array<RuntimeUpdates> = []
    for (const runtime of yield* store.runtimes(channel)) {
      const platform = Schema.decodeUnknownOption(UpdatePlatform)(runtime.platform)
      const runtimeVersion = Schema.decodeUnknownOption(RuntimeVersion)(runtime.runtimeVersion)
      if (Option.isNone(platform) || Option.isNone(runtimeVersion)) continue
      const releases = yield* store.releases(
        { channel, platform: platform.value, runtimeVersion: runtimeVersion.value },
        statusDepth
      )
      runtimes.push({
        runtimeVersion: runtimeVersion.value,
        platform: platform.value,
        releases: releases.map((r) => r.release),
        ...(runtime.checkIn === undefined ? {} : { checkIn: runtime.checkIn })
      })
    }
    return json(UpdatesStatus, { channel, runtimes })
  })

/** POST `Routes.updatesSigningKey`. */
export const ensureSigningKey = Effect.gen(function* () {
  const store = yield* UpdateStore
  const result = yield* store.ensureSigningKey
  if (result.created) yield* Effect.logInfo("created the update signing key")
  return json(UpdatesCertificate, result, result.created ? 201 : 200)
})

/** Answers a refusal with its status and message. */
export const answered = <R>(effect: Effect.Effect<HttpServerResponse.HttpServerResponse, UpdatesRefused, R>) =>
  effect.pipe(
    Effect.catchTag("UpdatesRefused", (e) =>
      Effect.succeed(HttpServerResponse.text(e.message, { status: e.status, headers: { "cache-control": "no-store" } }))
    )
  )
