/**
 * Media bytes in R2, served through the Worker: the agent's uploads (PUT with
 * a one-file upload token) and the phone's downloads (GET with its session
 * token, ranges supported so videos stream). R2 is optional until it's
 * enabled on the account; without it uploads are refused.
 *
 * Their attachments go the same way: the phone PUTs each with an attachment
 * token, loads it back like media, and dreamd fetches the ones sent to its
 * project with the project token.
 */
import type { R2Bucket } from "@cloudflare/workers-types"
import { AttachmentLimits, MediaId } from "@dream/domain"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type { HttpServerRequest } from "effect/http/HttpServerRequest"
import { Tokens } from "../auth/Tokens.ts"
import { Attachments } from "../db/Attachments.ts"
import { Projects } from "../db/Projects.ts"

export class MediaStore extends Context.Service<MediaStore, { readonly bucket: Option.Option<R2Bucket> }>()(
  "@dream/api/MediaStore"
) {
  static readonly layer = (bucket: R2Bucket | undefined) =>
    Layer.succeed(MediaStore, MediaStore.of({ bucket: Option.fromUndefinedOr(bucket) }))
}

const text = (status: number, body: string) => HttpServerResponse.text(body, { status })

export const parseRange = (
  header: string | undefined,
  size: number
): Option.Option<{ readonly offset: number; readonly length: number }> => {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return Option.none()
  const [, startText, endText] = match
  if (startText === "" && endText === "") return Option.none()
  if (startText === "") {
    const suffix = Math.min(Number(endText), size)
    return Option.some({ offset: size - suffix, length: suffix })
  }
  const start = Number(startText)
  const end = endText === "" ? size - 1 : Math.min(Number(endText), size - 1)
  if (start > end || start >= size) return Option.none()
  return Option.some({ offset: start, length: end - start + 1 })
}

/** PUT /media/:id/upload?token=… */
export const uploadMedia = (request: HttpServerRequest, rawId: string, raw: Request) =>
  Effect.gen(function* () {
    const store = yield* MediaStore
    const tokens = yield* Tokens
    const projects = yield* Projects
    if (Option.isNone(store.bucket)) return text(503, "Media storage isn't enabled yet.")
    const id = Schema.decodeUnknownOption(MediaId)(rawId)
    const token = new URL(request.url, "https://api").searchParams.get("token")
    if (Option.isNone(id) || token === null) return text(400, "Missing media id or token.")
    const claims = yield* tokens.verifyUpload(token).pipe(Effect.option)
    if (Option.isNone(claims) || claims.value.mid !== id.value) return text(401, "Invalid or expired upload token.")
    const row = yield* projects.media(id.value)
    if (Option.isNone(row) || row.value.project_id !== claims.value.pid) return text(404, "Unknown media.")
    if (raw.body === null) return text(400, "No body.")
    const bucket = store.bucket.value
    yield* Effect.promise(() =>
      bucket.put(row.value.object_key, raw.body as any, { httpMetadata: { contentType: claims.value.ct } })
    )
    yield* projects.markUploaded(id.value, yield* DateTime.now)
    return HttpServerResponse.empty({ status: 204 })
  })

/** GET /media/:id (media or an attachment) for its owner (session token in Authorization or `?token=`). */
export const downloadMedia = (request: HttpServerRequest, rawId: string, userId: string) =>
  Effect.gen(function* () {
    const store = yield* MediaStore
    if (Option.isNone(store.bucket)) return text(404, "Not found.")
    const id = Schema.decodeUnknownOption(MediaId)(rawId)
    if (Option.isNone(id)) return text(404, "Not found.")
    const stored = yield* storedFor(id.value)
    if (Option.isNone(stored) || stored.value.userId !== userId || !stored.value.uploaded)
      return text(404, "Not found.")
    const bucket = store.bucket.value
    const ref = stored.value
    const range = parseRange(request.headers["range"], ref.sizeBytes)
    const object = yield* Effect.promise(() =>
      bucket.get(ref.objectKey, Option.isSome(range) ? { range: range.value } : {})
    )
    if (object === null || !("body" in object)) return text(404, "Not found.")
    const headers: Record<string, string> = {
      "content-type": ref.contentType,
      "cache-control": "private, max-age=31536000, immutable",
      "accept-ranges": "bytes"
    }
    if (Option.isSome(range)) {
      const { offset, length } = range.value
      headers["content-range"] = `bytes ${offset}-${offset + length - 1}/${ref.sizeBytes}`
      headers["content-length"] = String(length)
      return HttpServerResponse.raw(new Response(object.body as any, { status: 206, headers }))
    }
    headers["content-length"] = String(ref.sizeBytes)
    return HttpServerResponse.raw(new Response(object.body as any, { status: 200, headers }))
  })

/** The agent's media or one of their attachments, as downloads need it. */
const storedFor = (id: MediaId) =>
  Effect.gen(function* () {
    const media = yield* (yield* Projects).media(id)
    if (Option.isSome(media)) {
      const row = media.value
      return Option.some({
        userId: row.user_id,
        objectKey: row.object_key,
        contentType: row.ref_json.contentType as string,
        sizeBytes: row.ref_json.sizeBytes,
        uploaded: row.uploaded_at !== null
      })
    }
    return Option.map(yield* (yield* Attachments).find(id), (row) => ({
      userId: row.user_id,
      objectKey: row.object_key,
      contentType: row.ref_json.contentType,
      sizeBytes: row.ref_json.sizeBytes,
      uploaded: row.uploaded_at !== null
    }))
  })

/** PUT /attachments/:id/upload?token=…: one photo or file they're attaching, exactly the size they said. */
export const uploadAttachment = (request: HttpServerRequest, rawId: string, raw: Request) =>
  Effect.gen(function* () {
    const store = yield* MediaStore
    const tokens = yield* Tokens
    const attachments = yield* Attachments
    if (Option.isNone(store.bucket)) return text(503, "Storage isn't enabled yet.")
    const id = Schema.decodeUnknownOption(MediaId)(rawId)
    const token = new URL(request.url, "https://api").searchParams.get("token")
    if (Option.isNone(id) || token === null) return text(400, "Missing attachment id or token.")
    const claims = yield* tokens.verifyAttachmentUpload(token).pipe(Effect.option)
    if (Option.isNone(claims) || claims.value.aid !== id.value) return text(401, "Invalid or expired upload token.")
    const row = yield* attachments.find(id.value)
    if (Option.isNone(row) || row.value.user_id !== claims.value.sub) return text(404, "Unknown attachment.")
    const declared = Number(request.headers["content-length"] ?? claims.value.size)
    if (declared > AttachmentLimits.maxBytes) return text(413, "That's larger than Dream takes.")
    if (declared !== claims.value.size) return text(400, "That isn't the size this upload was started with.")
    const bytes = yield* Effect.promise(() => raw.arrayBuffer())
    if (bytes.byteLength !== claims.value.size) return text(400, "That isn't the size this upload was started with.")
    const bucket = store.bucket.value
    yield* Effect.promise(() =>
      bucket.put(row.value.object_key, bytes, { httpMetadata: { contentType: claims.value.ct } })
    )
    yield* attachments.markUploaded(id.value, yield* DateTime.now)
    return HttpServerResponse.empty({ status: 204 })
  })

/** GET /sandbox/attachments/:id for dreamd, with the token of the project it was sent to. */
export const downloadAttachmentForSandbox = (rawId: string, projectId: string) =>
  Effect.gen(function* () {
    const store = yield* MediaStore
    const attachments = yield* Attachments
    if (Option.isNone(store.bucket)) return text(404, "Not found.")
    const id = Schema.decodeUnknownOption(MediaId)(rawId)
    if (Option.isNone(id)) return text(404, "Not found.")
    const row = yield* attachments.find(id.value)
    if (Option.isNone(row) || row.value.project_id !== projectId || row.value.uploaded_at === null) {
      return text(404, "Not found.")
    }
    const bucket = store.bucket.value
    const object = yield* Effect.promise(() => bucket.get(row.value.object_key))
    if (object === null || !("body" in object)) return text(404, "Not found.")
    return HttpServerResponse.raw(
      new Response(object.body as any, {
        status: 200,
        headers: {
          "content-type": row.value.ref_json.contentType,
          "content-length": String(row.value.ref_json.sizeBytes)
        }
      })
    )
  })
