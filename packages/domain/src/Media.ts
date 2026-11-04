/**
 * Screenshots and screen recordings the agent attaches to messages and to the
 * Status card. Bytes live in R2; everything else refers to a `MediaRef`.
 */
import { Schema } from "effect"
import { MediaId } from "./Ids.ts"

export const MediaKind = Schema.Literals(["image", "video"])
export type MediaKind = typeof MediaKind.Type

/** Content types the agent can upload: png, jpg, or mp4. */
export const MediaContentType = Schema.Literals(["image/png", "image/jpeg", "video/mp4"])
export type MediaContentType = typeof MediaContentType.Type

/**
 * A stored piece of media. The phone loads the bytes from the API at
 * `Routes.media(id)` with its session token.
 */
export const MediaRef = Schema.Struct({
  id: MediaId,
  kind: MediaKind,
  contentType: MediaContentType,
  sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  width: Schema.optionalKey(Schema.Int),
  height: Schema.optionalKey(Schema.Int),
  durationSeconds: Schema.optionalKey(Schema.Finite),
  /** Short label under the media, e.g. "Squat chart · draft". */
  caption: Schema.optionalKey(Schema.String)
})
export type MediaRef = typeof MediaRef.Type

/**
 * Where to send the bytes for a new upload. The API decides whether this is a
 * presigned R2 URL or its own endpoint; uploaders just send the request as given.
 */
export const MediaUploadTarget = Schema.Struct({
  url: Schema.String,
  method: Schema.Literal("PUT"),
  headers: Schema.Record(Schema.String, Schema.String),
  expiresAt: Schema.DateTimeUtc
})
export type MediaUploadTarget = typeof MediaUploadTarget.Type
