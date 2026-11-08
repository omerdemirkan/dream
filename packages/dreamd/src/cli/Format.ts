/**
 * What `dream` prints. The agent reads these, so they're short, lead with
 * what happened, and include the ids it may need for a follow-up command.
 * Times are UTC, with how far away they are.
 */
import type {
  CostLine,
  ProjectCosts,
  UsageLimitStanding,
  AccessMessage,
  AppLink,
  AppNotification,
  AppNotifications,
  AppSender,
  ProjectLink,
  ProjectLinks,
  BrowserSession,
  Integration,
  MachineInfo,
  MacStatus,
  MediaRef,
  MessageId,
  QuestionMessage,
  Relay,
  SandboxSize,
  StatusCard,
  TextMessage,
  UsageSnapshot,
  UsageWindow,
  Wake,
  WorkstreamId,
  Workstreams
} from "@dream/domain"
import {
  AgentLinksPerProject,
  SandboxSizes,
  AppNotificationLimits,
  accessHeading,
  describeLinkTile,
  linkHost,
  linkLabel,
  linkMenuHeader,
  cardRows,
  doneLine,
  moreLine,
  needLine,
  nowOnCard,
  RelayKeyPath,
  rowOnCard,
  RowsOnCard,
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

const previewed = (message: QuestionMessage): string => {
  const previews = message.previews ?? []
  if (previews.length === 0) return ""
  const files = previews.reduce((n, p) => n + p.media.length, 0)
  return ` with ${files} preview file(s) for ${previews.length} of ${message.options.length} options`
}

export const asked = (message: QuestionMessage): string =>
  `Asked ${message.id}${previewed(message)}${notified(message)}. Their answer arrives as an event; withdraw it with \`dream ask withdraw ${message.id}\`.`

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
    case "Notifications":
      return `notifications from ${message.request.name}`
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
      line.lines <= 1
        ? `Now: "${card.now}" (fits the card's one line)`
        : line.whole
          ? `Now: "${card.now}"\n  It takes two lines on the card above their Chat; still readable, but one line reads at a glance.`
          : `Now: "${card.now}"\n  Too long: the card above their Chat cuts it to two lines, "${line.shown}". It's whole only when they open the card.`
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

/** Said when `--work` was given but the message came back without a label: the API predates workstreams. */
export const unlabeled = (asked: WorkstreamId | undefined, message: { readonly workstream?: WorkstreamId }): string =>
  asked !== undefined && message.workstream === undefined
    ? " It went without a workstream label: this Dream's API predates workstreams."
    : ""

/** Where a `--reply-to` went: in the thread, or, against an API from before threads, to Chat on its own. */
export const threaded = (
  asked: MessageId | undefined,
  message: { readonly replyTo?: MessageId; readonly workstream?: WorkstreamId }
): string =>
  asked === undefined
    ? ""
    : message.replyTo === undefined
      ? " It went to Chat on its own, not in a thread: this Dream's API predates threads."
      : ` It's in the thread on ${message.replyTo}${message.workstream === undefined ? "" : `, in ${message.workstream}`}.`

export const revised = (message: QuestionMessage): string =>
  `Changed ${message.id} in place: the card shows "Changed", with ${message.options.length} option(s)${previewed(message)}. ` +
  "It didn't notify them again; if they asked for the change in its thread, say there that it's done."

/** The workstreams, and exactly what the card shows of them. */
export const workstreams = (report: Workstreams, now: DateTime.Utc): string => {
  const { workstreams: all, waiting } = report
  const active = all.filter((w) => w.state === "active")
  const lines: Array<string> = []
  const card = cardRows(all, waiting, now)
  if (card === undefined) {
    lines.push(
      active.length === 0
        ? "No active workstreams. The card shows your --now sentence, as usual."
        : `One active workstream (${active[0]?.id}). The card still shows your --now sentence; rows replace it once two are active.`
    )
  } else {
    lines.push(`On the card, in place of your --now sentence (which Home and older apps still show):`)
    for (const row of card.rows) {
      const shown = rowOnCard(row.workstream)
      const id = row.workstream.id
      lines.push(
        row.waitingOn === undefined
          ? `  ● ${shown.title}${shown.now === undefined ? " (no now-line)" : ` / ${shown.now}`}  [${id}]`
          : `  ● ${shown.title} / amber, at the top: waiting on them while ${row.waitingOn} is open  [${id}]`
      )
      if (!shown.whole)
        lines.push(
          "    Cut: a row is one line of title and one line of now, about 30 characters and 35; it's whole only when they open the card."
        )
    }
    if (card.more.length > 0)
      lines.push(
        `  ${moreLine(card.more)}  (past ${RowsOnCard} active, the last row sums up the rest; all of them show when they open the card)`
      )
    const done = doneLine(card.done)
    if (done !== undefined)
      lines.push(
        `  ✓ ${done.text}${done.others > 0 ? ` +${done.others}` : ""}  (finished in the last few days, folded)`
      )
  }
  const ended = all.filter((w) => w.state !== "active")
  if (active.length > 0 && card === undefined)
    for (const w of active) lines.push(`  active: ${w.title}${w.now === undefined ? "" : ` / ${w.now}`}  [${w.id}]`)
  if (ended.length > 0)
    lines.push(
      `Ended: ${ended
        .slice(-8)
        .map((w) => `${w.title} (${w.state}${w.endedAt === undefined ? "" : ` ${time(w.endedAt, now)}`}) [${w.id}]`)
        .join("; ")}`
    )
  return lines.join("\n")
}

const when = (wake: Wake, now: DateTime.Utc) =>
  wake.when._tag === "At"
    ? time(wake.when.at, now)
    : `cron "${wake.when.expression}"${wake.when.timeZone === undefined ? "" : ` ${wake.when.timeZone}`}${wake.nextAt === undefined ? "" : `, next ${time(wake.nextAt, now)}`}`

const lastRun = (wake: Wake, now: DateTime.Utc) => {
  const run = wake.lastRun
  if (run === undefined) return ""
  const summary = run.summary === undefined ? "" : `: ${run.summary.replace(/\s+/g, " ").slice(0, 160)}`
  return `\n  last run ${time(run.endedAt, now)} ${run.outcome}${summary}`
}

export const wake = (wake: Wake, now: DateTime.Utc): string =>
  `${wake.id}: ${when(wake, now)}: "${wake.why}"` +
  (wake.run === undefined ? "" : `, runs \`${wake.run}\``) +
  (wake.task === undefined
    ? ""
    : `, runs a task (${wake.task.model}, effort ${wake.task.effort}): ${wake.task.brief.replace(/\s+/g, " ").slice(0, 80)}` +
      (wake.task.brief.length > 80 ? "…" : "")) +
  lastRun(wake, now)

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
    : [
        `The Mac is ${status.state}${status.startedAt === undefined ? "" : ` (started ${time(status.startedAt, now)})`}; it stops after ${status.idleTimeoutMinutes} minutes with nothing running on it.`,
        ...(status.deadline === undefined
          ? []
          : [`Namespace destroys it at ${time(status.deadline, now)} at the latest, whatever runs on it.`]),
        "Run commands with `dream mac ssh -- <cmd>`."
      ].join(" ")

const machineName = (size: SandboxSize) =>
  `the ${size} machine (${SandboxSizes[size].cpus} CPUs, ${SandboxSizes[size].memoryGb} GB)`

export const machine = (info: MachineInfo): string => {
  const other: SandboxSize = info.size === "standard" ? "large" : "standard"
  const head = `This sandbox is ${machineName(info.size)}.`
  if (info.move !== undefined) {
    return `${head} A move to ${machineName(info.move.to)} is waiting ("${info.move.why}"): Dream does it when your turn ends. \`dream machine move ${info.size} "…"\` cancels it.`
  }
  return `${head} \`dream machine move ${other} "<why>"\` moves the project to ${machineName(other)} after this turn: about a minute, and a fresh boot (Dream restarts your servers).`
}

export const moving = (info: MachineInfo): string =>
  info.move === undefined
    ? `You're on ${machineName(info.size)}; nothing to move.`
    : `Dream moves the project to ${machineName(info.move.to)} when this turn ends. It takes about a minute: your home directory comes over, processes don't, so it restarts the servers that were listening and tells you in your next turn.`

const window = (name: string, value: UsageWindow | undefined, now: DateTime.Utc) =>
  value === undefined
    ? []
    : [
        `${name}: ${Math.round(value.usedPercent)}% used${value.resetsAt === undefined ? "" : `, resets ${time(value.resetsAt, now)}`}`
      ]

export const usage = (snapshot: UsageSnapshot, now: DateTime.Utc, standing?: UsageLimitStanding): string =>
  [
    `${snapshot.plan ?? (snapshot.provider === "claude" ? "Claude" : "ChatGPT")} subscription, as of ${time(snapshot.observedAt, now)}`,
    ...window("Five-hour window", snapshot.fiveHour, now),
    ...window("Weekly limit", snapshot.weekly, now),
    ...(snapshot.limitedUntil === undefined
      ? []
      : [`Limit reached (${snapshot.limitedUntil.window}): no turns until ${time(snapshot.limitedUntil.until, now)}.`]),
    ...(standing === undefined ? [] : usageLimits(standing, now))
  ].join("\n")

const percent = (value: number) => `${Math.round(value)}%`

/** This project's share of the week, the limits they set on it, and how close it is to each. */
export const usageLimits = (standing: UsageLimitStanding, now: DateTime.Utc): ReadonlyArray<string> => {
  const { limits, week, reached } = standing
  const { projectWeekPercent: cap, planLeftPercent: floor } = limits
  const lines = week === undefined ? [] : [`This project has used about ${percent(week.projectPercent)} of the week.`]
  if (cap === undefined && floor === undefined) return [...lines, "They've set no usage limits on this project."]
  const left = week === undefined ? undefined : 100 - week.usedPercent
  const toGo = (distance: number | undefined) =>
    distance === undefined ? "" : distance > 0 ? ` (about ${percent(distance)} to go)` : " (reached)"
  const parts = [
    ...(cap === undefined
      ? []
      : [
          `this project may use up to ${cap}% of the week${toGo(week === undefined ? undefined : cap - week.projectPercent)}`
        ]),
    ...(floor === undefined
      ? []
      : [`Dream stops it when the plan has ${floor}% left${toGo(left === undefined ? undefined : left - floor)}`])
  ]
  lines.push(`Limits they set: ${parts.join("; ")}.`)
  if (reached !== undefined) {
    const which =
      reached.limit === "project"
        ? `this project has used the ${reached.percent}% of the week they gave it`
        : `the plan is down to the ${reached.percent}% they keep free`
    const reset = week?.resetsAt === undefined ? "" : `, or the week resets ${time(week.resetsAt, now)}`
    lines.push(`Paused: ${which}. Nothing new starts until they raise or clear it${reset}.`)
  }
  return lines
}

/** Dollars as the person would say them: cents, or "under a cent". */
export const dollars = (usd: number) => (usd > 0 && usd < 0.005 ? "under a cent" : `$${usd.toFixed(2)}`)

const costNames: Record<CostLine["center"], string> = {
  sandbox: "this sandbox",
  browser: "browsers",
  mac: "Macs",
  models: "AI models",
  storage: "media storage",
  email: "email"
}

const amount = (line: CostLine) => {
  const n = line.unit === "hour" ? Math.round(line.quantity * 10) / 10 : Math.round(line.quantity)
  switch (line.unit) {
    case "hour":
      return ` (${n} ${n === 1 ? "hour" : "hours"})`
    case "minute":
      return ` (${plural(n, "minute")})`
    case "request":
      return ` (${plural(n, "call")})`
    case "message":
      return ` (${plural(n, "email")})`
    case "gbMonth":
      return ""
  }
}

/** What Dream paid to run the project this month, for `dream usage`. Kept apart from their subscription's lines. */
export const costs = (report: ProjectCosts): string => {
  const { month, lastMonth } = report
  const last = lastMonth.usd > 0 ? ` Last month: ${dollars(lastMonth.usd)}.` : ""
  const paid = month.lines.filter((line) => line.payer === "dream")
  const theirs = month.lines.filter((line) => line.payer === "person")
  const lines = [
    paid.length === 0
      ? `Dream has paid nothing to run this project this month.${last}`
      : `Dream has paid about ${dollars(month.usd)} to run this project this month, at list prices.${last}`
  ]
  if (paid.length > 0) {
    lines.push(`${paid.map((line) => `${costNames[line.center]} ${dollars(line.usd)}${amount(line)}`).join(", ")}.`)
  }
  for (const line of theirs) {
    lines.push(`Their own key paid ${dollars(line.usd)} more for ${costNames[line.center]}${amount(line)}.`)
  }
  return lines.join("\n")
}

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

const relaySource = (relay: Relay): string => {
  const source = relay.source
  if (source._tag === "WebSocket")
    return `WebSocket ${source.url}${source.match === undefined ? "" : ` (only messages with "${source.match}")`}`
  const only = [
    source.mentionsOnly ? "only mentions and DMs" : undefined,
    source.channels === undefined || source.channels.length === 0 ? undefined : `channels ${source.channels.join(", ")}`
  ].filter((part) => part !== undefined)
  return `Discord ${source.events.join(", ")}${only.length === 0 ? "" : ` (${only.join("; ")})`}`
}

const relayTarget = (relay: Relay): string =>
  `${relay.target.port === undefined ? "the published port" : `localhost:${relay.target.port}`} ${relay.target.path}`

const span = (from: DateTime.Utc, now: DateTime.Utc): string => relative(from, now).replace(/ ago$/, "")

/** One relay, as `dream relay list` shows it. */
export const relay = (item: Relay, now: DateTime.Utc): string => {
  const state =
    item.state === "connected"
      ? `connected${item.since === undefined ? "" : ` for ${span(item.since, now)}`}${item.account === undefined ? "" : ` as ${item.account}`}`
      : item.state === "failed"
        ? `failed${item.since === undefined ? "" : ` ${relative(item.since, now)}`}; \`dream relay restart ${item.id}\` once it's fixed`
        : `${item.state}${item.since === undefined ? "" : ` (${relative(item.since, now)})`}`
  const counts = `${item.delivered} delivered, ${item.waiting} waiting${item.dropped === 0 ? "" : `, ${item.dropped} dropped`}`
  return [
    `${item.id}${item.label === undefined ? "" : ` "${item.label}"`}: ${relaySource(item)} → ${relayTarget(item)}`,
    `  ${state}; ${counts}${item.lastEventAt === undefined ? "" : `; last event ${relative(item.lastEventAt, now)}`}`,
    ...item.problems.map((problem) => `  ${relative(problem.at, now)}: ${problem.message}`)
  ].join("\n")
}

export const relays = (list: ReadonlyArray<Relay>, now: DateTime.Utc): string =>
  list.length === 0
    ? "No relays. `dream relay discord` or `dream relay websocket` adds one."
    : list.map((item) => relay(item, now)).join("\n")

export const relayAdded = (item: Relay, now: DateTime.Utc): string =>
  [
    `Added ${relay(item, now)}`,
    `Each event is POSTed as JSON (id, relay, source, type, at, data) to ${relayTarget(item)}, signed with the key in ${RelayKeyPath}. Answer 2xx once it's handled; anything else is retried.`
  ].join("\n")

// ---------------------------------------------------------------------------
// Notifications from the project's apps
// ---------------------------------------------------------------------------

const tapsTo = (url: string | undefined) =>
  url === undefined ? "a tap opens it in the project's Notifications sheet" : `a tap opens ${url}`

export const appSetUp = (app: AppSender, card: AccessMessage): string => {
  const reads = `Its card reads "Let ${app.name} notify you", then "${card.why}" and "${app.often}".`
  switch (app.state._tag) {
    case "Waiting":
      return (
        `${app.name} (${app.id}) is waiting for them to allow it: card ${card.id}` +
        `${card.notificationId === undefined ? "" : `, notification ${card.notificationId}`}. ` +
        `Nothing it sends reaches them until they do, and their answer arrives as an event.\n${reads}`
      )
    case "Allowed":
      return `They already allow ${app.name} (${app.id}); its name, tile and page are updated, and ${tapsTo(app.url)}.`
    case "Declined":
      return `They declined ${app.name} (${app.id}).`
  }
}

const limitWords = (held: AppNotification["held"]) =>
  held === "hour"
    ? `its limit of ${AppNotificationLimits.perAppHour} an hour`
    : held === "day"
      ? `its limit of ${AppNotificationLimits.perAppDay} a day`
      : `this project's limit of ${AppNotificationLimits.perProjectDay} a day across its apps`

/** What happened to one, in a sentence: leads with whether it reached them. */
const outcomeWords = (n: AppNotification): string => {
  switch (n.outcome) {
    case "sent":
      return `sent to their phone as ${n.app}; ${tapsTo(n.url)}`
    case "quiet":
      return `delivered quietly (Notification Center, no sound); ${tapsTo(n.url)}`
    case "held":
      return `held: ${n.app} is over ${limitWords(n.held)}, so it's in the app's history without reaching their phone`
    case "muted":
      return `not delivered: they've turned ${n.app} off or muted it; it's in the app's history`
    case "duplicate":
      return `not sent: the same title and text went out within the last ${AppNotificationLimits.repeatHours} hours`
    case "waiting":
      return `not sent: they haven't allowed ${n.app} yet; its card is waiting in Chat`
    case "declined":
      return `not sent: they declined notifications from ${n.app}`
  }
}

export const appNotified = (n: AppNotification, dryRun: boolean): string => {
  const words = outcomeWords(n)
  const head = n.title ?? n.text.split("\n")[0]!
  if (dryRun) return `Dry run, nothing sent or kept. It would be ${words}.`
  const reached = n.outcome === "sent" || n.outcome === "quiet"
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.${reached ? ` "${head}" (${n.id}).` : ""}`
}

const senderLine = (app: AppSender, now: DateTime.Utc): string => {
  const state =
    app.state._tag === "Waiting"
      ? "waiting for them to allow it"
      : app.state._tag === "Declined"
        ? `declined${app.state.reason === undefined ? "" : ` ("${app.state.reason}")`}`
        : app.delivery === "immediate"
          ? "allowed"
          : app.delivery === "quiet"
            ? "allowed, quietly (no sound)"
            : "turned off by them"
  const muted =
    app.mutedUntil !== undefined && DateTime.toEpochMillis(app.mutedUntil) > DateTime.toEpochMillis(now)
      ? `, muted until ${time(app.mutedUntil, now)}`
      : ""
  return `${app.id} "${app.name}": ${state}${muted}. ${tapsTo(app.url).replace(/^a/, "A")}.`
}

export const appNotifications = (list: AppNotifications, now: DateTime.Utc): string => {
  if (list.apps.length === 0) return "No app is set up to notify them. `dream notify setup <app>` readies one."
  return list.apps
    .map((app) => {
      const sent = list.notifications.filter((n) => n.app === app.id)
      const lines = sent.slice(0, 20).map((n) => {
        const notes = [
          n.outcome === "held" ? `held (${n.held})` : n.outcome,
          ...(n.replacedAt === undefined ? [] : ["replaced"]),
          ...(n.openedAt === undefined ? [] : ["opened"]),
          ...(n.withdrawnAt === undefined ? [] : ["withdrawn"])
        ].join(", ")
        return `  ${time(n.sentAt, now)} ${n.id} [${notes}] "${n.title ?? n.text.split("\n")[0]}"`
      })
      const reached = sent.filter((n) => n.outcome === "sent" || n.outcome === "quiet")
      const opened = reached.filter((n) => n.openedAt !== undefined).length
      const summary =
        sent.length === 0
          ? "  Nothing sent in the last 30 days."
          : `  ${reached.length} reached their phone in the last 30 days; they opened ${opened}.`
      return [
        senderLine(app, now),
        summary,
        ...lines,
        ...(sent.length > 20 ? [`  … ${sent.length - 20} more`] : [])
      ].join("\n")
    })
    .join("\n")
}
