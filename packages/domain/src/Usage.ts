import { Schema } from "effect"
import { ProjectId } from "./Ids.ts"

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

// ---------------------------------------------------------------------------
// What each project used
// ---------------------------------------------------------------------------

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Dollars = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Percent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }))

/**
 * How the person pays for the model. Every connection today is a subscription, with its five-hour and weekly
 * windows; an API key would be pay as you go, in dollars, with no windows.
 */
export const UsageBilling = Schema.Literals(["subscription", "apiKey"])
export type UsageBilling = typeof UsageBilling.Type

/** Tokens as a harness reports them: exact. Input is split by how it was cached. */
export const TokenUsage = Schema.Struct({
  /** Input read fresh, not from the cache. */
  input: Count,
  cacheRead: Count,
  cacheWrite: Count,
  /** Output, reasoning included. */
  output: Count
})
export type TokenUsage = typeof TokenUsage.Type

/** One turn's use of the model, which dreamd sends with `ReportTurn` when the turn finishes. */
export const TurnUsage = Schema.Struct({
  tokens: TokenUsage,
  /** What the turn costs at list prices, as Claude Code reports it. Codex reports no cost. */
  costUsd: Schema.optionalKey(Dollars),
  /** Whether subagents' tokens are counted in `tokens` and `costUsd`. Absent when dreamd can't tell. */
  subagents: Schema.optionalKey(Schema.Literals(["included", "excluded"]))
})
export type TurnUsage = typeof TurnUsage.Type

/** A usage window seen from one project: how full it is, and how much of it is (about) this project's. */
export const WindowShare = Schema.Struct({
  /** The whole window, as the provider reports it: exact. */
  usedPercent: Percent,
  /** This project's part of `usedPercent`: estimated. */
  projectPercent: Percent,
  resetsAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type WindowShare = typeof WindowShare.Type

/**
 * What the project header shows, which `ProjectEvent.Usage` pushes after each turn. `weekly` is absent when Dream
 * doesn't know how full the week is, or this project hasn't worked in it; the header then shows nothing.
 */
export const ProjectUsageGlance = Schema.Struct({
  provider: ModelProvider,
  billing: UsageBilling,
  weekly: Schema.optionalKey(WindowShare),
  observedAt: Schema.DateTimeUtc
})
export type ProjectUsageGlance = typeof ProjectUsageGlance.Type

/** This project's use over one period. */
export const UsagePeriod = Schema.Struct({
  /**
   * Exact: input, cache writes and output. Absent when no turn in the period reported tokens (dreamd builds before
   * this didn't).
   */
  tokens: Schema.optionalKey(Count),
  /** Input read from the cache, counted apart from `tokens` because it dwarfs them (and costs a tenth). */
  cacheReadTokens: Schema.optionalKey(Count),
  /**
   * Its estimated share of the window the period is measured against: the five-hour window for `fiveHour`, the
   * week for `today` and `week`. Absent on an API key, or when the window isn't known.
   */
  sharePercent: Schema.optionalKey(Percent),
  /** On an API key: dollars (Claude's as reported, Codex's estimated from tokens). */
  costUsd: Schema.optionalKey(Dollars)
})
export type UsagePeriod = typeof UsagePeriod.Type

/** One project's estimated share of the week. */
export const ProjectShare = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  icon: Schema.optionalKey(Schema.String),
  sharePercent: Percent
})
export type ProjectShare = typeof ProjectShare.Type

/** The usage sheet (`AppRpcs.GetProjectUsage`). Shares are estimates; tokens are exact. */
export const ProjectUsage = Schema.Struct({
  ...ProjectUsageGlance.fields,
  /** Display name such as "Claude Max", when known. */
  plan: Schema.optionalKey(Schema.String),
  /** Since midnight in their time zone. */
  today: UsagePeriod,
  /** The current five-hour window. */
  fiveHour: UsagePeriod,
  /** The current weekly window (the last seven days, when it isn't known). */
  week: UsagePeriod,
  fiveHourWindow: Schema.optionalKey(WindowShare),
  /** Every project of theirs that used this week, largest share first, this one included. */
  projects: Schema.Array(ProjectShare),
  /** The rest of the week's use: claude.ai, the ChatGPT app, a CLI on their laptop. */
  outsideDreamPercent: Schema.optionalKey(Percent),
  /** Whether subagents' tokens are counted; absent when some turns couldn't say. */
  subagents: Schema.optionalKey(Schema.Literals(["included", "excluded"]))
})
export type ProjectUsage = typeof ProjectUsage.Type

/** A usage window across all their projects: how full it is, and how much of it is (about) Dream's. */
export const AccountWindow = Schema.Struct({
  /** The whole window, as the provider reports it: exact. */
  usedPercent: Percent,
  /** Every project's part of `usedPercent` together: estimated. The rest is use outside Dream. */
  dreamPercent: Percent,
  resetsAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type AccountWindow = typeof AccountWindow.Type

/**
 * Settings' plan card (`AppRpcs.GetAccountUsage`): one subscription's windows, and every project's estimated share
 * of its week. A window is absent when Dream doesn't know how full it is.
 */
export const AccountUsage = Schema.Struct({
  provider: ModelProvider,
  billing: UsageBilling,
  /** Display name such as "Claude Max", when known. */
  plan: Schema.optionalKey(Schema.String),
  fiveHour: Schema.optionalKey(AccountWindow),
  weekly: Schema.optionalKey(AccountWindow),
  /** Every project of theirs that used this week, largest share first. Empty when the week isn't known. */
  projects: Schema.Array(ProjectShare),
  /** The rest of the week's use: claude.ai, the ChatGPT app, a CLI on their laptop. */
  outsideDreamPercent: Schema.optionalKey(Percent),
  observedAt: Schema.DateTimeUtc
})
export type AccountUsage = typeof AccountUsage.Type
