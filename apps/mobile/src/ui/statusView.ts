/**
 * What the Status card pinned above Chat says, from a project's state: the "now" sentence, the milestone track,
 * and an amber line while something waits for them. Before the agent writes any Status, the last thing it said
 * (or the early note) stands in for the sentence.
 */
import type {
  AskMessage,
  Message,
  Milestone,
  MilestoneState,
  StatusCard,
  TextMessage,
  Workstream,
  WorkstreamId
} from "@dream/domain"
import { cardRows, doneLine, moreLine, needLine, workstreamWaits } from "@dream/domain"
import { DateTime } from "effect"
import type { ProjectState } from "../data/projectState.ts"
import { unsupportedText } from "../data/Tolerant.ts"
import { needsThem } from "./asks.ts"
import { accessLabel } from "./describe.ts"
import { plainText } from "./markdownParse.ts"

/** "2 of 3" and the segmented bar. */
export interface Track {
  readonly position: number
  readonly states: ReadonlyArray<MilestoneState>
}

/** The amber line: the first open ask, and how many more wait behind it. */
export interface NeedView {
  readonly text: string
  readonly ask: AskMessage
  readonly more: number
}

/** A workstream's row: its title, and where it stands, or what it waits on them for. */
export interface RowView {
  readonly id: WorkstreamId
  readonly title: string
  /** The workstream's line, or while it waits on them, what it asks (in amber). */
  readonly line: string | undefined
  readonly waiting: AskMessage | undefined
}

/** The card while two or more workstreams are active (`cardRows`): rows in place of the sentence and the track. */
export interface RowsView {
  readonly rows: ReadonlyArray<RowView>
  /** The last row past the cap: "2 more: Android?, Onboarding". */
  readonly more: { readonly text: string; readonly waiting: boolean } | undefined
  /** The folded line for what finished lately. */
  readonly done: { readonly text: string; readonly others: number } | undefined
  /** Every active workstream, in the rows' order, for the opened card. */
  readonly all: ReadonlyArray<RowView>
}

export interface CardView {
  /** The sentence: `now`, else what stands in for it. */
  readonly text: string
  /** `now` gets one line on the card; what stands in for it, more. */
  readonly stand: "now" | "latest" | "early"
  readonly paused: boolean
  readonly track: Track | undefined
  readonly need: NeedView | undefined
  /** Present while two or more workstreams are active; the card then shows these instead of the sentence. */
  readonly rows: RowsView | undefined
  /**
   * With rows, the amber line under them: an open ask no waiting row stands for (one the agent sent outside any
   * workstream).
   */
  readonly looseNeed: NeedView | undefined
}

/**
 * What each workstream labels its messages with, while the card shows rows; with one active or none, nothing is
 * labeled, as before workstreams.
 */
export const labelsOf = (status: StatusCard): ReadonlyMap<WorkstreamId, string> | undefined => {
  const all = status.workstreams ?? []
  if (all.filter((w) => w.state === "active").length < 2) return undefined
  return new Map(all.map((w) => [w.id, w.title]))
}

const rowsOf = (status: StatusCard, messages: ReadonlyArray<Message>, now: DateTime.Utc): RowsView | undefined => {
  const card = cardRows(status.workstreams, workstreamWaits(messages), now)
  if (card === undefined) return undefined
  const ask = (id: Message["id"] | undefined) =>
    id === undefined ? undefined : messages.find((m): m is AskMessage => m.id === id && needsThem(m))
  const row = (workstream: Workstream, waitingOn: Message["id"] | undefined): RowView => {
    const waiting = ask(waitingOn)
    return {
      id: workstream.id,
      title: workstream.title,
      line: waiting ? askLine(waiting, status) : workstream.now,
      waiting
    }
  }
  const rows = card.rows.map((r) => row(r.workstream, r.waitingOn))
  const more = card.more.map((r) => row(r.workstream, r.waitingOn))
  return {
    rows,
    more: card.more.length === 0 ? undefined : { text: moreLine(card.more), waiting: more.some((r) => r.waiting) },
    done: doneLine(card.done),
    all: [...rows, ...more]
  }
}

/** Before the agent writes a Status card: still looking into it, unless they've already answered something. */
export const earlyNote = (messages: ReadonlyArray<Message>) =>
  !messages.some(
    (m) => (m._tag === "Question" || m._tag === "Access") && m.state._tag !== "Open" && m.state._tag !== "Withdrawn"
  )
    ? "I’m looking into this before I ask you anything. That can take a few minutes, so there’s no need to wait around — I’ll send a notification when I have a question."
    : "Thanks. I’m shaping the first version around your answer, and I’ll write when there’s something to look at."

/** The track, when the milestones read as one: a current one, or every one done. A log of runs has none. */
export const trackOf = (milestones: ReadonlyArray<Milestone>): Track | undefined => {
  if (milestones.length < 2) return undefined
  const states = milestones.map((m) => m.state)
  const current = states.indexOf("current")
  if (current !== -1) return { position: current + 1, states }
  if (states.every((s) => s === "done")) return { position: milestones.length, states }
  return undefined
}

/** An ask as one amber line: the need it's pinned to, else what it asks for. */
export const askLine = (ask: AskMessage, status: StatusCard): string => {
  const pinned = status.milestones.flatMap((m) => m.needs).find((n) => n.messageId === ask.id)
  if (pinned) return needLine(pinned.what)
  if (ask._tag === "Question") return plainText(ask.question)
  const service = accessLabel(ask.request)
  return ask.request._tag === "Apple"
    ? "Needs your App Store Connect key"
    : ask.request._tag === "Key" || ask.request._tag === "File"
      ? `Needs your ${service} key`
      : `Needs ${service}`
}

export const cardOf = (state: ProjectState, now: DateTime.Utc): CardView => {
  const { status, messages } = state
  const asks = messages.filter(needsThem)
  const first = asks[0]
  const need = first ? { text: askLine(first, status), ask: first, more: asks.length - 1 } : undefined
  const paused = status.pausedUntil !== undefined && DateTime.isGreaterThan(status.pausedUntil, now)
  const rows = rowsOf(status, messages, now)
  const shownWaiting = new Set(rows?.all.flatMap((r) => (r.waiting ? [r.waiting.id] : [])) ?? [])
  const loose = asks.filter((a) => !shownWaiting.has(a.id))
  const looseNeed =
    rows && loose[0] ? { text: askLine(loose[0], status), ask: loose[0], more: loose.length - 1 } : undefined
  const view = (text: string, stand: CardView["stand"]): CardView => ({
    text,
    stand,
    paused,
    track: trackOf(status.milestones),
    need,
    rows,
    looseNeed
  })
  if (status.now) return view(status.now, "now")
  // Agents don't always write a Status card; then the last thing they said in Chat stands in for it.
  const latest = messages.findLast(
    (m): m is TextMessage => m._tag === "Text" && m.from === "agent" && m.text !== unsupportedText
  )
  if (latest) return view(plainText(latest.text), "latest")
  return view(earlyNote(messages), "early")
}
