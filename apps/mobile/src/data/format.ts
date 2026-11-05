/**
 * How dates, phases and usage read on screen, in the phone's time zone.
 * `timeZone` is a parameter so tests can pin it.
 */
import type { ModelConnection, ProjectPhase, UsageSnapshot } from "@dream/domain"
import { DateTime } from "effect"

const fmt = (options: Intl.DateTimeFormatOptions, timeZone?: string) =>
  new Intl.DateTimeFormat("en-US", timeZone ? { ...options, timeZone } : options)

/** Calendar day key in the zone, for comparing days. */
const dayKey = (dt: DateTime.Utc, timeZone?: string) =>
  fmt({ year: "numeric", month: "2-digit", day: "2-digit" }, timeZone).format(DateTime.toDateUtc(dt))

const dayOffset = (dt: DateTime.Utc, now: DateTime.Utc, timeZone?: string) => {
  const [a, b] = [dayKey(dt, timeZone), dayKey(now, timeZone)].map((key) => {
    const [month, day, year] = key.split("/").map(Number)
    return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)
  })
  return Math.round(((a ?? 0) - (b ?? 0)) / 86_400_000)
}

/** "2:09 PM" */
export const timeLabel = (dt: DateTime.Utc, timeZone?: string) =>
  fmt({ hour: "numeric", minute: "2-digit" }, timeZone).format(DateTime.toDateUtc(dt))

/** Chat day dividers: "Today", "Yesterday", "Tue, Oct 13". */
export const dayLabel = (dt: DateTime.Utc, now: DateTime.Utc, timeZone?: string) => {
  const offset = dayOffset(dt, now, timeZone)
  if (offset === 0) return "Today"
  if (offset === -1) return "Yesterday"
  return fmt({ weekday: "short", month: "short", day: "numeric" }, timeZone).format(DateTime.toDateUtc(dt))
}

export const sameDay = (a: DateTime.Utc, b: DateTime.Utc, timeZone?: string) => dayKey(a, timeZone) === dayKey(b, timeZone)

/** Milestone dates: "Today", "Oct 14", or for what's ahead "Tomorrow, 7:00". */
export const milestoneDate = (dt: DateTime.Utc, now: DateTime.Utc, timeZone?: string) => {
  const offset = dayOffset(dt, now, timeZone)
  if (offset === 0) return DateTime.isGreaterThan(dt, now) ? `Today, ${clock(dt, timeZone)}` : "Today"
  if (offset === 1) return `Tomorrow, ${clock(dt, timeZone)}`
  if (offset > 1 && offset < 7) return `${fmt({ weekday: "long" }, timeZone).format(DateTime.toDateUtc(dt))}, ${clock(dt, timeZone)}`
  return fmt({ month: "short", day: "numeric" }, timeZone).format(DateTime.toDateUtc(dt))
}

/** "7:00" for whole hours in the morning reads like the mock; otherwise "7:30 PM". */
const clock = (dt: DateTime.Utc, timeZone?: string) => {
  const label = timeLabel(dt, timeZone)
  return label.replace(/ AM$/, "")
}

/** "Building", "Live", … and "Looking into this" for a project the agent hasn't described yet. */
export const phaseLabel = (phase: ProjectPhase) => {
  switch (phase) {
    case "new":
      return "Looking into this"
    case "interviewing":
      return "Interviewing"
    case "exploring":
      return "Exploring"
    case "building":
      return "Building"
    case "live":
      return "Live"
  }
}

/** "day 3" of the current phase, counting the first day as 1. */
export const dayOfPhase = (since: DateTime.Utc, now: DateTime.Utc, timeZone?: string) =>
  `day ${Math.max(1, 1 - dayOffset(since, now, timeZone))}`

/** "1h", "25m": the short countdown inside the pause ring. */
export const shortDuration = (from: DateTime.Utc, to: DateTime.Utc) => {
  const minutes = Math.max(0, Math.round((DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from)) / 60_000))
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`
  return `${minutes}m`
}

/** "ChatGPT Pro · 62% of this week left", or the paused line when a limit is hit. */
export const usageLine = (usage: UsageSnapshot, timeZone?: string): string | undefined => {
  const plan = usage.plan ?? (usage.provider === "chatgpt" ? "ChatGPT" : "Claude")
  if (usage.limitedUntil) return `${plan} · paused until ${timeLabel(usage.limitedUntil.until, timeZone)}`
  if (usage.weekly) return `${plan} · ${Math.round(100 - usage.weekly.usedPercent)}% of this week left`
  if (usage.fiveHour) return `${plan} · ${Math.round(100 - usage.fiveHour.usedPercent)}% left for now`
  return undefined
}

/** Fraction of the weekly window left, for the little bar next to the usage line. */
export const usageLeft = (usage: UsageSnapshot) =>
  usage.weekly ? 1 - usage.weekly.usedPercent / 100 : usage.fiveHour ? 1 - usage.fiveHour.usedPercent / 100 : 1

export const providerName = (provider: ModelConnection["provider"]) => (provider === "chatgpt" ? "ChatGPT" : "Claude")
