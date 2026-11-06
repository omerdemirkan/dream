/**
 * The Status card: a living roadmap the agent keeps current with `dream status`.
 *
 * The app shows it pinned above Chat: the `now` sentence on one line and the milestone track, and an amber line
 * while a need's question or access request is open. Opened, it shows `now` large, that need, the media with their
 * captions, and each milestone as its title and date. `justDid`, `next` and a milestone's `detail` are no longer
 * shown or asked for (November 2026); they stay in the contract, optional, because older builds still read them.
 */
import { Schema } from "effect"
import { MessageId } from "./Ids.ts"
import { fitLine } from "./Links.ts"
import { MediaRef } from "./Media.ts"
import { ProjectPhase } from "./Project.ts"

/**
 * Something the agent will need from them, pinned to the milestone where it
 * matters, e.g. "Your Apple Developer account", "around Thursday".
 */
export const Need = Schema.Struct({
  /** A short noun phrase, shown as "Needs …" in amber while its ask is open. */
  what: Schema.NonEmptyString,
  /** Roughly when, in the agent's words. Absent means now. */
  when: Schema.optionalKey(Schema.String),
  /** The question or access request that resolves this need, once the agent has sent one. */
  messageId: Schema.optionalKey(MessageId)
})
export type Need = typeof Need.Type

export const MilestoneState = Schema.Literals(["done", "current", "upcoming"])
export type MilestoneState = typeof MilestoneState.Type

export const Milestone = Schema.Struct({
  title: Schema.NonEmptyString,
  state: MilestoneState,
  /** When it was done, or when it's expected (e.g. the next scheduled run). */
  date: Schema.optionalKey(Schema.DateTimeUtc),
  /** One supporting line, e.g. "11 newsletters, 4 min read." No longer shown (see above). */
  detail: Schema.optionalKey(Schema.String),
  needs: Schema.Array(Need)
})
export type Milestone = typeof Milestone.Type

export const StatusCard = Schema.Struct({
  phase: ProjectPhase,
  /** When the current phase began ("Building · day 3"). */
  phaseSince: Schema.DateTimeUtc,
  /** One sentence: one line on the card above Chat (see `nowOnCard`), the large line when it's opened. */
  now: Schema.optionalKey(Schema.String),
  /** No longer shown (see above). */
  justDid: Schema.optionalKey(Schema.String),
  /** No longer shown (see above). */
  next: Schema.optionalKey(Schema.String),
  /** Screenshots and recordings shown with `justDid`. */
  media: Schema.Array(MediaRef),
  milestones: Schema.Array(Milestone),
  /** Set by Dream, not the agent, while a usage limit holds the project. */
  pausedUntil: Schema.optionalKey(Schema.DateTimeUtc),
  updatedAt: Schema.DateTimeUtc
})
export type StatusCard = typeof StatusCard.Type

/** The card's one line for `now` on a 6.3" iPhone: 17 pt type, about 300 pt wide beside the card’s chevron (315 here: the estimate runs a little wide; checked in the Simulator). */
export const nowOnCard = (now: string): { readonly shown: string; readonly whole: boolean } =>
  fitLine(now.replace(/\s+/g, " ").trim(), 315, 17)

/** The amber line for a need: "Your OpenAI API key" → "Needs your OpenAI API key". */
export const needLine = (what: string): string => {
  const text = what.trim()
  const first = /^(Your|A|An|The|Some|Access)\b/.exec(text)
  return `Needs ${first ? `${first[1]?.toLowerCase()}${text.slice(first[1]?.length ?? 0)}` : text}`
}
