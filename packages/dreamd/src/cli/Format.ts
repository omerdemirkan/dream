/**
 * What `dream` prints. The agent reads these, so they're short, lead with
 * what happened, and include the ids it may need for a follow-up command.
 * Times are UTC, with how far away they are.
 */
import type {
  AccessMessage,
  BrowserSession,
  Integration,
  MacStatus,
  MediaRef,
  QuestionMessage,
  StatusCard,
  TextMessage,
  UsageSnapshot,
  UsageWindow,
  Wake
} from "@dream/domain"
import { accessHeading, sandboxKeyPath } from "@dream/domain"
import { DateTime } from "effect"
import type { PageLoad } from "./PageCheck.ts"

const relative = (time: DateTime.Utc, now: DateTime.Utc): string => {
  const millis = DateTime.toEpochMillis(time) - DateTime.toEpochMillis(now)
  const minutes = Math.round(Math.abs(millis) / 60_000)
  const span =
    minutes < 1
      ? "now"
      : minutes < 60
        ? `${minutes}m`
        : minutes < 48 * 60
          ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
          : `${Math.round(minutes / (24 * 60))}d`
  return span === "now" ? "now" : millis >= 0 ? `in ${span}` : `${span} ago`
}

export const time = (at: DateTime.Utc, now: DateTime.Utc): string =>
  `${DateTime.formatIso(at).replace(/:\d\d\.\d{3}Z$/, "Z")} (${relative(at, now)})`

const notified = (message: { readonly notificationId?: string }) =>
  message.notificationId === undefined ? "" : `; notification ${message.notificationId}`

export const sent = (message: TextMessage): string =>
  `Sent ${message.id}${message.media.length > 0 ? ` with ${message.media.length} attachment(s)` : ""}${notified(message)}.`

export const asked = (message: QuestionMessage): string =>
  `Asked ${message.id}${notified(message)}. Their answer arrives as an event; withdraw it with \`dream ask withdraw ${message.id}\`.`

export const withdrawn = (message: QuestionMessage): string => `Withdrew ${message.id}.`

const accessLabel = (message: AccessMessage): string => {
  switch (message.request._tag) {
    case "Google":
      return `Google (${message.request.scopes.join(", ")})`
    case "Key":
      return `a ${message.request.service} key for ${message.request.host}`
    case "File":
      return `a ${message.request.service} key in ${sandboxKeyPath(message.request.name)}`
    case "Apple":
      return "an App Store Connect API key"
    case "OAuth":
      return `${message.request.service ?? message.request.provider}${
        message.request.scopes.length === 0 ? "" : ` (${message.request.scopes.join(", ")})`
      }`
  }
}

/** When `--why` doesn't name the service, the card leads with a heading of its own; the agent hears what it says. */
const headingNote = (message: AccessMessage): string => {
  const heading = accessHeading(message)
  return heading.reason === undefined ? "" : ` Its heading reads "${heading.title}", with your --why under it.`
}

export const accessRequested = (message: AccessMessage): string =>
  (message.when === undefined
    ? `Asked for ${accessLabel(message)} as ${message.id}${notified(message)}. You'll get an event when they connect.`
    : `Noted ${accessLabel(message)} as needed ${message.when} (${message.id}); it shows as upcoming until you ask again.`) +
  headingNote(message)

export const integrations = (list: ReadonlyArray<Integration>): string => {
  if (list.length === 0) return "Nothing connected yet."
  return list
    .map((integration) => {
      const access = integration.access
      const detail =
        access._tag === "Google"
          ? `Google ${access.email ?? ""} (${access.scopes.join(", ")}); hosts ${access.hosts.join(", ")}; placeholder "${access.placeholder}"`
          : access._tag === "Key"
            ? `${access.host}, header "${access.header}: ${access.format}"; placeholder "${access.placeholder}"`
            : access._tag === "File"
              ? `key file ${access.path} (this project only; read it from your code, never print it)`
              : access._tag === "OAuth"
                ? `OAuth${access.account === undefined ? "" : ` as ${access.account}`} (${access.scopes.join(", ")}); hosts ${access.hosts.join(", ")}; placeholder "${access.placeholder}"`
                : `App Store Connect key ${access.keyId} (issuer ${access.issuerId})`
      const notes = access._tag === "OAuth" && access.notes !== undefined ? `\n  ${access.notes}` : ""
      return `${integration.label} [${integration.status}] ${detail.replace(/\s+/g, " ")}${notes}`
    })
    .join("\n")
}

const media = (refs: ReadonlyArray<MediaRef>) => (refs.length === 0 ? "" : ` [${refs.map((ref) => ref.id).join(", ")}]`)

export const status = (card: StatusCard, now: DateTime.Utc): string => {
  const lines = [`Phase: ${card.phase} since ${time(card.phaseSince, now)}`]
  if (card.pausedUntil !== undefined) lines.push(`Paused for usage until ${time(card.pausedUntil, now)}`)
  if (card.now !== undefined) lines.push(`Now: ${card.now}`)
  if (card.justDid !== undefined) lines.push(`Just did: ${card.justDid}${media(card.media)}`)
  if (card.next !== undefined) lines.push(`Next: ${card.next}`)
  if (card.milestones.length > 0) {
    lines.push("Milestones:")
    for (const milestone of card.milestones) {
      const mark = milestone.state === "done" ? "[x]" : milestone.state === "current" ? "[>]" : "[ ]"
      const date = milestone.date === undefined ? "" : ` (${DateTime.formatIso(milestone.date).slice(0, 10)})`
      lines.push(`  ${mark} ${milestone.title}${date}${milestone.detail === undefined ? "" : ` - ${milestone.detail}`}`)
      for (const need of milestone.needs) {
        lines.push(
          `      needs: ${need.what}${need.when === undefined ? "" : ` (${need.when})`}${need.messageId === undefined ? "" : ` -> ${need.messageId}`}`
        )
      }
    }
  }
  return lines.join("\n")
}

const when = (wake: Wake, now: DateTime.Utc) =>
  wake.when._tag === "At"
    ? time(wake.when.at, now)
    : `cron "${wake.when.expression}"${wake.when.timeZone === undefined ? "" : ` ${wake.when.timeZone}`}${wake.nextAt === undefined ? "" : `, next ${time(wake.nextAt, now)}`}`

export const wake = (wake: Wake, now: DateTime.Utc): string =>
  `${wake.id}: ${when(wake, now)}: "${wake.why}"${wake.run === undefined ? "" : `, runs \`${wake.run}\``}`

export const scheduled = (scheduled: Wake, now: DateTime.Utc): string => `Scheduled ${wake(scheduled, now)}.`

export const wakes = (list: ReadonlyArray<Wake>, now: DateTime.Utc): string =>
  list.length === 0 ? "No wake-ups scheduled." : list.map((item) => wake(item, now)).join("\n")

export const uploaded = (ref: MediaRef): string =>
  `${ref.id} (${ref.contentType}, ${Math.max(1, Math.round(ref.sizeBytes / 1024))} KB)`

export const browser = (session: BrowserSession): string =>
  [
    `Browser ${session.id} is running; it's recorded until it stops.`,
    `CDP: ${session.cdpUrl}`,
    `Live view: ${session.liveViewUrl}`,
    `Stop it with \`dream browser stop ${session.id}\`; get the recording with \`dream browser recording ${session.id}\`.`
  ].join("\n")

export const mac = (status: MacStatus, now: DateTime.Utc): string =>
  status.state === "stopped"
    ? "No Mac is running. `dream mac start` rents one."
    : `The Mac is ${status.state}${status.startedAt === undefined ? "" : ` (started ${time(status.startedAt, now)})`}; it stops after ${status.idleTimeoutMinutes} idle minutes. Run commands with \`dream mac ssh -- <cmd>\`.`

const window = (name: string, value: UsageWindow | undefined, now: DateTime.Utc) =>
  value === undefined
    ? []
    : [
        `${name}: ${Math.round(value.usedPercent)}% used${value.resetsAt === undefined ? "" : `, resets ${time(value.resetsAt, now)}`}`
      ]

export const usage = (snapshot: UsageSnapshot, now: DateTime.Utc): string =>
  [
    `${snapshot.plan ?? (snapshot.provider === "claude" ? "Claude" : "ChatGPT")} subscription, as of ${time(snapshot.observedAt, now)}`,
    ...window("Five-hour window", snapshot.fiveHour, now),
    ...window("Weekly limit", snapshot.weekly, now),
    ...(snapshot.limitedUntil === undefined
      ? []
      : [`Limit reached (${snapshot.limitedUntil.window}): no turns until ${time(snapshot.limitedUntil.until, now)}.`])
  ].join("\n")

const clip = (text: string, max = 200) => {
  const line = text.trim().split("\n")[0]?.trim() ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** Up to three items under a count, then how many more. */
const listed = (noun: string, items: ReadonlyArray<string>) =>
  items.length === 0
    ? []
    : [
        `${plural(items.length, noun)}:`,
        ...items.slice(0, 3).map((item) => `  ${clip(item)}`),
        ...(items.length > 3 ? [`  … and ${items.length - 3} more`] : [])
      ]

/** What a published URL answered when loaded from the sandbox (`dream publish`); at most 10 lines. */
export const pageCheck = (load: PageLoad): string => {
  const how = load.via === "browser" ? "in Chromium" : "over HTTP (no browser, so page errors weren't checked)"
  if (load._tag === "Unreachable") return `Loading it from this sandbox ${how} failed: ${clip(load.message)}.`
  const type = load.contentType?.split(";")[0]?.trim()
  const body = load.firstLine === undefined ? undefined : `"${clip(load.firstLine, 160)}"`
  const title = load.title === undefined ? undefined : `title "${clip(load.title, 120)}"`
  const showBody = body !== undefined && (title === undefined || (load.status >= 400 && load.firstLine !== load.title))
  const what = [title, showBody ? body : undefined].filter((part) => part !== undefined).join(", ")
  const summary = `Loaded it from this sandbox ${how}: ${load.status}${type === undefined ? "" : ` ${type}`}${what === "" ? "" : `, ${what}`}${load.stillLoading ? "; still loading when the check stopped" : ""}`
  const lines = [
    summary.endsWith('"') ? summary : `${summary}.`,
    ...listed("page error", load.pageErrors),
    ...listed("failed request", load.failedRequests),
    ...listed("console error", load.consoleErrors)
  ]
  return lines.length <= 10 ? lines.join("\n") : [...lines.slice(0, 9), `… ${lines.length - 9} more lines`].join("\n")
}
