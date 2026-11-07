import { Schema } from "effect"
import { DeviceId, UserId } from "./Ids.ts"

/** An IANA time zone name such as "America/Los_Angeles", reported by the phone. */
export const TimeZone = Schema.NonEmptyString.check(Schema.isMaxLength(64))
export type TimeZone = typeof TimeZone.Type

export const User = Schema.Struct({
  id: UserId,
  email: Schema.String,
  name: Schema.optionalKey(Schema.String),
  /** The time zone of their most recently active device; turn prompts and cron wakes use it. */
  timeZone: Schema.optionalKey(TimeZone),
  createdAt: Schema.DateTimeUtc
})
export type User = typeof User.Type

/** One install of the app. Push tokens arrive after permission is granted, so both are optional. */
export const Device = Schema.Struct({
  id: DeviceId,
  userId: UserId,
  platform: Schema.Literal("ios"),
  /** Hex APNs device token for alerts and silent pushes. */
  apnsToken: Schema.optionalKey(Schema.String),
  /** ActivityKit push-to-start token, used to start a Live Activity remotely (iOS 17.2+). */
  pushToStartToken: Schema.optionalKey(Schema.String),
  timeZone: TimeZone,
  appVersion: Schema.optionalKey(Schema.String),
  updatedAt: Schema.DateTimeUtc
})
export type Device = typeof Device.Type

/**
 * What this deployment of Dream can do, for the app to show only what works. Fields are added as features are, and
 * absent means no, so an older API (or one that predates a field) turns nothing on. Added in November 2026.
 */
export const Features = Schema.Struct({
  /** Access requests can be emailed to finish on a computer (`EmailAccessLink`). */
  emailLinks: Schema.optionalKey(Schema.Boolean)
})
export type Features = typeof Features.Type
