/**
 * The fixtures world's subscription use (Deck v3, project usage option A): ChatGPT Pro, a week 38% used with
 * Lift Log about 4% of it (`@dream/domain/fixtures`' `liftLogUsage`), a heavy week near the limit, and a world
 * where nothing is known yet. Each simulated turn adds a little to the project that ran it.
 */
import type {
  AccountUsage,
  Project,
  ProjectId,
  ProjectShare,
  ProjectUsage,
  ProjectUsageGlance,
  UsagePeriod,
  UsageSnapshot
} from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { DateTime } from "effect"

export type UsageMode = "normal" | "near-limit" | "none"

/** One project's part of the windows (percent) and its exact tokens. */
interface Spend {
  readonly week: number
  readonly five: number
  readonly today: number
  readonly tokens: { readonly today: number; readonly five: number; readonly week: number }
}

export interface UsageWorld {
  readonly mode: UsageMode
  readonly weekUsed: number
  readonly fiveUsed: number
  readonly outside: number
  readonly spend: ReadonlyMap<ProjectId, Spend>
}

const ids = {
  lift: Fx.liftLog.id,
  recipe: Fx.recipeScaler.id,
  cabin: Fx.cabin.id,
  brief: Fx.morningBrief.id
}

const M = 1_000_000

/** Lift Log's figures from the domain fixture, and the others scaled from it by their share of the week. */
const normal = (): UsageWorld => {
  const lift = Fx.liftLogUsage
  const share = (projectId: ProjectId) => lift.projects.find((p) => p.projectId === projectId)?.sharePercent ?? 0
  const scaled = (projectId: ProjectId): Spend => {
    const r = share(projectId) / share(ids.lift)
    return {
      week: share(projectId),
      five: Math.min(9 * r, 20),
      today: 2 * r,
      tokens: {
        today: Math.round(2.14 * M * r),
        five: Math.round(0.91 * M * Math.min(r, 2.2)),
        week: Math.round(9.62 * M * r)
      }
    }
  }
  return {
    mode: "normal",
    weekUsed: lift.weekly?.usedPercent ?? 38,
    fiveUsed: lift.fiveHourWindow?.usedPercent ?? 41,
    outside: lift.outsideDreamPercent ?? 10,
    spend: new Map(Object.values(ids).map((id) => [id, scaled(id)]))
  }
}

/** The mock's heavy week: 92% used, Lift Log about 31% of it. */
const nearLimit = (): UsageWorld => ({
  mode: "near-limit",
  weekUsed: 92,
  fiveUsed: 86,
  outside: 14,
  spend: new Map([
    [ids.recipe, { week: 40, five: 30, today: 9, tokens: { today: 9.1 * M, five: 4.6 * M, week: 40.6 * M } }],
    [ids.lift, { week: 31, five: 40, today: 14, tokens: { today: 14.2 * M, five: 6.1 * M, week: 31.5 * M } }],
    [ids.cabin, { week: 4, five: 6, today: 1, tokens: { today: 0.9 * M, five: 0.9 * M, week: 4.1 * M } }],
    [ids.brief, { week: 3, five: 0, today: 1, tokens: { today: 0.6 * M, five: 0, week: 3.0 * M } }]
  ])
})

export const makeUsageWorld = (mode: UsageMode): UsageWorld =>
  mode === "normal"
    ? normal()
    : mode === "near-limit"
      ? nearLimit()
      : { mode, weekUsed: 0, fiveUsed: 0, outside: 0, spend: new Map() }

/** A turn in `projectId` ran: a little more of both windows, and of its tokens. Nothing changes while unknown. */
export const afterTurn = (world: UsageWorld, projectId: ProjectId): UsageWorld => {
  if (world.mode === "none") return world
  const was = world.spend.get(projectId) ?? { week: 0, five: 0, today: 0, tokens: { today: 0, five: 0, week: 0 } }
  const week = Math.min(0.3, 100 - world.weekUsed)
  const five = Math.min(1, 100 - world.fiveUsed)
  const tokens = 140_000
  const spend = new Map(world.spend)
  spend.set(projectId, {
    week: was.week + week,
    five: was.five + five,
    today: was.today + week,
    tokens: { today: was.tokens.today + tokens, five: was.tokens.five + tokens, week: was.tokens.week + tokens }
  })
  return { ...world, weekUsed: world.weekUsed + week, fiveUsed: world.fiveUsed + five, spend }
}

/** The next time the phone's clock reads Monday 8:00 AM. */
const nextMonday = (now: DateTime.Utc) => {
  const local = new Date(DateTime.toEpochMillis(now))
  local.setDate(local.getDate() + ((8 - local.getDay()) % 7 || 7))
  local.setHours(8, 0, 0, 0)
  return DateTime.makeUnsafe(local.getTime())
}

/** A few hours from now, on a ten-minute mark. */
const fiveHourReset = (now: DateTime.Utc) => {
  const step = 10 * 60_000
  return DateTime.makeUnsafe(Math.ceil((DateTime.toEpochMillis(now) + 3.5 * 3_600_000) / step) * step)
}

/** Every project that used some of the week, largest share first. */
const sharesOf = (world: UsageWorld, projects: ReadonlyArray<Project>): Array<ProjectShare> =>
  projects
    .flatMap((project) => {
      const spend = world.spend.get(project.id)
      return spend && spend.week > 0
        ? [
            {
              projectId: project.id,
              title: project.title,
              ...(project.icon ? { icon: project.icon } : {}),
              sharePercent: spend.week
            }
          ]
        : []
    })
    .sort((a, b) => b.sharePercent - a.sharePercent)

const sum = (values: Iterable<number>) => [...values].reduce((a, b) => a + b, 0)

/** Settings' plan card (`GetAccountUsage`): the same windows, every project's part together. */
export const accountOf = (world: UsageWorld, projects: ReadonlyArray<Project>, now: DateTime.Utc): AccountUsage => {
  const spends = [...world.spend.values()]
  const known = world.mode !== "none"
  return {
    provider: "chatgpt",
    billing: "subscription",
    plan: "ChatGPT Pro",
    ...(known
      ? {
          fiveHour: {
            usedPercent: world.fiveUsed,
            dreamPercent: Math.min(world.fiveUsed, sum(spends.map((s) => s.five))),
            resetsAt: fiveHourReset(now)
          },
          weekly: {
            usedPercent: world.weekUsed,
            dreamPercent: Math.min(world.weekUsed, sum(spends.map((s) => s.week))),
            resetsAt: nextMonday(now)
          },
          outsideDreamPercent: world.outside
        }
      : {}),
    projects: known ? sharesOf(world, projects) : [],
    observedAt: now
  }
}

/** The connection's own usage, kept in step with the world so Home's hint and Settings agree with the sheet. */
export const connectionUsageOf = (world: UsageWorld, base: UsageSnapshot, now: DateTime.Utc): UsageSnapshot =>
  world.mode === "none"
    ? base
    : {
        ...base,
        fiveHour: { usedPercent: world.fiveUsed, resetsAt: fiveHourReset(now) },
        weekly: { usedPercent: world.weekUsed, resetsAt: nextMonday(now) },
        observedAt: now
      }

/** The usage sheet for one project (`GetProjectUsage`). */
export const usageOf = (
  world: UsageWorld,
  projectId: ProjectId,
  projects: ReadonlyArray<Project>,
  now: DateTime.Utc
): ProjectUsage => {
  const own = world.spend.get(projectId)
  const period = (tokens: number | undefined, share: number | undefined): UsagePeriod => ({
    ...(tokens === undefined ? {} : { tokens: Math.round(tokens) }),
    // Cache reads run about 8.6 times the rest, as in the domain fixture.
    ...(tokens ? { cacheReadTokens: Math.round(tokens * 8.6) } : {}),
    ...(share === undefined ? {} : { sharePercent: share })
  })
  const known = world.mode !== "none"
  const shares = sharesOf(world, projects)
  return {
    provider: "chatgpt",
    billing: "subscription",
    plan: "ChatGPT Pro",
    ...(known && own
      ? { weekly: { usedPercent: world.weekUsed, projectPercent: own.week, resetsAt: nextMonday(now) } }
      : {}),
    ...(known
      ? {
          fiveHourWindow: { usedPercent: world.fiveUsed, projectPercent: own?.five ?? 0, resetsAt: fiveHourReset(now) }
        }
      : {}),
    today: period(own?.tokens.today, known && own ? own.today : undefined),
    fiveHour: period(own?.tokens.five, known && own ? own.five : undefined),
    week: period(own?.tokens.week, known && own ? own.week : undefined),
    projects: known ? shares : [],
    ...(known ? { outsideDreamPercent: world.outside } : {}),
    subagents: "included",
    observedAt: now
  }
}

/** The header's part of it, for `ProjectEvent.Usage`. */
export const glanceOf = (usage: ProjectUsage): ProjectUsageGlance => ({
  provider: usage.provider,
  billing: usage.billing,
  ...(usage.weekly ? { weekly: usage.weekly } : {}),
  observedAt: usage.observedAt
})
