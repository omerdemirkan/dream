/**
 * What the Status card pinned above Chat says, from a project's state: the "now" sentence, the milestone track,
 * and an amber line while something waits for them. Before the agent writes any Status, the last thing it said
 * (or the early note) stands in for the sentence.
 */
import type { AskMessage, Message, Milestone, MilestoneState, StatusCard, TextMessage } from "@dream/domain"
import { needLine } from "@dream/domain"
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

export interface CardView {
  /** The sentence: `now`, else what stands in for it. */
  readonly text: string
  /** `now` gets one line on the card; what stands in for it, more. */
  readonly stand: "now" | "latest" | "early"
  readonly paused: boolean
  readonly track: Track | undefined
  readonly need: NeedView | undefined
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
  const view = (text: string, stand: CardView["stand"]): CardView => ({
    text,
    stand,
    paused,
    track: trackOf(status.milestones),
    need
  })
  if (status.now) return view(status.now, "now")
  // Agents don't always write a Status card; then the last thing they said in Chat stands in for it.
  const latest = messages.findLast(
    (m): m is TextMessage => m._tag === "Text" && m.from === "agent" && m.text !== unsupportedText
  )
  if (latest) return view(plainText(latest.text), "latest")
  return view(earlyNote(messages), "early")
}
