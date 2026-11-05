/** Turning what the agent types into domain values, with messages that say what's accepted. */
import type { MediaContentType } from "@dream/domain"
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

export const mediaType = (file: string): Result.Result<MediaContentType, string> => {
  const type = mediaTypes[file.split(".").pop()?.toLowerCase() ?? ""]
  return type === undefined ? Result.fail(`${file}: attach png, jpg or mp4 files.`) : Result.succeed(type)
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
