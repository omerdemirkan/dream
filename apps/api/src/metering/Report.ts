/**
 * The read side of the ledger: what Dream paid, summed from `meter_events` for the app (`AppRpcs.GetProjectCosts`,
 * `GetAccountCosts`) and the agent (`SandboxRpcs.GetProjectCosts`, `dream usage`). Months are UTC calendar months;
 * `days` are the last 30 UTC days, today included. Every figure is the price book's estimate, recorded with each
 * event; `usd` totals count what Dream paid, while lines and models show the person's own OpenAI key too.
 */
import type {
  AccountCosts,
  CostDay,
  CostLine,
  CostPeriod,
  ModelCost,
  OperatorCosts,
  PersonCost,
  ProjectCost,
  ProjectCosts
} from "@dream/domain"
import { CostCenter, CostPayer, ProjectId, UserId } from "@dream/domain"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { ApiConfig } from "../Config.ts"
import { decodeRows } from "../db/Sql.ts"
import { OperatorOwner } from "./Meter.ts"
import { unitOf } from "./Prices.ts"

const DayCount = 30

const SumRow = Schema.Struct({
  owner: Schema.String,
  project_id: Schema.NullOr(Schema.String),
  center: CostCenter,
  payer: CostPayer,
  model: Schema.NullOr(Schema.String),
  day: Schema.String,
  usd: Schema.Finite,
  units: Schema.Finite,
  n: Schema.Finite
})
type SumRow = typeof SumRow.Type

const ProjectRow = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  icon: Schema.NullOr(Schema.String),
  archived_at: Schema.NullOr(Schema.String)
})
const UserRow = Schema.Struct({ id: Schema.String, email: Schema.String, name: Schema.NullOr(Schema.String) })

/** To a hundredth of a cent: enough for the app, and no float noise. */
const round = (usd: number) => Math.round(usd * 10_000) / 10_000

interface Window {
  readonly monthStart: DateTime.Utc
  readonly monthEnd: DateTime.Utc
  readonly lastMonthStart: DateTime.Utc
  /** The days of the chart, oldest first. */
  readonly days: ReadonlyArray<string>
  /** Where reading starts: whichever of last month's start and the chart's first day is earlier. */
  readonly from: DateTime.Utc
}

export const windowAt = (now: DateTime.Utc): Window => {
  const monthStart = DateTime.startOf(now, "month")
  const today = DateTime.startOf(now, "day")
  const firstDay = DateTime.subtract(today, { days: DayCount - 1 })
  const lastMonthStart = DateTime.subtract(monthStart, { months: 1 })
  return {
    monthStart,
    monthEnd: DateTime.add(monthStart, { months: 1 }),
    lastMonthStart,
    days: Array.from({ length: DayCount }, (_, i) => DateTime.formatIsoDate(DateTime.add(firstDay, { days: i }))),
    from: DateTime.isLessThan(firstDay, lastMonthStart) ? firstDay : lastMonthStart
  }
}

const dayOf = (at: DateTime.Utc) => DateTime.formatIsoDate(at)

const inPeriod = (row: SumRow, from: DateTime.Utc, to: DateTime.Utc) => row.day >= dayOf(from) && row.day < dayOf(to)

export const linesOf = (rows: ReadonlyArray<SumRow>): Array<CostLine> => {
  const lines = new Map<string, CostLine>()
  for (const row of rows) {
    const key = `${row.center}:${row.payer}`
    const line = lines.get(key)
    lines.set(key, {
      center: row.center,
      payer: row.payer,
      usd: (line?.usd ?? 0) + row.usd,
      quantity: (line?.quantity ?? 0) + row.units,
      unit: unitOf[row.center]
    })
  }
  return [...lines.values()]
    .map((line) => ({ ...line, usd: round(line.usd), quantity: Math.round(line.quantity * 1000) / 1000 }))
    .filter((line) => line.usd > 0 || line.quantity > 0)
    .sort((a, b) => b.usd - a.usd || b.quantity - a.quantity)
}

const modelsOf = (rows: ReadonlyArray<SumRow>): Array<ModelCost> => {
  const models = new Map<string, ModelCost>()
  for (const row of rows) {
    if (row.center !== "openai") continue
    const model = row.model ?? "unknown"
    const key = `${model}:${row.payer}`
    const found = models.get(key)
    models.set(key, {
      model,
      payer: row.payer,
      usd: (found?.usd ?? 0) + row.usd,
      requests: (found?.requests ?? 0) + row.n
    })
  }
  return [...models.values()]
    .map((model) => ({ ...model, usd: round(model.usd) }))
    .sort((a, b) => b.usd - a.usd || b.requests - a.requests)
}

const dreamUsd = (rows: ReadonlyArray<SumRow>) =>
  round(rows.reduce((sum, row) => (row.payer === "dream" ? sum + row.usd : sum), 0))

export const periodOf = (rows: ReadonlyArray<SumRow>, from: DateTime.Utc, to: DateTime.Utc): CostPeriod => {
  const within = rows.filter((row) => inPeriod(row, from, to))
  return { from, to, usd: dreamUsd(within), lines: linesOf(within), models: modelsOf(within) }
}

const daysOf = (rows: ReadonlyArray<SumRow>, days: ReadonlyArray<string>): Array<CostDay> => {
  const byDay = new Map<string, number>()
  for (const row of rows) if (row.payer === "dream") byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.usd)
  return days.map((day) => ({ day, usd: round(byDay.get(day) ?? 0) }))
}

const summary = (rows: ReadonlyArray<SumRow>, window: Window) => ({
  month: periodOf(rows, window.monthStart, window.monthEnd),
  lastMonth: periodOf(rows, window.lastMonthStart, window.monthStart),
  days: daysOf(rows, window.days)
})

export class CostReport extends Context.Service<
  CostReport,
  {
    readonly project: (projectId: ProjectId) => Effect.Effect<ProjectCosts>
    /** Theirs; with `everyone` when they're an operator (`DREAM_OPERATORS`). */
    readonly account: (userId: UserId) => Effect.Effect<AccountCosts>
  }
>()("@dream/api/metering/CostReport") {
  static readonly layer = Layer.effect(
    CostReport,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const config = yield* ApiConfig

      const sums = (window: Window, scope: { readonly project?: string; readonly owner?: string }) =>
        sql`
          SELECT owner, project_id, center, payer,
            CASE WHEN center = 'openai' THEN json_extract(dimensions_json, '$.model') END AS model,
            substr(at, 1, 10) AS day, SUM(cost_usd) AS usd, SUM(units) AS units, COUNT(*) AS n
          FROM meter_events
          WHERE at >= ${DateTime.formatIso(window.from)} AND at < ${DateTime.formatIso(window.monthEnd)}
            ${scope.project === undefined ? sql`` : sql`AND project_id = ${scope.project}`}
            ${scope.owner === undefined ? sql`` : sql`AND owner = ${scope.owner}`}
          GROUP BY owner, project_id, center, payer, model, day`.pipe(decodeRows(SumRow))

      const project = Effect.fn("CostReport.project")(function* (projectId: ProjectId) {
        const window = windowAt(yield* DateTime.now)
        const rows = yield* sums(window, { project: projectId })
        return { projectId, ...summary(rows, window) }
      })

      const thisMonth = (rows: ReadonlyArray<SumRow>, window: Window) =>
        rows.filter((row) => inPeriod(row, window.monthStart, window.monthEnd))

      const projectsOf = (rows: ReadonlyArray<SumRow>) =>
        Effect.gen(function* () {
          const ids = [...new Set(rows.flatMap((row) => (row.project_id === null ? [] : [row.project_id])))]
          if (ids.length === 0) return []
          const known = new Map<string, typeof ProjectRow.Type>()
          for (let i = 0; i < ids.length; i += 90) {
            const found = yield* sql`SELECT id, title, icon, archived_at FROM projects
              WHERE ${sql.in("id", ids.slice(i, i + 90))}`.pipe(decodeRows(ProjectRow))
            for (const row of found) known.set(row.id, row)
          }
          const costOf = (id: ProjectId): ProjectCost => {
            const mine = rows.filter((row) => row.project_id === id)
            const personUsd = round(mine.reduce((sum, row) => (row.payer === "person" ? sum + row.usd : sum), 0))
            const found = known.get(id)
            return {
              projectId: id,
              title: found?.title ?? "A deleted project",
              ...(found?.icon ? { icon: found.icon } : {}),
              usd: dreamUsd(mine),
              ...(personUsd > 0 ? { personUsd } : {}),
              ...(found === undefined || found.archived_at !== null ? { archived: true } : {})
            }
          }
          return ids
            .flatMap((raw): ReadonlyArray<ProjectCost> => {
              const id = Schema.decodeUnknownOption(ProjectId)(raw)
              return Option.isNone(id) ? [] : [costOf(id.value)]
            })
            .sort((a, b) => b.usd - a.usd || (b.personUsd ?? 0) - (a.personUsd ?? 0))
        })

      const isOperator = (userId: UserId) =>
        Effect.gen(function* () {
          if (config.operators.length === 0) return false
          const rows = yield* sql`SELECT id, email, name FROM users WHERE id = ${userId}`.pipe(decodeRows(UserRow))
          const email = rows[0]?.email.toLowerCase()
          return email !== undefined && config.operators.includes(email)
        })

      const everyone = (window: Window) =>
        Effect.gen(function* () {
          const rows = yield* sums(window, {})
          const month = thisMonth(rows, window)
          const owners = [...new Set(month.map((row) => row.owner).filter((owner) => owner !== OperatorOwner))]
          const users = new Map<string, typeof UserRow.Type>()
          for (let i = 0; i < owners.length; i += 90) {
            const found = yield* sql`SELECT id, email, name FROM users
              WHERE ${sql.in("id", owners.slice(i, i + 90))}`.pipe(decodeRows(UserRow))
            for (const row of found) users.set(row.id, row)
          }
          const people = owners
            .flatMap((owner): ReadonlyArray<PersonCost> => {
              const userId = Schema.decodeUnknownOption(UserId)(owner)
              if (Option.isNone(userId)) return []
              const theirs = month.filter((row) => row.owner === owner)
              const user = users.get(owner)
              return [
                {
                  userId: userId.value,
                  name: user?.name ?? user?.email ?? "Someone who left",
                  usd: dreamUsd(theirs),
                  projects: new Set(theirs.flatMap((row) => (row.project_id === null ? [] : [row.project_id]))).size
                }
              ]
            })
            .sort((a, b) => b.usd - a.usd)
          const costs: OperatorCosts = {
            ...summary(rows, window),
            people,
            overhead: linesOf(month.filter((row) => row.owner === OperatorOwner))
          }
          return costs
        })

      const account = Effect.fn("CostReport.account")(function* (userId: UserId) {
        const window = windowAt(yield* DateTime.now)
        const rows = yield* sums(window, { owner: userId })
        const month = thisMonth(rows, window)
        const costs: AccountCosts = {
          ...summary(rows, window),
          projects: yield* projectsOf(month),
          unattributed: linesOf(month.filter((row) => row.project_id === null))
        }
        if (!(yield* isOperator(userId))) return costs
        return { ...costs, everyone: yield* everyone(window) }
      })

      return CostReport.of({ project, account })
    })
  )
}
