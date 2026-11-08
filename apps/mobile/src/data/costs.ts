/**
 * How what Dream pays to run their projects reads on screen (`packages/domain/src/Costs.ts`): a section of a
 * project's usage sheet, a tile in Settings, and the full-screen detail it opens. Never mixed with the plan's
 * percentages in `usage.ts`: these are dollars Dream pays, apart from OpenAI calls their own key paid, which always
 * show on their own. Pure, so it's tested in Node. Amounts are estimates at list prices.
 */
import type {
  AccountCosts,
  CostDay,
  CostLine,
  CostPeriod,
  ModelCost,
  OperatorCosts,
  ProjectCost,
  ProjectCosts
} from "@dream/domain"
import { DateTime } from "effect"

/** "$18.42", "$1,240", "<$0.01" for a cost too small to show in cents, "$0" for nothing. */
export const dollars = (usd: number): string => {
  if (usd <= 0) return "$0"
  if (usd < 0.005) return "<$0.01"
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString("en-US")}`
  return `$${usd.toFixed(2)}`
}

/** What each cost center is called, in their words rather than a vendor's. */
export const centerTitle = {
  sandbox: "Machine time",
  browser: "Cloud browsers",
  mac: "Macs",
  openai: "OpenAI",
  storage: "Storage",
  email: "Email"
} as const

const count = (n: number, one: string, many: string) => {
  const rounded = Math.round(n)
  return `${rounded.toLocaleString("en-US")} ${rounded === 1 ? one : many}`
}

/** A span of time read naturally: "40 minutes", "1.5 hours", "41 hours". */
const timeSpan = (hours: number) => {
  if (hours < 1) return count(Math.max(1, hours * 60), "minute", "minutes")
  if (hours < 10) {
    const tenths = Math.round(hours * 10) / 10
    return Number.isInteger(tenths) ? count(tenths, "hour", "hours") : `${tenths} hours`
  }
  return count(hours, "hour", "hours")
}

/**
 * What a line's dollars bought: "41 hours", "52 minutes", "1,240 requests", "31 emails". Storage says nothing,
 * since GB-months so far this month don't read as anything.
 */
export const quantityLabel = (line: Pick<CostLine, "quantity" | "unit">): string | undefined => {
  if (line.quantity <= 0) return undefined
  switch (line.unit) {
    case "hour":
      return timeSpan(line.quantity)
    case "minute":
      return timeSpan(line.quantity / 60)
    case "request":
      return count(line.quantity, "request", "requests")
    case "message":
      return count(line.quantity, "email", "emails")
    case "gbMonth":
      return undefined
  }
}

/** "November", the period's month (periods are UTC months). */
export const monthName = (period: Pick<CostPeriod, "from">) =>
  new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(DateTime.toDateUtc(period.from))

/** One row: what it paid for, how much of it, and the amount; OpenAI's models under it. */
export interface CostRowView {
  readonly key: string
  readonly title: string
  readonly detail?: string
  readonly amount: string
  readonly models: ReadonlyArray<CostRowView>
}

const modelRow = (m: ModelCost): CostRowView => ({
  key: `${m.payer}:${m.model}`,
  title: m.model,
  detail: count(m.requests, "request", "requests"),
  amount: dollars(m.usd),
  models: []
})

/**
 * One payer's lines, largest first as given. OpenAI's models go under it, or into its title when there's only one
 * ("OpenAI · gpt-6.1-terra").
 */
const lineRows = (period: CostPeriod, payer: CostLine["payer"]): ReadonlyArray<CostRowView> => {
  const models = period.models.filter((m) => m.payer === payer)
  return period.lines
    .filter((l) => l.payer === payer)
    .map((l) => {
      const detail = quantityLabel(l)
      const openai = l.center === "openai"
      const only = openai && models.length === 1 ? models[0] : undefined
      return {
        key: `${payer}:${l.center}`,
        title: only ? `OpenAI · ${only.model}` : centerTitle[l.center],
        ...(detail ? { detail } : {}),
        amount: dollars(l.usd),
        models: openai && models.length > 1 ? models.map(modelRow) : []
      }
    })
}

const personTotal = (period: CostPeriod) =>
  period.lines.filter((l) => l.payer === "person").reduce((n, l) => n + l.usd, 0)

/** What their own OpenAI key paid through Dream: shown apart, never added to Dream's total. */
export interface OwnKeyView {
  readonly amount: string
  readonly rows: ReadonlyArray<CostRowView>
}

const ownKey = (period: CostPeriod): OwnKeyView | undefined => {
  const rows = lineRows(period, "person")
  return rows.length === 0 ? undefined : { amount: dollars(personTotal(period)), rows }
}

/** "$15.10 in October", or nothing when last month cost nothing. */
const lastMonthLabel = (last: CostPeriod) => (last.usd > 0 ? `${dollars(last.usd)} in ${monthName(last)}` : undefined)

// ---------------------------------------------------------------------------
// A project's usage sheet
// ---------------------------------------------------------------------------

export interface ProjectCostsView {
  /** "What Dream paid in November" */
  readonly heading: string
  readonly total: string
  readonly lastMonth?: string
  readonly rows: ReadonlyArray<CostRowView>
  readonly ownKey?: OwnKeyView
}

/** Absent when the project has cost nothing this month or last (a project just started), so the sheet stays short. */
export const projectCostsView = (costs: ProjectCosts): ProjectCostsView | undefined => {
  const { month, lastMonth } = costs
  if (month.lines.length === 0 && lastMonth.usd <= 0 && personTotal(lastMonth) <= 0) return undefined
  const last = lastMonthLabel(lastMonth)
  const own = ownKey(month)
  return {
    heading: `What Dream paid in ${monthName(month)}`,
    total: dollars(month.usd),
    ...(last ? { lastMonth: last } : {}),
    rows: lineRows(month, "dream"),
    ...(own ? { ownKey: own } : {})
  }
}

// ---------------------------------------------------------------------------
// The last 30 days, as bars
// ---------------------------------------------------------------------------

export interface DayBar {
  readonly day: string
  /** 0–1 against the costliest day. */
  readonly height: number
  /** "Nov 3 · $1.20", what touching it says. */
  readonly label: string
}

const shortDay = (day: string) => {
  const date = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(date.getTime())
    ? day
    : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date)
}

export const dayBars = (days: ReadonlyArray<CostDay>): ReadonlyArray<DayBar> => {
  const most = Math.max(0, ...days.map((d) => d.usd))
  return days.map((d) => ({
    day: d.day,
    height: most > 0 ? d.usd / most : 0,
    label: `${shortDay(d.day)} · ${dollars(d.usd)}`
  }))
}

// ---------------------------------------------------------------------------
// Settings and the full-screen detail
// ---------------------------------------------------------------------------

/** Settings' tile: this month's total, last month's, and the 30 days small. */
export interface CostsTileView {
  readonly total: string
  /** "so far in November · $15.10 in October" */
  readonly caption: string
  readonly days: ReadonlyArray<DayBar>
  /** "$1.20 more on your OpenAI key" */
  readonly ownKey?: string
}

export const costsTile = (costs: Pick<AccountCosts, "month" | "lastMonth" | "days">): CostsTileView => {
  const last = lastMonthLabel(costs.lastMonth)
  const own = personTotal(costs.month)
  return {
    total: dollars(costs.month.usd),
    caption: [`so far in ${monthName(costs.month)}`, last].filter(Boolean).join(" · "),
    days: dayBars(costs.days),
    ...(own > 0 ? { ownKey: `${dollars(own)} more on your OpenAI key` } : {})
  }
}

/** A project's (or a person's) share of the month, as a bar against the largest. */
export interface ShareView {
  readonly key: string
  readonly title: string
  readonly icon?: string
  readonly detail?: string
  readonly amount: string
  readonly bar: number
  /** A project to open; absent for archived, deleted and outside rows. */
  readonly projectId?: ProjectCost["projectId"]
  /** Not a project: drawn on a dashed tile. */
  readonly outside: boolean
}

/**
 * What the API calls a project that's gone, as in the plan's breakdown (`usage.ts`); it comes archived, without an
 * icon.
 */
const deletedTitle = "Deleted project"

const projectShares = (projects: ReadonlyArray<ProjectCost>, unattributedUsd: number): ReadonlyArray<ShareView> => {
  const isDeleted = (p: ProjectCost) => p.title === deletedTitle && p.icon === undefined && p.archived === true
  const named = projects.filter((p) => !isDeleted(p))
  const deleted = projects.filter(isDeleted)
  const deletedUsd = deleted.reduce((n, p) => n + p.usd, 0)
  const largest = Math.max(0, ...named.map((p) => p.usd), deletedUsd, unattributedUsd)
  const bar = (usd: number) => (largest > 0 ? usd / largest : 0)
  const rows: Array<ShareView & { readonly usd: number }> = named.map((p) => ({
    key: p.projectId,
    title: p.title,
    ...(p.icon ? { icon: p.icon } : {}),
    ...(p.archived
      ? { detail: "Archived" }
      : p.personUsd
        ? { detail: `and ${dollars(p.personUsd)} on your key`, projectId: p.projectId }
        : { projectId: p.projectId }),
    amount: dollars(p.usd),
    bar: bar(p.usd),
    outside: false,
    usd: p.usd
  }))
  if (deleted.length > 0)
    rows.push({
      key: "deleted",
      title: deleted.length > 1 ? "Deleted projects" : deletedTitle,
      icon: "trash",
      amount: dollars(deletedUsd),
      bar: bar(deletedUsd),
      outside: false,
      usd: deletedUsd
    })
  if (unattributedUsd > 0)
    rows.push({
      key: "outside",
      title: "Outside your projects",
      detail: "Signing in to your plan",
      amount: dollars(unattributedUsd),
      bar: bar(unattributedUsd),
      outside: true,
      usd: unattributedUsd
    })
  return rows.sort((a, b) => b.usd - a.usd).map(({ usd: _, ...row }) => row)
}

export interface AccountCostsView {
  readonly total: string
  readonly caption: string
  readonly days: ReadonlyArray<DayBar>
  readonly rows: ReadonlyArray<CostRowView>
  readonly projects: ReadonlyArray<ShareView>
  readonly ownKey?: OwnKeyView
  /** An operator's way into everyone's costs. */
  readonly everyone: boolean
}

export const accountCostsView = (costs: AccountCosts): AccountCostsView => {
  const tile = costsTile(costs)
  const own = ownKey(costs.month)
  const unattributed = costs.unattributed.filter((l) => l.payer === "dream").reduce((n, l) => n + l.usd, 0)
  return {
    total: tile.total,
    caption: tile.caption,
    days: tile.days,
    rows: lineRows(costs.month, "dream"),
    projects: projectShares(costs.projects, unattributed),
    ...(own ? { ownKey: own } : {}),
    everyone: costs.everyone !== undefined
  }
}

/** The operator's view: everything Dream paid, each person's share, and what no one caused. */
export interface EveryoneView {
  readonly total: string
  readonly caption: string
  readonly days: ReadonlyArray<DayBar>
  readonly rows: ReadonlyArray<CostRowView>
  readonly people: ReadonlyArray<ShareView>
  readonly overhead: ReadonlyArray<CostRowView>
  readonly overheadTotal: string
}

export const everyoneView = (everyone: OperatorCosts): EveryoneView => {
  const tile = costsTile(everyone)
  const largest = Math.max(0, ...everyone.people.map((p) => p.usd))
  const overhead = everyone.overhead.filter((l) => l.payer === "dream")
  return {
    total: tile.total,
    caption: tile.caption,
    days: tile.days,
    rows: lineRows(everyone.month, "dream"),
    people: everyone.people.map((p) => ({
      key: p.userId,
      title: p.name,
      detail: count(p.projects, "project", "projects"),
      amount: dollars(p.usd),
      bar: largest > 0 ? p.usd / largest : 0,
      outside: false
    })),
    overhead: overhead.map((l) => {
      const detail = quantityLabel(l)
      return {
        key: l.center,
        title: centerTitle[l.center],
        ...(detail ? { detail } : {}),
        amount: dollars(l.usd),
        models: []
      }
    }),
    overheadTotal: dollars(overhead.reduce((n, l) => n + l.usd, 0))
  }
}
