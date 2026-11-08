/** Turning what the agent types into domain values, with messages that say what's accepted. */
import { isSingleEmoji, type MediaContentType } from "@dream/domain"
import { Cron, DateTime, Duration, Result } from "effect"

const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/**
 * `--at`: an ISO 8601 time with a zone ("2026-11-05T07:00:00-08:00", "…Z"), or
 * a span from now ("90s", "30m", "2h", "1h30m", "1d", optionally "in 2h" or "+2h").
 */
export const parseAt = (input: string, now: DateTime.Utc): Result.Result<DateTime.Utc, string> => {
  const text = input.trim().replace(/^(in\s+|\+)/i, "")
  const span = /^(\d+(?:\.\d+)?[smhdw])+$/i.exec(text.replace(/\s+/g, ""))
  if (span !== null) {
    let millis = 0
    for (const [, amount, unit] of text.replace(/\s+/g, "").matchAll(/(\d+(?:\.\d+)?)([smhdw])/gi)) {
      millis += Number(amount) * (units[unit!.toLowerCase()] ?? 0)
    }
    return Result.succeed(DateTime.addDuration(now, Duration.millis(millis)))
  }
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && /(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const parsed = DateTime.make(text)
    if (parsed._tag === "Some") return Result.succeed(DateTime.toUtc(parsed.value))
  }
  return Result.fail(
    `Can't read --at "${input}". Use an ISO time with a zone (2026-11-05T07:00:00-08:00 or …Z) or a span like 30m, 2h, 1d.`
  )
}

/** `dream logs --since`: an ISO 8601 time with a zone, or a span back from now ("30m", "2h", "1d"). */
export const parseSince = (input: string, now: DateTime.Utc): Result.Result<DateTime.Utc, string> => {
  const text = input
    .trim()
    .replace(/\s+ago$/i, "")
    .replace(/^-/, "")
  if (/^(\d+(?:\.\d+)?[smhdw])+$/i.test(text.replace(/\s+/g, ""))) {
    let millis = 0
    for (const [, amount, unit] of text.replace(/\s+/g, "").matchAll(/(\d+(?:\.\d+)?)([smhdw])/gi)) {
      millis += Number(amount) * (units[unit!.toLowerCase()] ?? 0)
    }
    return Result.succeed(DateTime.subtractDuration(now, Duration.millis(millis)))
  }
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && /(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const parsed = DateTime.make(text)
    if (parsed._tag === "Some") return Result.succeed(DateTime.toUtc(parsed.value))
  }
  return Result.fail(
    `Can't read --since "${input}". Use a span back from now like 30m, 2h, 1d, or an ISO time with a zone (…Z).`
  )
}

/** `--cron`: five fields, checked here so a typo fails before it's scheduled. */
export const checkCron = (expression: string): Result.Result<string, string> =>
  expression.trim().split(/\s+/).length === 5 && Result.isSuccess(Cron.parse(expression))
    ? Result.succeed(expression.trim())
    : Result.fail(`"${expression}" isn't a five-field cron expression (minute hour day month weekday).`)

/** `--step 3/5`. */
export const parseStep = (input: string): Result.Result<{ current: number; total: number }, string> => {
  const match = /^\s*(\d+)\s*(?:\/|of)\s*(\d+)\s*$/.exec(input)
  return match === null
    ? Result.fail(`Can't read --step "${input}"; use current/total, like 3/5.`)
    : Result.succeed({ current: Number(match[1]), total: Number(match[2]) })
}

const mediaTypes: Record<string, MediaContentType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  mp4: "video/mp4"
}

const audioTypes: Record<string, MediaContentType> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav"
}

/** A file's content type from its extension. Audio only where `audio` says it can go (an option's preview). */
export const mediaType = (file: string, audio = false): Result.Result<MediaContentType, string> => {
  const extension = file.split(".").pop()?.toLowerCase() ?? ""
  const type = mediaTypes[extension] ?? (audio ? audioTypes[extension] : undefined)
  if (type !== undefined) return Result.succeed(type)
  if (audioTypes[extension] !== undefined) {
    return Result.fail(
      `${file}: audio plays only as an option's preview (\`dream ask --show\`); attach png, jpg or mp4 here.`
    )
  }
  return Result.fail(`${file}: attach png, jpg or mp4 files${audio ? ", or mp3, m4a or wav" : ""}.`)
}

/**
 * `--show "<option>=<files>"`: the option's text, then a file, a glob, or several separated by commas. Split at the
 * last "=", since an option's text is likelier to hold one than a path is.
 */
export const parseShow = (input: string): Result.Result<{ option: string; files: ReadonlyArray<string> }, string> => {
  const at = input.lastIndexOf("=")
  const option = at < 0 ? "" : input.slice(0, at).trim()
  const files =
    at < 0
      ? []
      : input
          .slice(at + 1)
          .split(",")
          .map((file) => file.trim())
          .filter((file) => file !== "")
  return option === "" || files.length === 0
    ? Result.fail(
        `Can't read --show "${input}"; use --show "<option>=<files>", like --show "Calendar first=shots/a-*.png".`
      )
    : Result.succeed({ option, files })
}

/** `dream mac cp` paths: `mac:<path>` is on the Mac (relative to its home), anything else is here. */
export interface CopyPlan {
  readonly direction: "to-mac" | "from-mac"
  readonly sources: ReadonlyArray<string>
  readonly destination: string
}

export const planCopy = (paths: ReadonlyArray<string>): Result.Result<CopyPlan, string> => {
  const usage = "Use `dream mac cp <src>... mac:<dst>` or `dream mac cp mac:<src>... <dst>`."
  if (paths.length < 2) return Result.fail(`Name a source and a destination. ${usage}`)
  const onMac = (path: string) => path.startsWith("mac:")
  const strip = (path: string) => path.slice("mac:".length)
  const sources = paths.slice(0, -1)
  const destination = paths[paths.length - 1]!
  if (onMac(destination) && !sources.some(onMac))
    return Result.succeed({ direction: "to-mac", sources, destination: strip(destination) })
  if (!onMac(destination) && sources.every(onMac))
    return Result.succeed({ direction: "from-mac", sources: sources.map(strip), destination })
  return Result.fail(`One side must be the Mac (mac:<path>) and the other this sandbox. ${usage}`)
}

/** What `--icon` names: an SF Symbol, one emoji, an image file to upload, or "" (update only: a monogram). */
export type IconInput =
  | { readonly _tag: "Symbol"; readonly name: string }
  | { readonly _tag: "Emoji"; readonly emoji: string }
  | { readonly _tag: "File"; readonly path: string }
  | { readonly _tag: "Clear" }

export const iconInput = (text: string): Result.Result<IconInput, string> => {
  const value = text.trim()
  if (value === "") return Result.succeed({ _tag: "Clear" })
  if (/\.(png|jpe?g)$/i.test(value)) return Result.succeed({ _tag: "File", path: value })
  if (/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(value) && value.length <= 64)
    return Result.succeed({ _tag: "Symbol", name: value })
  if (isSingleEmoji(value)) return Result.succeed({ _tag: "Emoji", emoji: value })
  return Result.fail(
    `--icon "${text}" isn't an SF Symbol name (lowercase, dotted: dumbbell, sun.horizon.fill), one emoji, or a png/jpg file.`
  )
}

/** Width and height of a png or jpg, from its header. */
export const imageSize = (bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return undefined
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1]!
    const length = view.getUint16(offset + 2)
    // SOF0–SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
    }
    offset += 2 + length
  }
  return undefined
}

/** The smallest icon image that stays sharp on a tile and as a Home Screen icon (180 × 180 px on iPhone). */
export const IconMinPixels = 180

/** Why an image can't be a link's icon, or undefined if it can. */
export const iconImageProblem = (
  file: string,
  size: { readonly width: number; readonly height: number } | undefined
) => {
  if (size === undefined) return `${file} isn't a png or jpg Dream can read.`
  const { width, height } = size
  if (Math.abs(width - height) > Math.max(width, height) * 0.02) {
    return `${file} is ${width}×${height}; an icon has to be square (it fills the tile, which iOS rounds).`
  }
  if (width < IconMinPixels)
    return `${file} is ${width}×${height}; make it at least ${IconMinPixels}×${IconMinPixels} so it's sharp.`
  return undefined
}

/**
 * A file's name as a caption, without the letters and numbers that only order the files: "a-2-the-clash.png" reads
 * "The clash". Nothing for a name that's only those ("b.mp4").
 */
export const captionOf = (file: string): string | undefined => {
  const name = (file.split("/").pop() ?? "")
    .replace(/\.[^.]+$/, "")
    .replace(/^((?:[a-z]|\d+)(?:[-_ .]+|$))+/i, "")
    .replace(/[-_]+/g, " ")
    .trim()
  return name === "" ? undefined : name.charAt(0).toUpperCase() + name.slice(1)
}
