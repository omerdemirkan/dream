/**
 * Whether the agent is up, as the phone shows it (Deck v3, "A+B+C"): the presence dot and state line on Home and in
 * a project's header, the row at the bottom of Chat, and the receipt under their latest message. All of it is
 * derived here from what the API sends (`AgentActivity`, the pause, open asks, messages) and the clock, so every
 * state is covered by tests in Node.
 */
import type { AgentActivity, Harness, Message, TextMessage, TurnProgress } from "@dream/domain"
import { DateTime, Duration } from "effect"
import { sameDay, timeLabel } from "./format.ts"

export type Presence =
  /** A turn is running (`since` is absent from APIs that only send the working flag), and what it's doing. */
  | {
      readonly _tag: "Working"
      readonly since?: DateTime.Utc | undefined
      readonly progress?: TurnProgress | undefined
    }
  /** Dream is bringing its computer up to deliver something. */
  | { readonly _tag: "Starting"; readonly since: DateTime.Utc }
  /** Waiting for a usage window to reset. */
  | { readonly _tag: "Paused"; readonly until: DateTime.Utc }
  /** Between turns with its computer still up; `since` is when the last turn ended. */
  | { readonly _tag: "Awake"; readonly since?: DateTime.Utc | undefined }
  /** Its computer is asleep until something wakes it: them, or `nextWakeAt`. */
  | {
      readonly _tag: "Asleep"
      readonly since?: DateTime.Utc | undefined
      readonly nextWakeAt?: DateTime.Utc | undefined
    }
  /** Idle, from an API that doesn't say whether the computer is up. */
  | { readonly _tag: "Unknown" }

export interface PresenceInput {
  readonly activity: AgentActivity | undefined
  readonly working: boolean
  readonly pausedUntil: DateTime.Utc | undefined
  readonly now: DateTime.Utc
}

/** "Starting" for longer than this means the report that a turn started never came; it reads as idle. */
export const StaleStarting = Duration.minutes(3)

/** How long after they send a message the phone says it's on its way when nothing more is known. */
export const SentWindow = Duration.minutes(2)

const isAfter = (a: DateTime.Utc | undefined, b: DateTime.Utc) => a !== undefined && DateTime.isGreaterThan(a, b)

export const presenceOf = (input: PresenceInput): Presence => {
  const { activity, now } = input
  if (activity?.state === "working" || (activity === undefined && input.working)) {
    return {
      _tag: "Working",
      since: activity?.since,
      ...(activity?.progress === undefined ? {} : { progress: activity.progress })
    }
  }
  if (
    activity?.state === "starting" &&
    activity.since !== undefined &&
    Duration.isLessThan(DateTime.distance(activity.since, now), StaleStarting)
  ) {
    return { _tag: "Starting", since: activity.since }
  }
  if (input.pausedUntil !== undefined && isAfter(input.pausedUntil, now)) {
    return { _tag: "Paused", until: input.pausedUntil }
  }
  if (activity === undefined) return { _tag: "Unknown" }
  const since = activity.state === "idle" ? activity.since : undefined
  if (activity.state === "idle" && isAfter(activity.awakeUntil, now)) return { _tag: "Awake", since }
  return { _tag: "Asleep", since, nextWakeAt: isAfter(activity.nextWakeAt, now) ? activity.nextWakeAt : undefined }
}

/** The dot on the project's tile: white pulse working, green awake, grey asleep, a hollow ring paused. */
export type PresenceDot = "working" | "starting" | "awake" | "asleep" | "paused" | "none"

export const dotOf = (presence: Presence): PresenceDot => {
  switch (presence._tag) {
    case "Working":
      return "working"
    case "Starting":
      return "starting"
    case "Paused":
      return "paused"
    case "Awake":
      return "awake"
    case "Asleep":
      return "asleep"
    case "Unknown":
      return "none"
  }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "40s", "2m", "1h 5m": how long the turn has run. */
export const elapsedLabel = (since: DateTime.Utc, now: DateTime.Utc) => {
  const seconds = Math.max(0, Math.floor((DateTime.toEpochMillis(now) - DateTime.toEpochMillis(since)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
}

const weekday = (dt: DateTime.Utc, timeZone?: string) =>
  new Intl.DateTimeFormat("en-US", timeZone ? { weekday: "short", timeZone } : { weekday: "short" }).format(
    DateTime.toDateUtc(dt)
  )

/** "4 PM", "6:55 AM": whole hours drop their minutes, as the mock writes them. */
const clock = (dt: DateTime.Utc, timeZone?: string) => timeLabel(dt, timeZone).replace(/:00(?=\s)/u, "")

/** A time ahead: just the clock within a day ("wakes 6:55 AM" tomorrow morning), else "Tue 6:55 AM". */
export const aheadLabel = (dt: DateTime.Utc, now: DateTime.Utc, timeZone?: string) =>
  Duration.isLessThan(DateTime.distance(now, dt), Duration.hours(23))
    ? clock(dt, timeZone)
    : `${weekday(dt, timeZone)} ${clock(dt, timeZone)}`

/** A time behind: "2:09 PM" today, else "Tue 2:09 PM". */
export const pastLabel = (dt: DateTime.Utc, now: DateTime.Utc, timeZone?: string) =>
  sameDay(dt, now, timeZone) ? timeLabel(dt, timeZone) : `${weekday(dt, timeZone)} ${timeLabel(dt, timeZone)}`

const planName = (harness: Harness) => (harness === "codex" ? "ChatGPT" : "Claude")

/**
 * One state line: `lead`, then `· rest`. `strong` leads are bold and white (the agent is doing something), `need`
 * leads are amber (it's waiting for them); the rest are quiet.
 */
export interface StateLine {
  readonly lead: string
  readonly rest?: string | undefined
  readonly strong: boolean
  readonly need?: boolean
}

export interface LineContext {
  readonly now: DateTime.Utc
  readonly harness: Harness
  /** Open questions and access requests. */
  readonly openAsks: number
  readonly timeZone?: string | undefined
}

const working = (presence: { readonly since?: DateTime.Utc | undefined }, now: DateTime.Utc): StateLine => ({
  lead: "Working",
  rest: presence.since ? elapsedLabel(presence.since, now) : undefined,
  strong: true
})

const paused = (until: DateTime.Utc, context: LineContext): StateLine => ({
  lead: "Paused",
  rest: `${planName(context.harness)} usage resets ${aheadLabel(until, context.now, context.timeZone)}`,
  strong: false
})

/**
 * The second line of a project's row on Home. `undefined` when there's nothing to say about the agent (asleep with
 * nothing scheduled, or an API that doesn't say), and the row keeps its headline.
 */
export const homeLine = (
  presence: Presence,
  context: LineContext & { readonly headline: string | undefined }
): StateLine | undefined => {
  const { now, timeZone } = context
  switch (presence._tag) {
    case "Working":
      return working(presence, now)
    case "Starting":
      return { lead: "Starting its computer…", strong: true }
    case "Paused":
      return paused(presence.until, context)
  }
  if (context.openAsks > 0) return { lead: "Waiting for you", rest: context.headline, strong: false, need: true }
  if (presence._tag === "Awake") {
    return {
      lead: "Done for now",
      rest: presence.since ? pastLabel(presence.since, now, timeZone) : undefined,
      strong: false
    }
  }
  if (presence._tag === "Asleep" && presence.nextWakeAt) {
    return { lead: "Asleep", rest: `wakes ${aheadLabel(presence.nextWakeAt, now, timeZone)}`, strong: false }
  }
  return undefined
}

/** The line under the project's title in its header. */
export const headerLine = (
  presence: Presence,
  context: LineContext & { readonly messages: ReadonlyArray<Message> }
): StateLine | undefined => {
  const { now, timeZone, messages } = context
  switch (presence._tag) {
    case "Working":
      return working(presence, now)
    case "Starting":
      return { lead: "Starting up", strong: true }
    case "Paused":
      return paused(presence.until, context)
  }
  if (presence._tag !== "Unknown" && sentPending(messages, now)) {
    return presence._tag === "Awake"
      ? { lead: "Awake", rest: "picking it up", strong: false }
      : { lead: "Asleep", rest: "waking up", strong: false }
  }
  if (context.openAsks > 0) return { lead: "Waiting for you", strong: false, need: true }
  switch (presence._tag) {
    case "Awake": {
      const last = messages.at(-1)
      const replied = last !== undefined && last._tag === "Text" && last.from === "agent" ? last.createdAt : undefined
      return {
        lead: "Done for now",
        rest: replied
          ? `replied ${pastLabel(replied, now, timeZone)}`
          : presence.since
            ? pastLabel(presence.since, now, timeZone)
            : undefined,
        strong: false
      }
    }
    case "Asleep":
      return {
        lead: "Asleep",
        rest: presence.nextWakeAt ? `wakes ${aheadLabel(presence.nextWakeAt, now, timeZone)}` : undefined,
        strong: false
      }
    case "Unknown":
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** Their most recent message in Chat. */
export const latestFromThem = (messages: ReadonlyArray<Message>): TextMessage | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?._tag === "Text" && message.from === "user") return message
  }
  return undefined
}

/** They just sent something the agent hasn't taken yet: the phone says it's on its way. */
export const sentPending = (messages: ReadonlyArray<Message>, now: DateTime.Utc): boolean => {
  const latest = latestFromThem(messages)
  return (
    latest !== undefined &&
    latest.seenAt === undefined &&
    Duration.isLessThan(DateTime.distance(latest.createdAt, now), SentWindow)
  )
}

/** Silence this long, with no long step running, is worth saying out loud. */
export const QuietAfter = Duration.minutes(10)
/** A long step shows how long it's run once it has run this long. */
export const LongStepAfter = Duration.minutes(3)

/**
 * What a working turn is doing, under "Working" in Chat and on Home: dreamd's progress line, with how long one long
 * step has run once that's worth saying ("Running the scorer tests · 11m"), or, after ten minutes of nothing at all,
 * that it's been quiet. Nothing when dreamd hasn't said (older builds, nobody watching yet), or when the line only
 * repeats the Status card's headline.
 */
export const progressNote = (
  progress: TurnProgress | undefined,
  now: DateTime.Utc,
  headline?: string | undefined
): { readonly text: string; readonly quiet: boolean } | undefined => {
  if (progress === undefined) return undefined
  const silent = DateTime.distance(progress.activeAt, now)
  if (progress.waitingSince === undefined && !Duration.isLessThan(silent, QuietAfter)) {
    return { text: `Nothing new for ${Math.floor(Duration.toMinutes(silent))} minutes`, quiet: true }
  }
  const long =
    progress.waitingSince !== undefined &&
    !Duration.isLessThan(DateTime.distance(progress.waitingSince, now), LongStepAfter)
      ? elapsedLabel(progress.waitingSince, now)
      : undefined
  const line =
    progress.line !== undefined && progress.line.toLowerCase() !== headline?.trim().toLowerCase()
      ? progress.line
      : undefined
  if (line !== undefined) return { text: long === undefined ? line : `${line} · ${long}`, quiet: false }
  return long === undefined ? undefined : { text: `One long step · ${long}`, quiet: false }
}

/** The row at the bottom of Chat. */
export type ChatRow =
  /** Typing dots: sent, nothing more known yet. */
  | { readonly _tag: "Sent" }
  /** `fresh`: a new idea, whose agent hasn't said anything yet. */
  | { readonly _tag: "Starting"; readonly fresh: boolean }
  | {
      readonly _tag: "Working"
      readonly since?: DateTime.Utc | undefined
      readonly note?: { readonly text: string; readonly quiet: boolean } | undefined
    }
  /** Under the reply: the turn is over, so silence after it means it really stopped. */
  | { readonly _tag: "Done" }

export const chatRowOf = (
  presence: Presence,
  messages: ReadonlyArray<Message>,
  now: DateTime.Utc,
  headline?: string | undefined
): ChatRow | undefined => {
  switch (presence._tag) {
    case "Working": {
      const note = progressNote(presence.progress, now, headline)
      return { _tag: "Working", since: presence.since, ...(note === undefined ? {} : { note }) }
    }
    case "Starting":
      return { _tag: "Starting", fresh: !messages.some((m) => m._tag !== "Text" || m.from === "agent") }
    case "Paused":
      return undefined
  }
  if (sentPending(messages, now)) return { _tag: "Sent" }
  if (presence._tag === "Unknown" || presence.since === undefined) return undefined
  const latest = latestFromThem(messages)
  const turnEnded = presence.since
  return latest === undefined || !DateTime.isLessThan(turnEnded, latest.createdAt) ? { _tag: "Done" } : undefined
}

/**
 * The receipt under their latest message: "Sent", then "Seen" once Dream began delivering it to the agent's machine. A message from before
 * Dream marked messages seen counts as seen once the agent answered or finished a turn after it. Only from APIs that
 * send the activity, since older ones never mark a message seen.
 */
export const receiptOf = (
  messages: ReadonlyArray<Message>,
  activity: AgentActivity | undefined
): { readonly messageId: Message["id"]; readonly seen: boolean } | undefined => {
  if (activity === undefined) return undefined
  const latest = latestFromThem(messages)
  if (latest === undefined) return undefined
  const answered = messages.some(
    (m) => (m._tag !== "Text" || m.from === "agent") && DateTime.isGreaterThan(m.createdAt, latest.createdAt)
  )
  const turnEndedAfter = activity.state === "idle" && isAfter(activity.since, latest.createdAt)
  return { messageId: latest.id, seen: latest.seenAt !== undefined || answered || turnEndedAfter }
}
