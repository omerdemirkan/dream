/**
 * The Status tab: a living roadmap the agent keeps current with `dream status`.
 */
import { Schema } from "effect"
import { MessageId } from "./Ids.ts"
import { MediaRef } from "./Media.ts"
import { ProjectPhase } from "./Project.ts"

/**
 * Something the agent will need from them, pinned to the milestone where it
 * matters, e.g. "Your Apple Developer account", "around Thursday".
 */
export const Need = Schema.Struct({
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
  /** One supporting line, e.g. "11 newsletters, 4 min read." */
  detail: Schema.optionalKey(Schema.String),
  needs: Schema.Array(Need)
})
export type Milestone = typeof Milestone.Type

export const StatusCard = Schema.Struct({
  phase: ProjectPhase,
  /** When the current phase began ("Building · day 3"). */
  phaseSince: Schema.DateTimeUtc,
  now: Schema.optionalKey(Schema.String),
  justDid: Schema.optionalKey(Schema.String),
  next: Schema.optionalKey(Schema.String),
  /** Screenshots and recordings shown with `justDid`. */
  media: Schema.Array(MediaRef),
  milestones: Schema.Array(Milestone),
  /** Set by Dream, not the agent, while a usage limit holds the project. */
  pausedUntil: Schema.optionalKey(Schema.DateTimeUtc),
  updatedAt: Schema.DateTimeUtc
})
export type StatusCard = typeof StatusCard.Type
