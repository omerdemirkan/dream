/**
 * How what Dream pays to run their projects reads on screen (`packages/domain/src/Costs.ts`): a section of a
 * project's usage sheet, a tile in Settings, and the full-screen detail it opens. Never mixed with the plan's
 * percentages in `usage.ts`: these are dollars Dream pays. Only Dream's lines (`payer: "dream"`) show; anything
 * else is left out. Pure, so it's tested in Node. Amounts are estimates at list prices.
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
import type { Sentence } from "./format.ts"

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
  models: "OpenAI",
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

/** One row: what it paid for, how much of it, and the amount; the models under their line. */
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
 * Dream's lines, largest first as given. The models go under theirs, or into its title when there's only one
 * ("OpenAI · gpt-4o-mini-tts").
 */
const lineRows = (period: CostPeriod): ReadonlyArray<CostRowView> => {
  const payer: CostLine["payer"] = "dream"
  const models = period.models.filter((m) => m.payer === payer)
  return period.lines
    .filter((l) => l.payer === payer)
    .map((l) => {
      const detail = quantityLabel(l)
      const openai = l.center === "models"
      const only = openai && models.length === 1 ? models[0] : undefined
      return {
        key: `${payer}:${l.center}`,
        title: only ? `${centerTitle[l.center]} · ${only.model}` : centerTitle[l.center],
        ...(detail ? { detail } : {}),
        amount: dollars(l.usd),
        models: openai && models.length > 1 ? models.map(modelRow) : []
      }
    })
}

/** "$15.10 in October", or nothing when last month cost nothing. */
const lastMonthLabel = (last: CostPeriod) => (last.usd > 0 ? `${dollars(last.usd)} in ${monthName(last)}` : undefined)

// ---------------------------------------------------------------------------
// A project's usage sheet
// ---------------------------------------------------------------------------

/**
 * What Dream paid for the project this month, said in a sentence under the plan's in the usage sheet, and, when it
 * paid for more than one thing, the lines it paid for, which the sentence opens into.
 */
export interface ProjectCostsSummary {
  readonly sentence: Sentence
  /** Every line Dream paid this month, largest first; empty when the sentence already names the only one. */
  readonly rows: ReadonlyArray<CostRowView>
  /** "$34.80 in October", under the lines. */
  readonly lastMonth?: string
}

/** What one line bought, finishing "Dream paid $0.41 this month …". */
const boughtWith: Record<CostLine["center"], (quantity: string | undefined) => string> = {
  sandbox: (q) => `to keep its computer running${q ? `, for ${q}` : ""}`,
  browser: (q) => (q ? `for ${q} of cloud browsers` : "for cloud browsers"),
  mac: (q) => (q ? `for ${q} on a Mac` : "for a Mac"),
  models: (q) => (q ? `for ${q} its apps made to OpenAI` : "for what its apps asked of OpenAI"),
  storage: () => "to store its files",
  email: (q) => (q ? `to send ${q}` : "to send its email")
}

/** What most of a month went to, finishing "…, most of it for machine time." */
const mostlyFor: Record<CostLine["center"], string> = {
  sandbox: "machine time",
  browser: "cloud browsers",
  mac: "Macs",
  models: "OpenAI",
  storage: "storage",
  email: "email"
}

const notYourPlan = " None of that comes out of your plan."

/** Absent when the project has cost nothing this month or last (a project just started), so the sheet stays short. */
export const projectCostsSummary = (costs: ProjectCosts): ProjectCostsSummary | undefined => {
  const { month, lastMonth } = costs
  const rows = lineRows(month)
  if (rows.length === 0 && lastMonth.usd <= 0) return undefined
  const last = lastMonthLabel(lastMonth)
  const paid = month.lines.filter((l) => l.payer === "dream" && dollars(l.usd) !== "$0")
  const only = paid.length === 1 ? paid[0] : undefined
  if (month.usd <= 0 || paid.length === 0)
    return {
      sentence: [
        {
          text: `Dream hasn’t paid anything to run it this month${last ? `, and paid ${last}` : ""}.${last ? notYourPlan : ""}`
        }
      ],
      rows: []
    }
  if (only)
    return {
      sentence: [
        { text: "Dream paid " },
        { text: dollars(month.usd), tone: "strong" },
        { text: ` this month ${boughtWith[only.center](quantityLabel(only))}.${notYourPlan}` }
      ],
      rows: [],
      ...(last ? { lastMonth: last } : {})
    }
  const largest = paid.reduce((a, b) => (b.usd > a.usd ? b : a))
  return {
    sentence: [
      { text: "Dream paid " },
      { text: dollars(month.usd), tone: "strong" },
      {
        text: ` this month to run it${largest.usd > month.usd / 2 ? `, most of it for ${mostlyFor[largest.center]}` : ""}.${notYourPlan}`
      }
    ],
    rows,
    ...(last ? { lastMonth: last } : {})
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
  /** The caption in two parts, for Settings' narrower card: "so far in November", "$15.10 in October". */
  readonly month: string
  readonly lastMonth?: string
  readonly days: ReadonlyArray<DayBar>
}

export const costsTile = (costs: Pick<AccountCosts, "month" | "lastMonth" | "days">): CostsTileView => {
  const last = lastMonthLabel(costs.lastMonth)
  const month = `so far in ${monthName(costs.month)}`
  return {
    total: dollars(costs.month.usd),
    caption: [month, last].filter(Boolean).join(" · "),
    month,
    ...(last ? { lastMonth: last } : {}),
    days: dayBars(costs.days)
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
 * icon. Workers before Nov 8 said "A deleted project".
 */
const deletedTitle = "Deleted project"
const deletedTitles: ReadonlyArray<string> = [deletedTitle, "A deleted project"]

const projectShares = (projects: ReadonlyArray<ProjectCost>, unattributedUsd: number): ReadonlyArray<ShareView> => {
  const isDeleted = (p: ProjectCost) => deletedTitles.includes(p.title) && p.icon === undefined && p.archived === true
  const named = projects.filter((p) => !isDeleted(p))
  const deleted = projects.filter(isDeleted)
  const deletedUsd = deleted.reduce((n, p) => n + p.usd, 0)
  const largest = Math.max(0, ...named.map((p) => p.usd), deletedUsd, unattributedUsd)
  const bar = (usd: number) => (largest > 0 ? usd / largest : 0)
  const rows: Array<ShareView & { readonly usd: number }> = named.map((p) => ({
    key: p.projectId,
    title: p.title,
    ...(p.icon ? { icon: p.icon } : {}),
    ...(p.archived ? { detail: "Archived" } : { projectId: p.projectId }),
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
  /** "$15.10 in October", for when this month has nothing yet. */
  readonly lastMonth?: string
  readonly days: ReadonlyArray<DayBar>
  readonly rows: ReadonlyArray<CostRowView>
  readonly projects: ReadonlyArray<ShareView>
  /** An operator's way into everyone's costs. */
  readonly everyone: boolean
}

export const accountCostsView = (costs: AccountCosts): AccountCostsView => {
  const tile = costsTile(costs)
  const unattributed = costs.unattributed.filter((l) => l.payer === "dream").reduce((n, l) => n + l.usd, 0)
  return {
    total: tile.total,
    caption: tile.caption,
    ...(tile.lastMonth ? { lastMonth: tile.lastMonth } : {}),
    days: tile.days,
    rows: lineRows(costs.month),
    projects: projectShares(costs.projects, unattributed),
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
    rows: lineRows(everyone.month),
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
