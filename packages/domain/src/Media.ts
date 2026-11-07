/**
 * Screenshots and screen recordings the agent attaches to messages and to the
 * Status card. Bytes live in R2; everything else refers to a `MediaRef`.
 */
import { Schema } from "effect"
import { MediaId } from "./Ids.ts"

/**
 * `audio` was added in November 2026 for a question's option previews (`QuestionPreview`), the only place the API
 * accepts it, since an older app can't decode it: it skips the previews whole, and a status card or message with
 * audio in it would be one it couldn't show.
 */
export const MediaKind = Schema.Literals(["image", "video", "audio"])
export type MediaKind = typeof MediaKind.Type

/** Content types the agent can upload: png, jpg or mp4, and for option previews mp3, m4a or wav. */
export const MediaContentType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "video/mp4",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav"
])
export type MediaContentType = typeof MediaContentType.Type

/** The kind of media a content type is. */
export const mediaKind = (contentType: MediaContentType): MediaKind =>
  contentType.startsWith("video/") ? "video" : contentType.startsWith("audio/") ? "audio" : "image"

/**
 * A stored piece of media. The phone loads the bytes from the API at
 * `Routes.media(id)` with its session token.
 */
export const MediaRef = Schema.Struct({
  id: MediaId,
  kind: MediaKind,
  contentType: MediaContentType,
  sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Pixels, when the uploader measured them (`dream` does for png, jpg and mp4). */
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

// ---------------------------------------------------------------------------
// Attachments: photos and files they send
// ---------------------------------------------------------------------------

/** How big and how many: the app downscales photos to `photoMaxDimension` on the long edge before uploading. */
export const AttachmentLimits = {
  maxBytes: 25 * 1024 * 1024,
  perMessage: 10,
  photoMaxDimension: 2048
} as const

const unsafeNameCharacters = /[/\\\u0000-\u001f\u007f]/
const maxNameLength = 120

/**
 * A file name that is safe as the last part of a path: no slashes or control characters, not `.` or `..`, no
 * leading dot, at most 120 characters. `safeAttachmentName` turns any name into one.
 */
export const AttachmentName = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (name) =>
      (!unsafeNameCharacters.test(name) && !name.startsWith(".") && name.length <= maxNameLength) ||
      "an attachment name can't contain slashes or control characters, start with a dot, or exceed 120 characters"
  )
)
export type AttachmentName = typeof AttachmentName.Type

/** `name` made into an `AttachmentName`, keeping its extension where it can. */
export const safeAttachmentName = (name: string): AttachmentName => {
  const cleaned = name.replace(new RegExp(unsafeNameCharacters.source, "g"), "-").trim().replace(/^\.+/, "").trim()
  if (cleaned.length === 0) return "attachment"
  if (cleaned.length <= maxNameLength) return cleaned
  const dot = cleaned.lastIndexOf(".")
  const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : ""
  return cleaned.slice(0, maxNameLength - extension.length).trimEnd() + extension
}

/** A MIME type such as `image/jpeg` or `application/pdf`. */
export const AttachmentContentType = Schema.String.check(
  Schema.makeFilter(
    (type) => /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(type) || "expected a MIME type"
  )
)

/**
 * A photo or file they attached to a message or a new idea. Bytes live in R2: the phone loads them at
 * `Routes.media(id)` like a `MediaRef`, and dreamd copies them into the sandbox at `attachmentPath` before the turn
 * that reads the message. Added in November 2026; older apps and dreamd builds ignore attachments.
 */
export const Attachment = Schema.Struct({
  id: MediaId,
  name: AttachmentName,
  contentType: AttachmentContentType,
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: AttachmentLimits.maxBytes })),
  /** Photos: their size in pixels, after the app downscaled them. */
  width: Schema.optionalKey(Schema.Int),
  height: Schema.optionalKey(Schema.Int)
})
export type Attachment = typeof Attachment.Type

export const isImageAttachment = (attachment: Attachment): boolean => attachment.contentType.startsWith("image/")

/** Where dreamd puts a message's attachments: one folder per message. */
export const SandboxAttachmentDir = "/home/user/.dream/attachments"

export const attachmentPath = (messageId: string, attachment: Pick<Attachment, "name">): string =>
  `${SandboxAttachmentDir}/${messageId}/${attachment.name}`

/** Gives repeated names in one message a number ("scan.jpg", "scan 2.jpg"), so each has its own path. */
export const uniqueAttachmentNames = <A extends Pick<Attachment, "name">>(
  attachments: ReadonlyArray<A>
): ReadonlyArray<A> => {
  const taken = new Set<string>()
  return attachments.map((attachment) => {
    let name = attachment.name
    const dot = name.lastIndexOf(".")
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""]
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = safeAttachmentName(`${stem} ${n}${extension}`)
    taken.add(name.toLowerCase())
    return name === attachment.name ? attachment : { ...attachment, name }
  })
}

/** "412 KB", "3.1 MB". */
export const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`
