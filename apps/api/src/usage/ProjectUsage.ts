/**
 * The usage sheet (`AppRpcs.GetProjectUsage`) and the header's figures (`ProjectEvent.Usage`): one project's tokens
 * over today, the five-hour window and the week (exact, from the turn ledger), and its estimated share of each
 * window, beside every other project's and use outside Dream (`Shares.ts`). Settings' plan card
 * (`AppRpcs.GetAccountUsage`) is the same windows and shares seen from all their projects together.
 */
import {
  type AccountUsage,
  type AccountWindow,
  type ModelProvider,
  NotFound,
  type Project,
  type ProjectId,
  type ProjectShare,
  type ProjectUsage,
  type ProjectUsageGlance,
  type UsageBilling,
  type UsagePeriod,
  type UsageSnapshot,
  type UsageWindow,
  type UsageWindowName,
  type UserId,
  type WindowShare
} from "@dream/domain"
import { Clock, Context, DateTime, Effect, Layer, Option } from "effect"
import { Connections } from "../db/Connections.ts"
import { Projects } from "../db/Projects.ts"
import { type LoggedTurn, TurnUsageLog } from "../db/TurnUsage.ts"
import { Users } from "../db/Users.ts"
import {
  attributeWindow,
  type CurrentWindow,
  currentWindow,
  roundPercent,
  totalTokens,
  type WindowAttribution,
  WindowLength,
  type WindowReading
} from "./Shares.ts"

export const providerFor = (project: Pick<Project, "harness">): ModelProvider =>
  project.harness === "codex" ? "chatgpt" : "claude"

/**
 * Every connection is a subscription today. An API-key connection would be `apiKey`: no windows, and each period's
 * `costUsd` instead of shares (Claude's reported cost; Codex's estimated from tokens at list prices).
 */
const billingFor = (_snapshot: UsageSnapshot | undefined): UsageBilling => "subscription"

const toReading = (window: UsageWindow | undefined, observedAt: DateTime.Utc): WindowReading | undefined =>
  window === undefined
    ? undefined
    : {
        usedPercent: window.usedPercent,
        resetsAtMs: window.resetsAt === undefined ? undefined : DateTime.toEpochMillis(window.resetsAt),
        observedAtMs: DateTime.toEpochMillis(observedAt)
      }

/** Midnight today in `timeZone` (UTC when it isn't a zone this runtime knows). */
export const startOfDayMs = (nowMs: number, timeZone: string): number =>
  DateTime.toEpochMillis(
    Option.match(DateTime.setZoneNamed(DateTime.makeUnsafe(nowMs), timeZone), {
      onNone: () => DateTime.startOf(DateTime.makeUnsafe(nowMs), "day"),
      onSome: (zoned) => DateTime.startOf(zoned, "day")
    })
  )

/** How far back the ledger is read: the week (or the last seven days) and today, whichever reaches further. */
export const ledgerSinceMs = (nowMs: number, timeZone: string): number =>
  Math.min(nowMs - WindowLength.weekly, startOfDayMs(nowMs, timeZone))

export interface UsageInputs {
  readonly project: Pick<Project, "id" | "harness">
  readonly snapshot: UsageSnapshot | undefined
  /** Their turns on the project's provider since `ledgerSinceMs`, every project's. */
  readonly turns: ReadonlyArray<LoggedTurn>
  readonly nowMs: number
  readonly timeZone: string
  /** Title and icon of each project in `turns`; a missing one was deleted. */
  readonly projects: ReadonlyMap<ProjectId, { readonly title: string; readonly icon?: string | undefined }>
}

interface Window {
  readonly current: CurrentWindow
  readonly attribution: WindowAttribution
}

const sum = (values: ReadonlyArray<number>): number => values.reduce((a, b) => a + b, 0)

/** One window's current instance and how it splits across their turns, when the snapshot reports it. */
const windowOf = (
  name: UsageWindowName,
  provider: ModelProvider,
  snapshot: UsageSnapshot | undefined,
  observedAt: DateTime.Utc,
  turns: ReadonlyArray<LoggedTurn>,
  nowMs: number
): Window | undefined => {
  const current = currentWindow(name, toReading(snapshot?.[name], observedAt), nowMs)
  return current === undefined
    ? undefined
    : { current, attribution: attributeWindow({ provider, window: name, turns, current }) }
}

/**
 * Each project's share of the week, largest first: every project with a turn this week or a share of it, and
 * `include` even without either. Empty when the week isn't known.
 */
const weekShares = (
  weekly: Window | undefined,
  turns: ReadonlyArray<LoggedTurn>,
  weekStartMs: number,
  described: UsageInputs["projects"],
  include: ReadonlyArray<ProjectId>
): Array<ProjectShare> => {
  if (weekly === undefined) return []
  const ids = new Set<ProjectId>([
    ...include,
    ...turns.filter((t) => t.endedMs > weekStartMs).map((t) => t.projectId),
    ...weekly.attribution.byProject.keys()
  ])
  const projects: Array<ProjectShare> = []
  for (const id of ids) {
    const project = described.get(id)
    projects.push({
      projectId: id,
      title: project?.title ?? "Deleted project",
      ...(project?.icon === undefined ? {} : { icon: project.icon }),
      sharePercent: roundPercent(weekly.attribution.byProject.get(id) ?? 0)
    })
  }
  return projects.sort((a, b) => b.sharePercent - a.sharePercent || a.title.localeCompare(b.title))
}

/** The usage sheet, from what the ledger and the latest snapshot say. Pure. */
export const buildProjectUsage = (input: UsageInputs): ProjectUsage => {
  const { project, snapshot, turns, nowMs } = input
  const provider = providerFor(project)
  const observedAt = snapshot?.observedAt ?? DateTime.makeUnsafe(nowMs)

  const fiveHour = windowOf("fiveHour", provider, snapshot, observedAt, turns, nowMs)
  const weekly = windowOf("weekly", provider, snapshot, observedAt, turns, nowMs)

  const own = turns.filter((t) => t.projectId === project.id)
  const period = (
    fromMs: number,
    window: Window | undefined,
    shareOf: (turns: ReadonlyArray<LoggedTurn>) => number
  ) => {
    const inPeriod = own.filter((t) => t.endedMs > fromMs)
    const reported = inPeriod.flatMap((t) => (t.tokens === undefined ? [] : [t.tokens]))
    const result: UsagePeriod = {
      ...(reported.length === 0
        ? {}
        : { tokens: sum(reported.map(totalTokens)), cacheReadTokens: sum(reported.map((t) => t.cacheRead)) }),
      ...(window === undefined ? {} : { sharePercent: roundPercent(shareOf(inPeriod)) })
    }
    return { result, turns: inPeriod }
  }
  const sharesOf = (window: Window | undefined) => (inPeriod: ReadonlyArray<LoggedTurn>) =>
    sum(inPeriod.map((t) => window?.attribution.byTurn.get(t.id) ?? 0))

  const weekStartMs = weekly?.current.startMs ?? nowMs - WindowLength.weekly
  const week = period(weekStartMs, weekly, sharesOf(weekly))
  const five = period(fiveHour?.current.startMs ?? nowMs - WindowLength.fiveHour, fiveHour, sharesOf(fiveHour))
  // Today is measured against the week, so only today's turns within the current week count toward its share.
  const today = period(startOfDayMs(nowMs, input.timeZone), weekly, (inPeriod) =>
    sharesOf(weekly)(inPeriod.filter((t) => t.endedMs > weekStartMs))
  )

  const windowShare = (window: Window | undefined, projectTurns: ReadonlyArray<LoggedTurn>): WindowShare | undefined =>
    window === undefined
      ? undefined
      : {
          usedPercent: roundPercent(window.current.usedPercent),
          projectPercent: roundPercent(sharesOf(window)(projectTurns)),
          ...(window.current.resetsAtMs === undefined
            ? {}
            : { resetsAt: DateTime.makeUnsafe(window.current.resetsAtMs) })
        }

  // The header shows nothing rather than a made-up 0% when the week isn't known or this project hasn't worked in it.
  const weeklyShare = week.turns.length === 0 ? undefined : windowShare(weekly, week.turns)
  const fiveHourWindow = windowShare(fiveHour, five.turns)

  const projects = weekShares(weekly, turns, weekStartMs, input.projects, [project.id])

  const subagentModes = new Set(week.turns.filter((t) => t.tokens !== undefined).map((t) => t.subagents))
  const [onlyMode] = subagentModes

  return {
    provider,
    billing: billingFor(snapshot),
    ...(weeklyShare === undefined ? {} : { weekly: weeklyShare }),
    observedAt,
    ...(snapshot?.plan === undefined ? {} : { plan: snapshot.plan }),
    today: today.result,
    fiveHour: five.result,
    week: week.result,
    ...(fiveHourWindow === undefined ? {} : { fiveHourWindow }),
    projects,
    ...(weekly === undefined ? {} : { outsideDreamPercent: roundPercent(weekly.attribution.outsideDream) }),
    ...(subagentModes.size === 1 && onlyMode !== undefined ? { subagents: onlyMode } : {})
  }
}

export interface AccountInputs {
  readonly provider: ModelProvider
  readonly snapshot: UsageSnapshot | undefined
  /** Their turns on `provider` since `ledgerSinceMs`. */
  readonly turns: ReadonlyArray<LoggedTurn>
  readonly nowMs: number
  /** Title and icon of each project in `turns`; a missing one was deleted. */
  readonly projects: UsageInputs["projects"]
}

/** Settings' plan card: the windows with every project's part together, and each project's share of the week. Pure. */
export const buildAccountUsage = (input: AccountInputs): AccountUsage => {
  const { provider, snapshot, turns, nowMs } = input
  const observedAt = snapshot?.observedAt ?? DateTime.makeUnsafe(nowMs)
  const fiveHour = windowOf("fiveHour", provider, snapshot, observedAt, turns, nowMs)
  const weekly = windowOf("weekly", provider, snapshot, observedAt, turns, nowMs)
  const accountWindow = (window: Window | undefined): AccountWindow | undefined =>
    window === undefined
      ? undefined
      : {
          usedPercent: roundPercent(window.current.usedPercent),
          dreamPercent: roundPercent(sum([...window.attribution.byProject.values()])),
          ...(window.current.resetsAtMs === undefined
            ? {}
            : { resetsAt: DateTime.makeUnsafe(window.current.resetsAtMs) })
        }
  const five = accountWindow(fiveHour)
  const week = accountWindow(weekly)
  return {
    provider,
    billing: billingFor(snapshot),
    ...(snapshot?.plan === undefined ? {} : { plan: snapshot.plan }),
    ...(five === undefined ? {} : { fiveHour: five }),
    ...(week === undefined ? {} : { weekly: week }),
    projects: weekShares(weekly, turns, weekly?.current.startMs ?? nowMs - WindowLength.weekly, input.projects, []),
    ...(weekly === undefined ? {} : { outsideDreamPercent: roundPercent(weekly.attribution.outsideDream) }),
    observedAt
  }
}

export const toGlance = (usage: ProjectUsage): ProjectUsageGlance => ({
  provider: usage.provider,
  billing: usage.billing,
  ...(usage.weekly === undefined ? {} : { weekly: usage.weekly }),
  observedAt: usage.observedAt
})

export class UsageReport extends Context.Service<
  UsageReport,
  {
    readonly projectUsage: (project: Project) => Effect.Effect<ProjectUsage>
    readonly glance: (project: Project) => Effect.Effect<ProjectUsageGlance>
    /** Fails with `NotFound` when they have no connected `provider` subscription. */
    readonly accountUsage: (userId: UserId, provider: ModelProvider) => Effect.Effect<AccountUsage, NotFound>
  }
>()("@dream/api/UsageReport") {
  static readonly layer = Layer.effect(
    UsageReport,
    Effect.gen(function* () {
      const connections = yield* Connections
      const users = yield* Users
      const projects = yield* Projects
      const log = yield* TurnUsageLog

      const timeZoneOf = (userId: UserId) =>
        Effect.map(users.find(userId), (user) =>
          Option.match(user, { onNone: () => "UTC", onSome: (u) => u.timeZone ?? "UTC" })
        )
      /** The title and icon of every project in `turns`, and of `known` without a lookup. */
      const describe = Effect.fn("UsageReport.describe")(function* (
        turns: ReadonlyArray<LoggedTurn>,
        known: ReadonlyArray<Project>
      ) {
        const described = new Map<ProjectId, { readonly title: string; readonly icon?: string | undefined }>()
        for (const id of new Set([...known.map((p) => p.id), ...turns.map((t) => t.projectId)])) {
          const own = known.find((p) => p.id === id)
          const found = own === undefined ? yield* projects.find(id) : Option.some(own)
          if (Option.isSome(found)) described.set(id, { title: found.value.title, icon: found.value.icon })
        }
        return described
      })

      const projectUsage = Effect.fn("UsageReport.projectUsage")(function* (project: Project) {
        const provider = providerFor(project)
        const nowMs = yield* Clock.currentTimeMillis
        const timeZone = yield* timeZoneOf(project.ownerId)
        const connection = yield* connections.connectedModel(project.ownerId, provider)
        const snapshot = Option.match(connection, {
          onNone: () => undefined,
          onSome: (row) => row.usage_json ?? undefined
        })
        const turns = yield* log.since(project.ownerId, provider, DateTime.makeUnsafe(ledgerSinceMs(nowMs, timeZone)))
        const described = yield* describe(turns, [project])
        return buildProjectUsage({ project, snapshot, turns, nowMs, timeZone, projects: described })
      })

      const accountUsage = Effect.fn("UsageReport.accountUsage")(function* (userId: UserId, provider: ModelProvider) {
        const connection = yield* connections.connectedModel(userId, provider)
        if (Option.isNone(connection)) return yield* new NotFound({ entity: "model connection", id: provider })
        const nowMs = yield* Clock.currentTimeMillis
        const timeZone = yield* timeZoneOf(userId)
        const turns = yield* log.since(userId, provider, DateTime.makeUnsafe(ledgerSinceMs(nowMs, timeZone)))
        return buildAccountUsage({
          provider,
          snapshot: connection.value.usage_json ?? undefined,
          turns,
          nowMs,
          projects: yield* describe(turns, [])
        })
      })

      return UsageReport.of({
        projectUsage,
        glance: (project) => Effect.map(projectUsage(project), toGlance),
        accountUsage
      })
    })
  )
}
