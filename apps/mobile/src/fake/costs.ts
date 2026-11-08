/**
 * The fixtures world's costs (docs/metering.md): what Dream paid this month and last to run the sample projects,
 * at the price book's list prices (a standard sandbox is about $0.17 an hour, a cloud browser $0.002 a minute, a
 * Mac $0.06 a minute). `own-key` is a world where they connected an OpenAI key, so every OpenAI call is theirs;
 * `operator` adds everyone's costs; `none` is before anything cost anything.
 */
import type {
  AccountCosts,
  CostCenter,
  CostDay,
  CostLine,
  CostPeriod,
  CostUnit,
  ModelCost,
  OperatorCosts,
  ProjectCost,
  ProjectCosts,
  ProjectId,
  UserId
} from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { DateTime } from "effect"

export type CostsMode = "normal" | "own-key" | "operator" | "none"

interface Use {
  readonly center: CostCenter
  readonly usd: number
  readonly quantity: number
  readonly unit: CostUnit
}

interface Bill {
  readonly title: string
  readonly icon?: string
  readonly archived?: boolean
  readonly uses: ReadonlyArray<Use>
  readonly models: ReadonlyArray<Omit<ModelCost, "payer">>
  readonly lastMonth: number
}

const hour = 0.1656
const sandbox = (hours: number): Use => ({ center: "sandbox", usd: hours * hour, quantity: hours, unit: "hour" })
const browser = (minutes: number): Use => ({
  center: "browser",
  usd: minutes * 0.002,
  quantity: minutes,
  unit: "minute"
})
const mac = (minutes: number): Use => ({ center: "mac", usd: minutes * 0.06, quantity: minutes, unit: "minute" })
const storage = (gbMonths: number): Use => ({
  center: "storage",
  usd: gbMonths * 0.015,
  quantity: gbMonths,
  unit: "gbMonth"
})
const email = (messages: number): Use => ({
  center: "email",
  usd: messages * 0.0003,
  quantity: messages,
  unit: "message"
})
const openai = (models: ReadonlyArray<Omit<ModelCost, "payer">>): Use => ({
  center: "openai",
  usd: models.reduce((n, m) => n + m.usd, 0),
  quantity: models.reduce((n, m) => n + m.requests, 0),
  unit: "request"
})

const liftModels = [
  { model: "gpt-realtime-2.1-mini", usd: 0.71, requests: 96 },
  { model: "gpt-6.1-terra", usd: 0.22, requests: 316 }
]
const briefModels = [
  { model: "gpt-4o-mini-tts", usd: 0.19, requests: 31 },
  { model: "gpt-6-luna", usd: 0.04, requests: 186 }
]
const recipeModels = [
  { model: "gpt-image-2", usd: 2.94, requests: 84 },
  { model: "text-embedding-3-small", usd: 0.01, requests: 412 }
]

/** This month so far, per project. */
const bills: ReadonlyMap<ProjectId, Bill> = new Map<ProjectId, Bill>([
  [
    Fx.liftLog.id,
    {
      title: Fx.liftLog.title,
      ...(Fx.liftLog.icon ? { icon: Fx.liftLog.icon } : {}),
      uses: [sandbox(41), mac(38), openai(liftModels), storage(0.4)],
      models: liftModels,
      lastMonth: 7.42
    }
  ],
  [
    Fx.recipeScaler.id,
    {
      title: Fx.recipeScaler.title,
      ...(Fx.recipeScaler.icon ? { icon: Fx.recipeScaler.icon } : {}),
      uses: [sandbox(22), openai(recipeModels), storage(1.2)],
      models: recipeModels,
      lastMonth: 4.1
    }
  ],
  [
    Fx.cabin.id,
    {
      title: Fx.cabin.title,
      ...(Fx.cabin.icon ? { icon: Fx.cabin.icon } : {}),
      uses: [sandbox(14), browser(18)],
      models: [],
      lastMonth: 0
    }
  ],
  [
    Fx.morningBrief.id,
    {
      title: Fx.morningBrief.title,
      ...(Fx.morningBrief.icon ? { icon: Fx.morningBrief.icon } : {}),
      uses: [sandbox(9.5), browser(52), openai(briefModels), email(31)],
      models: briefModels,
      lastMonth: 2.64
    }
  ],
  [
    "prj_gone1" as ProjectId,
    { title: "Deleted project", archived: true, uses: [sandbox(3.1)], models: [], lastMonth: 1.2 }
  ]
])

/** Their plan's sign-in sandbox, which belongs to no project. */
const unattributed = [sandbox(0.2)]

const payerOf = (mode: CostsMode, center: CostCenter) =>
  mode === "own-key" && center === "openai" ? ("person" as const) : ("dream" as const)

const monthStart = (now: DateTime.Utc, back = 0) => {
  const d = DateTime.toDateUtc(now)
  return DateTime.makeUnsafe(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1))
}

const period = (
  from: DateTime.Utc,
  to: DateTime.Utc,
  lines: ReadonlyArray<CostLine>,
  models: ReadonlyArray<ModelCost>
) =>
  ({
    from,
    to,
    usd: lines.filter((l) => l.payer === "dream").reduce((n, l) => n + l.usd, 0),
    lines: [...lines].sort((a, b) => b.usd - a.usd),
    models: [...models].sort((a, b) => b.usd - a.usd)
  }) satisfies CostPeriod

/** Lines for some uses, the same center and payer summed. */
const linesOf = (mode: CostsMode, uses: ReadonlyArray<Use>): ReadonlyArray<CostLine> => {
  const byKey = new Map<string, CostLine>()
  for (const use of uses) {
    const payer = payerOf(mode, use.center)
    const key = `${use.center}:${payer}`
    const held = byKey.get(key)
    byKey.set(key, {
      center: use.center,
      payer,
      unit: use.unit,
      usd: (held?.usd ?? 0) + use.usd,
      quantity: (held?.quantity ?? 0) + use.quantity
    })
  }
  return Array.from(byKey.values())
}

const modelsOf = (mode: CostsMode, models: ReadonlyArray<Omit<ModelCost, "payer">>): ReadonlyArray<ModelCost> => {
  const byKey = new Map<string, ModelCost>()
  for (const m of models) {
    const payer = payerOf(mode, "openai")
    const held = byKey.get(m.model)
    byKey.set(m.model, { ...m, payer, usd: (held?.usd ?? 0) + m.usd, requests: (held?.requests ?? 0) + m.requests })
  }
  return Array.from(byKey.values())
}

/** Last month, one sandbox line for the whole of it (enough for "$7.42 in October"). */
const lastMonthOf = (now: DateTime.Utc, usd: number) =>
  period(
    monthStart(now, 1),
    monthStart(now),
    usd > 0 ? [{ center: "sandbox", payer: "dream", usd, quantity: usd / hour, unit: "hour" }] : [],
    []
  )

/**
 * The last 30 UTC days, oldest first: this month's days add up to `month`, last month's run at its daily average,
 * each varied a little so the bars look like days.
 */
const daysOf = (now: DateTime.Utc, month: number, lastMonth: number): ReadonlyArray<CostDay> => {
  const today = DateTime.toDateUtc(now)
  const days = Array.from({ length: 30 }, (_, i) => new Date(today.getTime() - (29 - i) * 86_400_000))
  const weight = (i: number) => 1 + 0.45 * Math.sin(i * 1.7) + 0.25 * Math.cos(i * 0.6)
  const inMonth = (d: Date) => d.getUTCMonth() === today.getUTCMonth()
  const monthWeight = days.reduce((n, d, i) => (inMonth(d) ? n + weight(i) : n), 0)
  const lastDays = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)).getUTCDate()
  return days.map((d, i) => ({
    day: d.toISOString().slice(0, 10),
    usd: inMonth(d) ? (month * weight(i)) / monthWeight : (lastMonth / lastDays) * weight(i)
  }))
}

const emptyPeriod = (now: DateTime.Utc) => period(monthStart(now), monthStart(now, -1), [], [])

export const projectCostsOf = (mode: CostsMode, projectId: ProjectId, now: DateTime.Utc): ProjectCosts => {
  const bill = mode === "none" ? undefined : bills.get(projectId)
  if (!bill) return { projectId, month: emptyPeriod(now), lastMonth: lastMonthOf(now, 0), days: daysOf(now, 0, 0) }
  const month = period(monthStart(now), monthStart(now, -1), linesOf(mode, bill.uses), modelsOf(mode, bill.models))
  return { projectId, month, lastMonth: lastMonthOf(now, bill.lastMonth), days: daysOf(now, month.usd, bill.lastMonth) }
}

/** Others on the same deployment, for the operator's view. */
const others = [
  { userId: "usr_maya" as UserId, name: "Maya Okafor", usd: 41.2, projects: 5 },
  { userId: "usr_sam" as UserId, name: "Sam Ortiz", usd: 6.1, projects: 1 }
]
/** Template builds, checks and refresh donors: no one's. */
const overhead = [sandbox(71), browser(25)]

const everyoneOf = (mode: CostsMode, now: DateTime.Utc, mine: CostPeriod, myLast: number): OperatorCosts => {
  const othersUses = [
    sandbox(212),
    mac(122),
    browser(215),
    openai([{ model: "gpt-6.1-terra", usd: 5.4, requests: 1840 }])
  ]
  const month = period(
    monthStart(now),
    monthStart(now, -1),
    linesOf(mode, [...Array.from(bills.values()).flatMap((b) => b.uses), ...unattributed, ...othersUses, ...overhead]),
    modelsOf(mode, [
      ...Array.from(bills.values()).flatMap((b) => b.models),
      { model: "gpt-6.1-terra", usd: 5.4, requests: 1840 }
    ])
  )
  const lastMonth = myLast + 38.6 + 9.3
  return {
    month,
    lastMonth: lastMonthOf(now, lastMonth),
    days: daysOf(now, month.usd, lastMonth),
    people: [{ userId: Fx.user.id, name: Fx.user.name ?? "You", usd: mine.usd, projects: 4 }, ...others].sort(
      (a, b) => b.usd - a.usd
    ),
    overhead: linesOf(mode, overhead)
  }
}

export const accountCostsOf = (
  mode: CostsMode,
  titles: ReadonlyMap<ProjectId, { readonly title: string; readonly icon?: string; readonly archived: boolean }>,
  now: DateTime.Utc
): AccountCosts => {
  if (mode === "none")
    return {
      month: emptyPeriod(now),
      lastMonth: lastMonthOf(now, 0),
      days: daysOf(now, 0, 0),
      projects: [],
      unattributed: []
    }
  const entries = Array.from(bills.entries())
  const uses = [...entries.flatMap(([, b]) => b.uses), ...unattributed]
  const month = period(
    monthStart(now),
    monthStart(now, -1),
    linesOf(mode, uses),
    modelsOf(
      mode,
      entries.flatMap(([, b]) => b.models)
    )
  )
  const lastMonth = entries.reduce((n, [, b]) => n + b.lastMonth, 0)
  const projects: Array<ProjectCost> = entries.map(([projectId, bill]) => {
    const lines = linesOf(mode, bill.uses)
    const known = titles.get(projectId)
    const personUsd = lines.filter((l) => l.payer === "person").reduce((n, l) => n + l.usd, 0)
    const icon = known?.icon ?? bill.icon
    return {
      projectId,
      title: known?.title ?? bill.title,
      ...(icon ? { icon } : {}),
      usd: lines.filter((l) => l.payer === "dream").reduce((n, l) => n + l.usd, 0),
      ...(personUsd > 0 ? { personUsd } : {}),
      ...((known?.archived ?? bill.archived) ? { archived: true } : {})
    }
  })
  return {
    month,
    lastMonth: lastMonthOf(now, lastMonth),
    days: daysOf(now, month.usd, lastMonth),
    projects: projects.sort((a, b) => b.usd - a.usd),
    unattributed: linesOf(mode, unattributed),
    ...(mode === "operator" ? { everyone: everyoneOf(mode, now, month, lastMonth) } : {})
  }
}
