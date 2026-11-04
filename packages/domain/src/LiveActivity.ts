/**
 * The Lock Screen / Dynamic Island Live Activity, driven by `dream live`.
 * These shapes are decoded by Swift's `Codable` in the widget target, so they
 * stay flat: strings and integers only, optional keys omitted rather than null,
 * and no dates (Swift would read them as seconds since 2001).
 */
import { Schema } from "effect"
import { ProjectId } from "./Ids.ts"

/** The `attributes-type` in APNs push-to-start payloads: the Swift `ActivityAttributes` struct name. */
export const LiveActivityAttributesType = "DreamActivityAttributes"

/** Static for the life of an activity. Set by Dream when it starts one. */
export const LiveActivityAttributes = Schema.Struct({
  projectId: ProjectId,
  projectName: Schema.String,
  /** SF Symbol name, as on the project tile. */
  icon: Schema.optionalKey(Schema.String)
})
export type LiveActivityAttributes = typeof LiveActivityAttributes.Type

/** The `content-state`: what the agent shows, updated with `dream live update`. */
export const LiveActivityContent = Schema.Struct({
  /** The big line, e.g. "Building progress charts". */
  title: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
  /** e.g. "Squat, bench and deadlift". */
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  /** e.g. "Rest timer", shown as "Next · Rest timer". */
  next: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
  /** Progress through milestones, shown as segments and "3 of 5". */
  step: Schema.optionalKey(Schema.Struct({ current: Schema.Int, total: Schema.Int })),
  /** Small corner label, e.g. "Day 3". */
  badge: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20))),
  /** Set by Dream while a question or access request is open: the activity switches to "Needs you". */
  needsYou: Schema.optionalKey(Schema.Struct({ prompt: Schema.String }))
})
export type LiveActivityContent = typeof LiveActivityContent.Type
