/**
 * Media bytes in R2, served through the Worker: the agent's uploads (PUT with
 * a one-file upload token) and the phone's downloads (GET with its session
 * token, ranges supported so videos stream). R2 is optional until it's
 * enabled on the account; without it uploads are refused.
 */
import type { R2Bucket } from "@cloudflare/workers-types"
import { MediaId } from "@dream/domain"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type { HttpServerRequest } from "effect/http/HttpServerRequest"
import { Tokens } from "../auth/Tokens.ts"
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

/** GET /media/:id for the project's owner (session token in Authorization or `?token=`). */
export const downloadMedia = (request: HttpServerRequest, rawId: string, userId: string) =>
  Effect.gen(function* () {
    const store = yield* MediaStore
    const projects = yield* Projects
    if (Option.isNone(store.bucket)) return text(404, "Not found.")
    const id = Schema.decodeUnknownOption(MediaId)(rawId)
    if (Option.isNone(id)) return text(404, "Not found.")
    const row = yield* projects.media(id.value)
    if (Option.isNone(row) || row.value.user_id !== userId || row.value.uploaded_at === null)
      return text(404, "Not found.")
    const bucket = store.bucket.value
    const ref = row.value.ref_json
    const range = parseRange(request.headers["range"], ref.sizeBytes)
    const object = yield* Effect.promise(() =>
      bucket.get(row.value.object_key, Option.isSome(range) ? { range: range.value } : {})
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
