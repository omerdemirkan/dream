/**
 * Where their subscription stands, read from what each harness reports.
 *
 * - Claude Code emits `rate_limit_event` messages (forwarded by the harness as
 *   `raw` stream parts) whenever the plan's limits change: `status`
 *   (`allowed`, `allowed_warning`, `rejected`), the binding `rateLimitType`,
 *   its `resetsAt` (epoch seconds), and `unifiedWindows` with each window's
 *   `utilization` (0–1) and `resetsAt`.
 * - Codex records `token_count` events in its rollout file
 *   (`~/.codex/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`) with
 *   `rate_limits.primary` / `secondary`: `used_percent` (0–100),
 *   `window_minutes` and `resets_at` (epoch seconds), parsed from the
 *   ChatGPT backend's `x-codex-*` headers. A turn that hits a limit ends with
 *   `task_complete.error.codex_error_info: "usage_limit_exceeded"`. The Codex
 *   harness doesn't forward either, so dreamd reads the rollout after each turn
 *   (and once after the turn's first model call, for a fresh "before").
 *
 * Claude Code puts a window in `unifiedWindows` only when the API's response
 * headers carry its utilization (`anthropic-ratelimit-unified-5h-utilization`,
 * `…-7d-…`; checked against Claude Code 2.1.318 with a fake server), and the
 * API doesn't always send both: every reading from the founder's Max plan so
 * far had the weekly window alone, the one it named as binding
 * (`rateLimitType`), even at 4%. So a missing window isn't zero, it's unknown,
 * and stays so until the API reports it.
 */
import type { ModelProvider, UsageSnapshot, UsageWindow, UsageWindowName } from "@dream/domain"
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"

export interface UsageReading {
  readonly fiveHour?: UsageWindow
  readonly weekly?: UsageWindow
  readonly plan?: string
  /** A limit is hit: no turns can run until then. */
  readonly limit?: { readonly window: UsageWindowName; readonly until: DateTime.Utc }
}

/** Later readings win, window by window. */
export const merge = (previous: UsageReading, next: UsageReading): UsageReading => {
  const fiveHour = next.fiveHour ?? previous.fiveHour
  const weekly = next.weekly ?? previous.weekly
  const plan = next.plan ?? previous.plan
  const limit = next.limit ?? previous.limit
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(weekly === undefined ? {} : { weekly }),
    ...(plan === undefined ? {} : { plan }),
    ...(limit === undefined ? {} : { limit })
  }
}

export const toSnapshot = (provider: ModelProvider, reading: UsageReading, now: DateTime.Utc): UsageSnapshot => ({
  provider,
  ...(reading.plan === undefined ? {} : { plan: reading.plan }),
  ...(reading.fiveHour === undefined ? {} : { fiveHour: reading.fiveHour }),
  ...(reading.weekly === undefined ? {} : { weekly: reading.weekly }),
  ...(reading.limit === undefined || DateTime.isLessThanOrEqualTo(reading.limit.until, now)
    ? {}
    : { limitedUntil: reading.limit }),
  observedAt: now
})

/** When a harness says a limit is hit but not when it resets. */
export const fallbackLimit = (window: UsageWindowName, now: DateTime.Utc) => ({
  window,
  until: DateTime.add(now, { hours: 1 })
})

const percent = (value: number) => Math.min(100, Math.max(0, value))
const fromEpochSeconds = (seconds: number) => DateTime.makeUnsafe(seconds * 1000)
const window = (usedPercent: number, resetsAt: number | null | undefined): UsageWindow => ({
  usedPercent: percent(usedPercent),
  ...(resetsAt == null ? {} : { resetsAt: fromEpochSeconds(resetsAt) })
})

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const ClaudeWindow = Schema.Struct({ utilization: Schema.Finite, resetsAt: Schema.Finite })

export const ClaudeRateLimitEvent = Schema.Struct({
  type: Schema.Literal("rate_limit_event"),
  rate_limit_info: Schema.Struct({
    status: Schema.String,
    resetsAt: Schema.optionalKey(Schema.Finite),
    rateLimitType: Schema.optionalKey(Schema.String),
    utilization: Schema.optionalKey(Schema.Finite),
    unifiedWindows: Schema.optionalKey(
      Schema.Struct({
        five_hour: Schema.optionalKey(ClaudeWindow),
        seven_day: Schema.optionalKey(ClaudeWindow)
      })
    )
  })
})

const decodeClaudeRateLimit = Schema.decodeUnknownOption(ClaudeRateLimitEvent)

const claudeWindowName = (rateLimitType: string | undefined): UsageWindowName | undefined =>
  rateLimitType === "five_hour" ? "fiveHour" : rateLimitType?.startsWith("seven_day") ? "weekly" : undefined

/** A `raw` stream part from the Claude Code harness, if it's a rate-limit event. */
export const fromClaudeRaw = (raw: unknown, now: DateTime.Utc): Option.Option<UsageReading> =>
  decodeClaudeRateLimit(raw).pipe(
    Option.map(({ rate_limit_info: info }): UsageReading => {
      const named = claudeWindowName(info.rateLimitType)
      const top = info.utilization === undefined ? undefined : window(info.utilization * 100, info.resetsAt ?? null)
      const fiveHour = info.unifiedWindows?.five_hour
        ? window(info.unifiedWindows.five_hour.utilization * 100, info.unifiedWindows.five_hour.resetsAt)
        : named === "fiveHour"
          ? top
          : undefined
      const weekly = info.unifiedWindows?.seven_day
        ? window(info.unifiedWindows.seven_day.utilization * 100, info.unifiedWindows.seven_day.resetsAt)
        : named === "weekly"
          ? top
          : undefined
      const limitWindow = named ?? ((weekly?.usedPercent ?? 0) >= (fiveHour?.usedPercent ?? 0) ? "weekly" : "fiveHour")
      const limit =
        info.status !== "rejected"
          ? undefined
          : info.resetsAt === undefined
            ? fallbackLimit(limitWindow, now)
            : { window: limitWindow, until: fromEpochSeconds(info.resetsAt) }
      return {
        ...(fiveHour === undefined ? {} : { fiveHour }),
        ...(weekly === undefined ? {} : { weekly }),
        ...(limit === undefined ? {} : { limit })
      }
    })
  )

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const CodexWindow = Schema.Struct({
  used_percent: Schema.Finite,
  window_minutes: Schema.NullOr(Schema.Finite),
  resets_at: Schema.NullOr(Schema.Finite)
})

const CodexRateLimits = Schema.Struct({
  primary: Schema.NullOr(CodexWindow),
  secondary: Schema.NullOr(CodexWindow),
  plan_type: Schema.optionalKey(Schema.NullOr(Schema.String)),
  rate_limit_reached_type: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const CodexRolloutLine = Schema.Struct({
  timestamp: Schema.String,
  type: Schema.Literal("event_msg"),
  payload: Schema.Union([
    Schema.Struct({ type: Schema.Literal("token_count"), rate_limits: Schema.NullOr(CodexRateLimits) }),
    Schema.Struct({
      type: Schema.Literal("task_complete"),
      error: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({ message: Schema.String, codex_error_info: Schema.optionalKey(Schema.NullOr(Schema.String)) })
        )
      )
    })
  ])
})

const decodeRolloutLine = Schema.decodeUnknownOption(Schema.fromJsonString(CodexRolloutLine))

const codexPlans: Record<string, string> = {
  free: "ChatGPT Free",
  go: "ChatGPT Go",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  team: "ChatGPT Business",
  business: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu"
}

const codexWindowName = (minutes: number | null): UsageWindowName =>
  minutes !== null && minutes > 24 * 60 ? "weekly" : "fiveHour"

/** The usage-limit message Codex ends a turn with, for when its rollout can't be read. */
export const isCodexUsageLimitMessage = (message: string) => /hit your usage limit/i.test(message)

/**
 * The latest usage in a Codex rollout, and the limit if a turn that finished
 * after `since` hit one. With `onlySince`, usage recorded before `since` (by an
 * earlier turn) doesn't count either: what's left is this turn's own reading.
 */
export const fromCodexRollout = (
  text: string,
  since: DateTime.Utc,
  now: DateTime.Utc,
  options?: { readonly onlySince?: boolean }
): UsageReading => {
  const sinceMs = DateTime.toEpochMillis(since)
  let rateLimits: typeof CodexRateLimits.Type | undefined
  let limited = false
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0 && rateLimits === undefined; i--) {
    const line = lines[i]
    if (line === undefined || !line.includes('"event_msg"')) continue
    const decoded = decodeRolloutLine(line)
    if (Option.isNone(decoded)) continue
    const { payload, timestamp } = decoded.value
    if (payload.type === "token_count") {
      if (options?.onlySince === true && Date.parse(timestamp) < sinceMs) break
      if (payload.rate_limits !== null) rateLimits = payload.rate_limits
    } else if (payload.error?.codex_error_info === "usage_limit_exceeded" && Date.parse(timestamp) >= sinceMs) {
      limited = true
    }
  }
  if (rateLimits === undefined) return limited ? { limit: fallbackLimit("fiveHour", now) } : {}

  const windows = [rateLimits.primary, rateLimits.secondary].flatMap((raw) =>
    raw === null
      ? []
      : [{ name: codexWindowName(raw.window_minutes), raw, value: window(raw.used_percent, raw.resets_at) }]
  )
  const find = (name: UsageWindowName) => windows.find((w) => w.name === name)?.value
  const fiveHour = find("fiveHour")
  const weekly = find("weekly")
  const plan = rateLimits.plan_type == null ? undefined : (codexPlans[rateLimits.plan_type] ?? rateLimits.plan_type)

  const exhausted = windows
    .filter((w) => w.raw.used_percent >= 100 && w.value.resetsAt !== undefined)
    .sort((a, b) => DateTime.toEpochMillis(b.value.resetsAt!) - DateTime.toEpochMillis(a.value.resetsAt!))
  const reached = limited || (rateLimits.rate_limit_reached_type ?? null) !== null
  const limit =
    exhausted[0] !== undefined
      ? { window: exhausted[0].name, until: exhausted[0].value.resetsAt! }
      : reached
        ? fallbackLimit("fiveHour", now)
        : undefined
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(weekly === undefined ? {} : { weekly }),
    ...(plan === undefined ? {} : { plan }),
    ...(limit === undefined ? {} : { limit })
  }
}

/** How much of a rollout to read: its end has the latest events, and rollouts grow for the life of a project. */
const tailBytes = 1024 * 1024

/** The rollout file Codex keeps for `threadId` under `codexHome`, if there is one. */
export const findCodexRollout = Effect.fn("Usage.findCodexRollout")(function* (codexHome: string, threadId: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const sessions = path.join(codexHome, "sessions")
  if (!(yield* fs.exists(sessions))) return Option.none<string>()
  const files = yield* fs.readDirectory(sessions, { recursive: true })
  const match = files.find((file) => file.endsWith(`-${threadId}.jsonl`))
  return Option.map(Option.fromNullishOr(match), (file) => path.join(sessions, file))
})

/** The last part of a file, from a line boundary. */
export const readTail = Effect.fn("Usage.readTail")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const size = Number((yield* fs.stat(file)).size)
  if (size <= tailBytes) return yield* fs.readFileString(file)
  const bytes = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(file, { flag: "r" })
      yield* handle.seek(BigInt(size - tailBytes), "start")
      const buffer = new Uint8Array(tailBytes)
      const read = yield* handle.read(buffer)
      return buffer.subarray(0, read)
    })
  )
  const text = new TextDecoder().decode(bytes)
  return text.slice(text.indexOf("\n") + 1)
})
