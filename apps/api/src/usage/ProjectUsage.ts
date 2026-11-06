/**
 * The usage sheet (`AppRpcs.GetProjectUsage`) and the header's figures (`ProjectEvent.Usage`): one project's tokens
 * over today, the five-hour window and the week (exact, from the turn ledger), and its estimated share of each
 * window, beside every other project's and use outside Dream (`Shares.ts`).
 */
import {
  type ModelProvider,
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

/** The usage sheet, from what the ledger and the latest snapshot say. Pure. */
export const buildProjectUsage = (input: UsageInputs): ProjectUsage => {
  const { project, snapshot, turns, nowMs } = input
  const provider = providerFor(project)
  const observedAt = snapshot?.observedAt ?? DateTime.makeUnsafe(nowMs)

  const window = (name: UsageWindowName): Window | undefined => {
    const current = currentWindow(name, toReading(snapshot?.[name], observedAt), nowMs)
    return current === undefined
      ? undefined
      : { current, attribution: attributeWindow({ provider, window: name, turns, current }) }
  }
  const fiveHour = window("fiveHour")
  const weekly = window("weekly")

  const own = turns.filter((t) => t.projectId === project.id)
  const period = (
    fromMs: number,
    window: Window | undefined,
    shareOf: (turns: ReadonlyArray<LoggedTurn>) => number
  ) => {
    const inPeriod = own.filter((t) => t.endedMs > fromMs)
    const reported = inPeriod.flatMap((t) => (t.tokens === undefined ? [] : [totalTokens(t.tokens)]))
    const result: UsagePeriod = {
      ...(reported.length === 0 ? {} : { tokens: sum(reported) }),
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

  const projects: Array<ProjectShare> = []
  if (weekly !== undefined) {
    const ids = new Set<ProjectId>([
      project.id,
      ...turns.filter((t) => t.endedMs > weekStartMs).map((t) => t.projectId),
      ...weekly.attribution.byProject.keys()
    ])
    for (const id of ids) {
      const described = input.projects.get(id)
      projects.push({
        projectId: id,
        title: described?.title ?? "Deleted project",
        ...(described?.icon === undefined ? {} : { icon: described.icon }),
        sharePercent: roundPercent(weekly.attribution.byProject.get(id) ?? 0)
      })
    }
    projects.sort((a, b) => b.sharePercent - a.sharePercent || a.title.localeCompare(b.title))
  }

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
  }
>()("@dream/api/UsageReport") {
  static readonly layer = Layer.effect(
    UsageReport,
    Effect.gen(function* () {
      const connections = yield* Connections
      const users = yield* Users
      const projects = yield* Projects
      const log = yield* TurnUsageLog

      const projectUsage = Effect.fn("UsageReport.projectUsage")(function* (project: Project) {
        const provider = providerFor(project)
        const nowMs = yield* Clock.currentTimeMillis
        const user = yield* users.find(project.ownerId)
        const timeZone = Option.match(user, { onNone: () => "UTC", onSome: (u) => u.timeZone ?? "UTC" })
        const connection = yield* connections.connectedModel(project.ownerId, provider)
        const snapshot = Option.match(connection, {
          onNone: () => undefined,
          onSome: (row) => row.usage_json ?? undefined
        })
        const turns = yield* log.since(project.ownerId, provider, DateTime.makeUnsafe(ledgerSinceMs(nowMs, timeZone)))
        const described = new Map<ProjectId, { readonly title: string; readonly icon?: string | undefined }>()
        for (const id of new Set([project.id, ...turns.map((t) => t.projectId)])) {
          const found = id === project.id ? Option.some(project) : yield* projects.find(id)
          if (Option.isSome(found)) described.set(id, { title: found.value.title, icon: found.value.icon })
        }
        return buildProjectUsage({ project, snapshot, turns, nowMs, timeZone, projects: described })
      })

      return UsageReport.of({
        projectUsage,
        glance: (project) => Effect.map(projectUsage(project), toGlance)
      })
    })
  )
}
