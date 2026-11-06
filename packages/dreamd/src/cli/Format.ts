/**
 * What `dream` prints. The agent reads these, so they're short, lead with
 * what happened, and include the ids it may need for a follow-up command.
 * Times are UTC, with how far away they are.
 */
import type {
  AccessMessage,
  AppLink,
  ProjectLink,
  ProjectLinks,
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
import {
  AgentLinksPerProject,
  accessHeading,
  describeLinkTile,
  linkHost,
  linkLabel,
  linkMenuHeader,
  needLine,
  nowOnCard,
  sandboxKeyPath
} from "@dream/domain"
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

/** The card, and what of it they see: what fits on its one line, the track, the amber needs, the opened view. */
export const status = (card: StatusCard, now: DateTime.Utc): string => {
  const lines = [`Phase: ${card.phase} since ${time(card.phaseSince, now)}`]
  if (card.pausedUntil !== undefined) lines.push(`Paused for usage until ${time(card.pausedUntil, now)}`)
  if (card.now === undefined) lines.push("Now: (none; the card shows the last thing you said in Chat instead)")
  else {
    const line = nowOnCard(card.now)
    lines.push(
      line.whole
        ? `Now: "${card.now}" (fits the card's one line)`
        : `Now: "${card.now}"\n  The card above their Chat cuts it to "${line.shown}"; it's whole only when they open the card.`
    )
  }
  const current = card.milestones.findIndex((m) => m.state === "current")
  if (current !== -1 && card.milestones.length > 1)
    lines.push(`Track: ${current + 1} of ${card.milestones.length} (${card.milestones[current]?.title})`)
  if (card.milestones.length > 0) {
    lines.push("Milestones, shown as title and date:")
    for (const milestone of card.milestones) {
      const mark = milestone.state === "done" ? "[x]" : milestone.state === "current" ? "[>]" : "[ ]"
      const date =
        milestone.state === "current"
          ? " · Now"
          : milestone.date === undefined
            ? ""
            : ` · ${DateTime.formatIso(milestone.date).slice(0, 10)}`
      lines.push(`  ${mark} ${milestone.title}${date}`)
      for (const need of milestone.needs) {
        lines.push(
          need.messageId === undefined
            ? `      need "${need.what}"${need.when === undefined ? "" : ` (${need.when})`}: not shown until you link it to a question or access request (messageId)`
            : `      need: amber "${needLine(need.what)}" while ${need.messageId} is open`
        )
      }
    }
  }
  if (card.media.length > 0)
    lines.push(
      `Media when they open the card: ${card.media.map((ref) => (ref.caption ? `"${ref.caption}"` : ref.id)).join(", ")}`
    )
  const unseen = [
    card.justDid === undefined ? undefined : "just did",
    card.next === undefined ? undefined : "next",
    card.milestones.some((m) => m.detail !== undefined) ? "milestone details" : undefined
  ].filter((x) => x !== undefined)
  if (unseen.length > 0) lines.push(`Not shown in the app: ${unseen.join(", ")}.`)
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

// ---------------------------------------------------------------------------
// App links
// ---------------------------------------------------------------------------

/** What they'll see of a link, so the agent can check it against what it meant. */
export const linkSeen = ({ link, projectTitle, publicUrl }: ProjectLink): string => {
  const label = linkLabel(link.title)
  const header = linkMenuHeader(link, projectTitle)
  const dot = link.openedAt === undefined ? ", with a dot before the label until they first open it" : ""
  const ours = publicUrl !== "" && linkHost(link.url) === linkHost(publicUrl)
  return [
    `On their Home it shows as "${label.shown}" under ${describeLinkTile(link)}${dot}.`,
    ...(label.whole
      ? []
      : [`"${link.title}" doesn't fit under the tile; about ten characters do, so a shorter title reads whole.`]),
    `Held, it reads "${header.title} · ${header.host}".`,
    ours
      ? `Added to their iPhone's Home Screen, it's an app called "${link.title}" with this tile as its icon.`
      : `It's not on ${linkHost(publicUrl) || "this project's site"}, so on their iPhone's Home Screen it would get that site's own name and icon.`
  ].join("\n")
}

export const linkAdded = (result: ProjectLink): string =>
  `Added ${result.link.id} to their Home, at the end of the row of app icons.\n${linkSeen(result)}`

export const linkUpdated = (result: ProjectLink): string => `Updated ${result.link.id}.\n${linkSeen(result)}`

const linkLine = (link: AppLink) => `${link.id} "${link.title}" → ${link.url}`

const theirChanges = (link: AppLink) =>
  link.theirs === undefined || link.theirs.length === 0
    ? ""
    : ` They changed its ${link.theirs.join(" and ")}, which ${link.theirs.length > 1 ? "stay" : "stays"} theirs.`

export const links = ({ links: all }: ProjectLinks, now: DateTime.Utc): string => {
  const mine = all.filter((link) => link.addedBy === "agent" && link.removedAt === undefined)
  const theirs = all.filter((link) => link.addedBy === "person")
  const removed = all.filter((link) => link.removedAt !== undefined)
  const lines = [
    mine.length === 0
      ? "This project has no links on their Home."
      : `This project's links on their Home (${mine.length} of ${AgentLinksPerProject}):`,
    ...mine.map(
      (link) =>
        `${linkLine(link)}, ${describeLinkTile(link)}, ${link.openedAt === undefined ? "not opened yet" : "opened"}.${theirChanges(link)}`
    ),
    ...theirs.map((link) => `They added ${linkLine(link)} themselves; it's theirs.`),
    ...removed.map((link) => `They removed ${linkLine(link)} ${time(link.removedAt!, now)}; it stays off.`)
  ]
  return lines.join("\n")
}
