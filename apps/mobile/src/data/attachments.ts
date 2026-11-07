/**
 * Photos and files waiting in a composer: what they picked, whether each has uploaded yet, and the limits the API
 * holds them to. Pure, so it's tested in Node; the picking is in `platform/attachments.ts` and the upload in
 * `AttachmentUploads.ts`.
 */
import { type Attachment, AttachmentLimits, formatBytes, type MediaId } from "@dream/domain"

/** A photo or file just picked, before it's uploaded. */
export interface PickedFile {
  readonly uri: string
  readonly name: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly width?: number | undefined
  readonly height?: number | undefined
  /** From the photo library (shown as a thumbnail), or a file. */
  readonly photo: boolean
  /** Fixtures only: a bundled image to show instead of `uri`. */
  readonly preview?: number | undefined
}

export type StagedState =
  | { readonly _tag: "Uploading" }
  | { readonly _tag: "Ready"; readonly attachment: Attachment }
  | { readonly _tag: "Failed"; readonly message: string }

const Uploading: StagedState = { _tag: "Uploading" }

export interface Staged {
  readonly key: string
  readonly file: PickedFile
  readonly state: StagedState
}

/**
 * Adds what they picked, up to the limits. Files over the size limit and anything past the count are left out, and
 * `refused` says so in a sentence.
 */
export const admit = (
  staged: ReadonlyArray<Staged>,
  picked: ReadonlyArray<PickedFile>,
  key: (file: PickedFile, index: number) => string
): { readonly staged: ReadonlyArray<Staged>; readonly added: ReadonlyArray<Staged>; readonly refused?: string } => {
  const fits = picked.filter((file) => file.sizeBytes <= AttachmentLimits.maxBytes)
  const room = Math.max(0, AttachmentLimits.perMessage - staged.length)
  const added = fits.slice(0, room).map((file, index): Staged => ({ key: key(file, index), file, state: Uploading }))
  const tooBig = picked.length - fits.length
  const tooMany = fits.length - added.length
  const refused =
    tooBig > 0
      ? tooBig === 1 && picked.length === 1
        ? `That file is over ${formatBytes(AttachmentLimits.maxBytes)}, the most Dream can take.`
        : `${tooBig === 1 ? "One file is" : `${tooBig} files are`} over ${formatBytes(AttachmentLimits.maxBytes)}, so ${tooBig === 1 ? "it was" : "they were"} left out.`
      : tooMany > 0
        ? `A message can carry ${AttachmentLimits.perMessage} attachments.`
        : undefined
  return { staged: [...staged, ...added], added, ...(refused === undefined ? {} : { refused }) }
}

export const settle = (staged: ReadonlyArray<Staged>, key: string, state: StagedState): ReadonlyArray<Staged> =>
  staged.map((item) => (item.key === key ? { ...item, state } : item))

export const remove = (staged: ReadonlyArray<Staged>, key: string): ReadonlyArray<Staged> =>
  staged.filter((item) => item.key !== key)

export const isUploading = (staged: ReadonlyArray<Staged>): boolean =>
  staged.some((item) => item.state._tag === "Uploading")

/** The ids to send: uploaded ones, in the order they were picked. */
export const readyIds = (staged: ReadonlyArray<Staged>): ReadonlyArray<MediaId> =>
  staged.flatMap((item) => (item.state._tag === "Ready" ? [item.state.attachment.id] : []))

/** The size a photo is uploaded at: its long edge no more than `max`, never larger than it was. */
export const scaledTo = (
  width: number,
  height: number,
  max: number = AttachmentLimits.photoMaxDimension
): { readonly width: number; readonly height: number } => {
  const longest = Math.max(width, height)
  if (longest <= max) return { width, height }
  const scale = max / longest
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

const byExtension: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  mp4: "video/mp4",
  mov: "video/quicktime",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
}

/** The picker's MIME type if it's a real one, else one from the extension, else `application/octet-stream`. */
export const contentTypeFor = (name: string, given: string | null | undefined): string => {
  if (given && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(given)) return given.toLowerCase()
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : ""
  return byExtension[extension] ?? "application/octet-stream"
}

/** What a file chip says under the name: "PDF · 212 KB". */
export const fileDetail = (name: string, sizeBytes: number): string => {
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : ""
  return extension && extension.length <= 5 ? `${extension} · ${formatBytes(sizeBytes)}` : formatBytes(sizeBytes)
}
