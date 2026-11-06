/**
 * What the Status card pinned above Chat says, from a project's state: the ask
 * waiting for them, else the "now" line, the milestone track and the next need,
 * else (before the agent writes any Status) the last thing it said or the early note.
 */
import type { AskMessage, Message, Milestone, MilestoneState, Need, StatusCard, TextMessage } from "@dream/domain"
import { accessHeading } from "@dream/domain"
import { DateTime } from "effect"
import { timeLabel } from "../data/format.ts"
import type { ProjectState } from "../data/projectState.ts"
import { unsupportedText } from "../data/Tolerant.ts"
import { needsThem } from "./asks.ts"
import { accessLabel } from "./describe.ts"
import { plainText } from "./markdownParse.ts"

/** "Progress charts · 3 of 5" and the segmented bar under the now line. */
export interface Track {
  readonly title: string
  readonly position: number
  readonly states: ReadonlyArray<MilestoneState>
}

/** The next thing the agent will need from them, e.g. "Your Apple Developer account", "around Thursday". */
export interface NextNeed {
  readonly what: string
  readonly when?: string | undefined
}

export type CardView =
  /** Something waits for them: the first open ask leads, the rest are named under it. */
  | {
      readonly _tag: "Needs"
      readonly ask: AskMessage
      readonly count: number
      readonly also: ReadonlyArray<string>
      readonly track: Track | undefined
    }
  | {
      readonly _tag: "Status"
      readonly label: string
      readonly text: string
      readonly paused: boolean
      readonly track: Track | undefined
      readonly need: NextNeed | undefined
    }
  /** Before the agent writes any Status or says anything. */
  | { readonly _tag: "Early"; readonly text: string }

/** Before the agent writes a Status card: still looking into it, unless they've already answered something. */
export const earlyNote = (messages: ReadonlyArray<Message>) =>
  !messages.some(
    (m) => (m._tag === "Question" || m._tag === "Access") && m.state._tag !== "Open" && m.state._tag !== "Withdrawn"
  )
    ? "I’m looking into this before I ask you anything. That can take a few minutes, so there’s no need to wait around — I’ll send a notification when I have a question."
    : "Thanks. I’m shaping the first version around your answer, and I’ll write when there’s something to look at."

/** The milestone that carries now / just did / media / next: the current one, else the latest done. */
export const focusIndex = (milestones: ReadonlyArray<Milestone>) => {
  const current = milestones.findIndex((m) => m.state === "current")
  if (current !== -1) return current
  let best = -1
  milestones.forEach((m, i) => {
    if (m.state !== "done") return
    const prev = milestones[best]
    if (best === -1 || (m.date && prev?.date && DateTime.isGreaterThan(m.date, prev.date)) || (m.date && !prev?.date))
      best = i
  })
  return best
}

/** The track, when the milestones read as one: a current one, or every one done. A log of runs has none. */
export const trackOf = (milestones: ReadonlyArray<Milestone>): Track | undefined => {
  if (milestones.length < 2) return undefined
  const states = milestones.map((m) => m.state)
  const current = states.indexOf("current")
  if (current !== -1) return { title: milestones[current]?.title ?? "", position: current + 1, states }
  if (states.every((s) => s === "done")) return { title: "All done", position: milestones.length, states }
  return undefined
}

const resolved = (need: Need, messages: ReadonlyArray<Message>) => {
  const linked = need.messageId ? messages.find((m) => m.id === need.messageId) : undefined
  if (!linked || linked._tag === "Text") return false
  return linked.state._tag !== "Open"
}

/** The first need from the current milestone on that's still ahead of them. */
export const nextNeedOf = (status: StatusCard, messages: ReadonlyArray<Message>): NextNeed | undefined => {
  const from = Math.max(
    0,
    status.milestones.findIndex((m) => m.state === "current")
  )
  for (const milestone of status.milestones.slice(from)) {
    if (milestone.state === "done") continue
    for (const need of milestone.needs) {
      if (resolved(need, messages)) continue
      const linked = need.messageId ? messages.find((m) => m.id === need.messageId) : undefined
      return { what: need.what, when: need.when ?? (linked?._tag === "Access" ? linked.when : undefined) }
    }
  }
  return undefined
}

/** "around Thursday" → "needed around Thursday". */
export const neededLabel = (when: string) => (/^needed\b/i.test(when.trim()) ? when.trim() : `needed ${when.trim()}`)

/** An ask in a few words: its question or heading. */
export const askTitle = (ask: AskMessage) =>
  ask._tag === "Question" ? plainText(ask.question) : accessHeading(ask).title

/** An ask as the card names it under the one that leads: the need it's pinned to, else the service or question. */
const askName = (ask: AskMessage, status: StatusCard) => {
  const pinned = status.milestones.flatMap((m) => m.needs).find((n) => n.messageId === ask.id)
  if (pinned) return pinned.what
  return ask._tag === "Access" ? accessLabel(ask.request) : plainText(ask.question)
}

export const cardOf = (state: ProjectState, now: DateTime.Utc): CardView => {
  const { status, messages } = state
  const track = trackOf(status.milestones)
  const asks = messages.filter(needsThem)
  const [lead, ...rest] = asks
  if (lead) {
    return { _tag: "Needs", ask: lead, count: asks.length, also: rest.map((a) => askName(a, status)), track }
  }
  const paused = status.pausedUntil !== undefined && DateTime.isGreaterThan(status.pausedUntil, now)
  const need = nextNeedOf(status, messages)
  const view = (label: string, text: string): CardView => ({
    _tag: "Status",
    label: paused && status.pausedUntil ? `Paused until ${timeLabel(status.pausedUntil)}` : label,
    text,
    paused,
    track,
    need
  })
  if (status.now) return view("Now", status.now)
  if (status.justDid) return view("Just did", status.justDid)
  const focus = status.milestones[focusIndex(status.milestones)]
  if (focus?.state === "done") return view("Latest", focus.detail ? `${focus.title}. ${focus.detail}` : focus.title)
  // Agents don't always write a Status card; then the last thing they said in Chat stands in for it.
  const latest = messages.findLast(
    (m): m is TextMessage => m._tag === "Text" && m.from === "agent" && m.text !== unsupportedText
  )
  if (latest) return view("Latest in Chat", plainText(latest.text))
  if (paused) return view("", "Your usage resets then, and I’ll pick up automatically.")
  return { _tag: "Early", text: earlyNote(messages) }
}
