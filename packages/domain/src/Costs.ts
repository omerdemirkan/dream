/**
 * What Dream pays for to run a project: sandbox time, cloud browsers, Macs, OpenAI calls through Dream's gateway,
 * media storage and email. Not the person's Claude or ChatGPT subscription, which is `Usage.ts`: the two are
 * measured differently (dollars at list prices here, a plan's percentages there) and are never added together.
 *
 * Dollar amounts are estimates: the Worker prices each metered event from a dated price book as it records it.
 * The ledger itself keeps the raw quantities (milliseconds, tokens, bytes) as usage events with no prices, so a
 * billing platform added later can rate them itself. Added November 2026.
 */
import { Schema } from "effect"
import { ProjectId, UserId } from "./Ids.ts"

const Dollars = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Quantity = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

/** The things Dream pays a provider for. */
export const CostCenter = Schema.Literals(["sandbox", "browser", "mac", "openai", "storage", "email"])
export type CostCenter = typeof CostCenter.Type

/**
 * Who paid: Dream, or the person, for OpenAI calls Dream's gateway made with an OpenAI key of their own (a key they
 * connected for api.openai.com is used instead of Dream's).
 */
export const CostPayer = Schema.Literals(["dream", "person"])
export type CostPayer = typeof CostPayer.Type

/** The unit a line's `quantity` is in. */
export const CostUnit = Schema.Literals(["hour", "minute", "request", "gbMonth", "message"])
export type CostUnit = typeof CostUnit.Type

/** One cost center's part of a period. */
export const CostLine = Schema.Struct({
  center: CostCenter,
  payer: CostPayer,
  /** Estimated, at list prices. */
  usd: Dollars,
  /** What the dollars are for, in `unit`: sandbox hours, browser and Mac minutes, OpenAI requests, … */
  quantity: Quantity,
  unit: CostUnit
})
export type CostLine = typeof CostLine.Type

/** What one OpenAI model cost in a period, for the detail view. */
export const ModelCost = Schema.Struct({
  model: Schema.String,
  payer: CostPayer,
  usd: Dollars,
  requests: Quantity
})
export type ModelCost = typeof ModelCost.Type

/** One period's costs: a calendar month (UTC), or a day. */
export const CostPeriod = Schema.Struct({
  from: Schema.DateTimeUtc,
  /** Exclusive; for the current month, the end of the month. */
  to: Schema.DateTimeUtc,
  /** What Dream paid: the `dream` lines together. */
  usd: Dollars,
  /** Largest first; centers with nothing in the period are left out. */
  lines: Schema.Array(CostLine),
  /** OpenAI by model, largest first; empty without OpenAI calls. */
  models: Schema.Array(ModelCost)
})
export type CostPeriod = typeof CostPeriod.Type

/** What Dream paid on one UTC day (`YYYY-MM-DD`), for a small chart of the last 30 days. */
export const CostDay = Schema.Struct({ day: Schema.String, usd: Dollars })
export type CostDay = typeof CostDay.Type

/** A project's costs (`AppRpcs.GetProjectCosts`, `SandboxRpcs.GetProjectCosts` for `dream usage`). */
export const ProjectCosts = Schema.Struct({
  projectId: ProjectId,
  month: CostPeriod,
  lastMonth: CostPeriod,
  /** The last 30 UTC days, oldest first, today included. */
  days: Schema.Array(CostDay)
})
export type ProjectCosts = typeof ProjectCosts.Type

/** One project's share of a month, for a list. */
export const ProjectCost = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  icon: Schema.optionalKey(Schema.String),
  /** What Dream paid for it this month. */
  usd: Dollars,
  /** What their own OpenAI key paid through Dream's gateway this month; absent when nothing. */
  personUsd: Schema.optionalKey(Dollars),
  /** Archived or deleted projects still count in the month they cost something. */
  archived: Schema.optionalKey(Schema.Boolean)
})
export type ProjectCost = typeof ProjectCost.Type

/** One person's share of a month, for the operator's view. */
export const PersonCost = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  usd: Dollars,
  projects: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
export type PersonCost = typeof PersonCost.Type

/**
 * Everything Dream paid for, across a whole deployment: only for operators (`DREAM_OPERATORS`). `overhead` is what
 * no project or person caused: template builds, checks, refresh donors and other throwaway sandboxes.
 */
export const OperatorCosts = Schema.Struct({
  month: CostPeriod,
  lastMonth: CostPeriod,
  days: Schema.Array(CostDay),
  /** Everyone with costs this month, largest first. */
  people: Schema.Array(PersonCost),
  /** This month's costs that belong to no person, by center. */
  overhead: Schema.Array(CostLine)
})
export type OperatorCosts = typeof OperatorCosts.Type

/** Their costs across all their projects (`AppRpcs.GetAccountCosts`). */
export const AccountCosts = Schema.Struct({
  month: CostPeriod,
  lastMonth: CostPeriod,
  days: Schema.Array(CostDay),
  /** Every project with costs this month, largest first. */
  projects: Schema.Array(ProjectCost),
  /**
   * Their costs this month that belong to none of their projects (connecting a subscription, for one), by
   * center. Included in `month`.
   */
  unattributed: Schema.Array(CostLine),
  /** Present only for an operator. */
  everyone: Schema.optionalKey(OperatorCosts)
})
export type AccountCosts = typeof AccountCosts.Type
