/**
 * How a project's apps that notify read in the Notifications sheet: each app's line, its controls, and its
 * history. Plain functions of the API's `AppNotifications`, so they're tested in Node. `timeZone` is a parameter so
 * tests can pin it.
 */
import { type AppNotification, type AppSender, reachedPhone } from "@dream/domain"
import { DateTime } from "effect"
import { dayLabel, timeLabel } from "./format.ts"

/** "Mute for today": until the start of tomorrow, where they are. */
export const startOfTomorrow = (now: DateTime.Utc, timeZone?: string): DateTime.Utc => {
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23"
  }).formatToParts(DateTime.toDateUtc(now))
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  // What time it is there, as if it were UTC; the difference from real UTC is the zone's offset right now.
  const local = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"))
  const offset = local - Math.floor(DateTime.toEpochMillis(now) / 1000) * 1000
  const midnight = Date.UTC(part("year"), part("month") - 1, part("day") + 1)
  return DateTime.makeUnsafe(midnight - offset)
}

export const isMuted = (app: AppSender, now: DateTime.Utc) =>
  app.mutedUntil !== undefined && DateTime.isGreaterThan(app.mutedUntil, now)

/** The line under the app's name: where it stands with them, and what it's sent lately. */
export const appLine = (
  app: AppSender,
  notifications: ReadonlyArray<AppNotification>,
  now: DateTime.Utc,
  timeZone?: string
): string => {
  if (app.state._tag === "Waiting") return "Waiting for you to allow it"
  if (app.state._tag === "Declined") return "You said not now"
  if (isMuted(app, now)) {
    const until = app.mutedUntil!
    const tomorrow = DateTime.toEpochMillis(startOfTomorrow(now, timeZone))
    const untilMs = DateTime.toEpochMillis(until)
    if (Math.abs(untilMs - tomorrow) < 60_000) return "Muted for today"
    if (untilMs < tomorrow) return `Muted until ${timeLabel(until, timeZone)}`
    return `Muted until ${dayLabel(until, now, timeZone)}`
  }
  const own = notifications.filter((n) => n.app === app.id && reachedPhone(n.outcome))
  if (own.length === 0) return app.delivery === "off" ? "Off" : "Nothing sent yet"
  const opened = own.filter((n) => n.openedAt !== undefined).length
  return `${own.length} in the last 30 days · you opened ${opened}`
}

/** What a history row says besides its text: what happened to it, when it didn't simply arrive. */
export const historyTag = (n: AppNotification): string | undefined => {
  if (n.withdrawnAt !== undefined) return "Withdrawn"
  if (n.replacedAt !== undefined) return "Replaced"
  switch (n.outcome) {
    case "held":
      return "Held · too many"
    case "muted":
      return "Muted"
    case "quiet":
      return "Quietly"
    default:
      return undefined
  }
}

export interface HistoryRow {
  readonly id: AppNotification["id"]
  readonly title: string
  /** The text under the title; absent when the title is the text's first line. */
  readonly text: string | undefined
  readonly time: string
  readonly tag: string | undefined
  /** Faded: it never reached their phone, or something took its place. */
  readonly dim: boolean
  readonly url: string | undefined
}

/** One app's history, newest first, as the sheet lists it. */
export const historyRows = (
  app: AppSender,
  notifications: ReadonlyArray<AppNotification>,
  now: DateTime.Utc,
  timeZone?: string
): ReadonlyArray<HistoryRow> =>
  notifications
    .filter((n) => n.app === app.id)
    .map((n) => {
      const day = dayLabel(n.sentAt, now, timeZone)
      const tag = historyTag(n)
      return {
        id: n.id,
        title: n.title ?? n.text,
        text: n.title === undefined ? undefined : n.text,
        time: day === "Today" ? timeLabel(n.sentAt, timeZone) : day,
        tag,
        dim: tag !== undefined && tag !== "Quietly",
        url: n.url ?? app.url
      }
    })
