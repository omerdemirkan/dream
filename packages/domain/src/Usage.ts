import { Schema } from "effect"

/** The subscription the harness runs on. Claude Code uses "claude", Codex uses "chatgpt". */
export const ModelProvider = Schema.Literals(["claude", "chatgpt"])
export type ModelProvider = typeof ModelProvider.Type

/** The two rolling limits both subscriptions have. */
export const UsageWindowName = Schema.Literals(["fiveHour", "weekly"])
export type UsageWindowName = typeof UsageWindowName.Type

export const UsageWindow = Schema.Struct({
  /** 0–100. */
  usedPercent: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type UsageWindow = typeof UsageWindow.Type

/**
 * Where a subscription stands, as last read from the harness by dreamd.
 * Windows are optional because a harness may not report both.
 */
export const UsageSnapshot = Schema.Struct({
  provider: ModelProvider,
  /** Display name such as "ChatGPT Pro" or "Claude Max", when known. */
  plan: Schema.optionalKey(Schema.String),
  fiveHour: Schema.optionalKey(UsageWindow),
  weekly: Schema.optionalKey(UsageWindow),
  /** Set when a limit has been hit: no turns run until then, and the agent is woken at that time. */
  limitedUntil: Schema.optionalKey(Schema.Struct({ window: UsageWindowName, until: Schema.DateTimeUtc })),
  observedAt: Schema.DateTimeUtc
})
export type UsageSnapshot = typeof UsageSnapshot.Type
