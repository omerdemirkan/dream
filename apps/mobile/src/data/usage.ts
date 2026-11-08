/**
 * How a project's use of the subscription reads on screen: the ring in the project header (Deck v3, project usage
 * option A) and the usage sheet it opens. Pure, so it's tested in Node. Shares are estimates.
 */
import type {
  AccountUsage,
  ModelConnection,
  ModelProvider,
  ProjectShare,
  ProjectUsage,
  ProjectUsageGlance,
  UsageLimitReached,
  UsageLimits,
  UsageSnapshot,
  WindowShare
} from "@dream/domain"
import { DateTime } from "effect"
import { providerName, resetLabel, usageDetail } from "./format.ts"

/** From this much of the week used, the ring turns amber and says what's left. */
export const nearLimitPercent = 85

/** The newer of the glance held and one that just arrived, by when each was observed; a tie goes to the arrival. */
export const latestGlance = (
  held: ProjectUsageGlance | undefined,
  arrived: ProjectUsageGlance | undefined
): ProjectUsageGlance | undefined => {
  if (!held) return arrived
  if (!arrived) return held
  return DateTime.isLessThan(arrived.observedAt, held.observedAt) ? held : arrived
}

/** A share as a label: "4%", and "<1%" for a share too small to round to one. */
export const percentLabel = (percent: number) => (percent < 0.5 ? "<1%" : `${Math.round(percent)}%`)

/** One ring's arcs, as fractions of the circle: this project's, then everything else's; the rest is the track. */
export interface RingArcs {
  readonly project: number
  readonly others: number
}

/**
 * A window drawn as a ring. This project's arc is at least `minProject` of the circle, so a typical 2–5% isn't an
 * invisible sliver; the labels stay truthful. Everything else follows it, shortened if the two would overrun.
 */
export const ringArcs = (window: WindowShare, minProject: number): RingArcs => {
  const used = clamp(window.usedPercent / 100)
  const share = clamp(Math.min(window.projectPercent, window.usedPercent) / 100)
  const project = Math.max(share, minProject)
  return { project, others: Math.max(0, Math.min(used - share, 1 - project)) }
}

/**
 * The header's ring: absent when the week isn't known or this project hasn't used any of it (never a fake 0%), unless
 * a limit they set holds it, when it says so.
 */
export interface UsageBadge {
  readonly arcs: RingArcs
  readonly nearLimit: boolean
  /** "4%" (this project's share), or near the limit "8% left" (the whole week's). */
  readonly value: string
  readonly caption: "of week" | "paused"
  /** What VoiceOver reads. */
  readonly accessibilityLabel: string
}

export const usageBadge = (
  glance: ProjectUsageGlance | undefined,
  pausedBy?: UsageLimitReached | undefined
): UsageBadge | undefined => {
  const week = glance?.weekly
  if (pausedBy) {
    return {
      arcs: week ? ringArcs(week, 0.08) : { project: 0, others: 0 },
      nearLimit: true,
      value: week ? percentLabel(week.projectPercent) : "—",
      caption: "paused",
      accessibilityLabel: "Usage: paused at a limit you set"
    }
  }
  if (!week) return undefined
  const nearLimit = week.usedPercent >= nearLimitPercent
  const left = leftPercent(week)
  const share = percentLabel(week.projectPercent)
  return {
    arcs: ringArcs(week, 0.08),
    nearLimit,
    value: nearLimit ? `${left}% left` : share,
    caption: "of week",
    accessibilityLabel: nearLimit
      ? `Usage: ${left}% of this week left; this project used about ${share}`
      : `Usage: this project used about ${share} of this week`
  }
}

/** What's left of a window, in whole percent, from the rounded used figure so the parts add up to 100. */
const leftPercent = (window: WindowShare) => 100 - Math.round(window.usedPercent)

// ---------------------------------------------------------------------------
// Pieces the project sheet and Settings' plan card share
// ---------------------------------------------------------------------------

/**
 * One window as a bar: what they're looking at (this project in its sheet, all their projects in Settings) in
 * white, everything else in grey, the rest the track.
 */
export interface WindowBarView {
  /** "5 hours", "Week" */
  readonly label: string
  /** "41% used" */
  readonly used: string
  /** "resets 11:40 PM" */
  readonly resets?: string
  /** Bar widths, 0–1: the part in focus, then everything else's. */
  readonly focus: number
  readonly others: number
  readonly nearLimit: boolean
}

/** One project's share of the week, or use outside Dream's. */
export interface ShareRowView {
  readonly key: string
  readonly title: string
  readonly icon?: string
  readonly share: string
  /** Bar width, 0–1, against the largest share listed. */
  readonly bar: number
  /** The project whose sheet this is: drawn in white. */
  readonly current: boolean
  readonly outside: boolean
}

const windowBar = (
  label: string,
  usedPercent: number,
  focusPercent: number,
  resetsAt: DateTime.Utc | undefined,
  now: DateTime.Utc,
  timeZone: string | undefined
): WindowBarView => {
  const used = clamp(usedPercent / 100)
  const focus = clamp(Math.min(focusPercent, usedPercent) / 100)
  return {
    label,
    used: `${Math.round(usedPercent)}% used`,
    ...(resetsAt ? { resets: `resets ${resetLabel(resetsAt, now, timeZone)}` } : {}),
    focus,
    others: used - focus,
    nearLimit: usedPercent >= nearLimitPercent
  }
}

/** Every project's share, largest first as given, then Outside Dream's; bars against the largest. */
const shareRows = (
  projects: ReadonlyArray<ProjectShare>,
  outsideDreamPercent: number | undefined,
  currentId: string | undefined
): ReadonlyArray<ShareRowView> => {
  const largest = Math.max(0, ...projects.map((p) => p.sharePercent), outsideDreamPercent ?? 0)
  const bar = (percent: number) => (largest > 0 ? percent / largest : 0)
  return [
    ...projects.map((p) => ({
      key: p.projectId,
      title: p.title,
      ...(p.icon ? { icon: p.icon } : {}),
      share: percentLabel(p.sharePercent),
      bar: bar(p.sharePercent),
      current: p.projectId === currentId,
      outside: false
    })),
    ...(outsideDreamPercent !== undefined
      ? [
          {
            key: "outside",
            title: "Outside Dream",
            share: percentLabel(outsideDreamPercent),
            bar: bar(outsideDreamPercent),
            current: false,
            outside: true
          }
        ]
      : [])
  ]
}

/** Near the limit: what's left and until when, the same words in the sheet and in Settings. */
const limitCallout = (
  usedPercent: number,
  resetsAt: DateTime.Utc | undefined,
  now: DateTime.Utc,
  timeZone?: string
) => ({
  left: `${100 - Math.round(usedPercent)}% of your week is left`,
  rest: `${resetsAt ? `, until ${resetLabel(resetsAt, now, timeZone)}` : ""}. If it runs out, your projects pause and pick up on their own when it resets.`
})

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

/**
 * The usage sheet, kept to what matters at a glance: how much of the week this project used, how much of the plan
 * is left and when it resets, and the two limits they can set. Token counts, other projects and how shares are
 * estimated stay out of it (Settings' plan card has the projects).
 */
export interface UsageSheet {
  /** "Lift Log · ChatGPT Pro" */
  readonly subtitle: string
  /** The week as a ring, absent when the week isn't known. */
  readonly hero?: {
    readonly arcs: RingArcs
    readonly nearLimit: boolean
    /** This project's share: "31%". */
    readonly share: string
    /** What's left of the plan this week: "8%". */
    readonly left: string
    /** "Resets Mon 8:00 AM" */
    readonly resets?: string
  }
  /** Paused by a limit they set, or near the end of the week: in amber. */
  readonly callout?: { readonly left: string; readonly rest: string }
  readonly limits: LimitsView
}

/** The two limits, each as its field shows it, and a quiet line on where the project stands against it. */
export interface LimitsView {
  readonly project: LimitRow
  readonly planLeft: LimitRow
}

export interface LimitRow {
  /** The limit, or undefined when it isn't set. */
  readonly value: number | undefined
  /** "About 21% used so far", "38% left now"; absent when the week isn't known. */
  readonly note?: string
  /** This is the limit holding the project. */
  readonly reached: boolean
}

const planName = (provider: ModelProvider, plan: string | undefined) =>
  plan ?? (provider === "chatgpt" ? "ChatGPT plan" : "Claude plan")

/** Why a limit they set paused the project, in the sheet's callout. */
const pausedCallout = (
  reached: UsageLimitReached,
  resetsAt: DateTime.Utc | undefined,
  now: DateTime.Utc,
  timeZone?: string
) => ({
  left:
    reached.limit === "project"
      ? `Paused at the ${reached.percent}% you gave it`
      : `Paused to keep ${reached.percent}% of your week free`,
  rest: `. It picks up when you ${reached.limit === "project" ? "raise" : "lower"} or clear the limit${
    resetsAt ? `, or when your week resets ${resetLabel(resetsAt, now, timeZone)}` : ""
  }.`
})

export const usageSheet = (
  usage: ProjectUsage,
  projectTitle: string,
  now: DateTime.Utc,
  timeZone?: string
): UsageSheet => {
  const plan = planName(usage.provider, usage.plan)
  // `weekWindow` is there whether or not this project worked this week; APIs from before it send `weekly` alone.
  const week = usage.weekWindow ?? usage.weekly
  const nearLimit = week !== undefined && week.usedPercent >= nearLimitPercent
  const reached = usage.limitReached
  const limits = usage.limits ?? {}
  const left = week === undefined ? undefined : leftPercent(week)
  return {
    subtitle: `${projectTitle} · ${usage.billing === "apiKey" ? "API key" : plan}`,
    ...(week
      ? {
          hero: {
            arcs: ringArcs(week, 0.03),
            nearLimit: nearLimit || reached !== undefined,
            share: percentLabel(week.projectPercent),
            left: `${left}%`,
            ...(week.resetsAt ? { resets: `Resets ${resetLabel(week.resetsAt, now, timeZone)}` } : {})
          }
        }
      : {}),
    ...(reached
      ? { callout: pausedCallout(reached, week?.resetsAt, now, timeZone) }
      : week && nearLimit
        ? { callout: limitCallout(week.usedPercent, week.resetsAt, now, timeZone) }
        : {}),
    limits: {
      project: {
        value: limits.projectWeekPercent,
        ...(week && limits.projectWeekPercent !== undefined
          ? { note: `About ${percentLabel(week.projectPercent)} used so far` }
          : {}),
        reached: reached?.limit === "project"
      },
      planLeft: {
        value: limits.planLeftPercent,
        ...(week && limits.planLeftPercent !== undefined ? { note: `${left}% left now` } : {}),
        reached: reached?.limit === "planLeft"
      }
    }
  }
}

/** A limit as typed: whole percents 1–99, and anything else (empty, 0) clears it. */
export const parseLimit = (text: string): number | undefined => {
  const digits = text.replace(/[^0-9]/g, "")
  if (digits === "") return undefined
  const value = Number.parseInt(digits, 10)
  return value < 1 ? undefined : Math.min(99, value)
}

/** The limits with one changed. */
export const withLimit = (
  limits: UsageLimits,
  which: "project" | "planLeft",
  value: number | undefined
): UsageLimits => {
  const key = which === "project" ? "projectWeekPercent" : "planLeftPercent"
  const { [key]: _, ...rest } = limits
  return value === undefined ? rest : { ...rest, [key]: value }
}

const clamp = (fraction: number) => Math.min(1, Math.max(0, fraction))

// ---------------------------------------------------------------------------
// Settings' plan card (Deck v3, usage in Settings option B)
// ---------------------------------------------------------------------------

export interface PlanCard {
  /** "ChatGPT Pro" */
  readonly title: string
  /** "62% of this week left", "paused until 3:40 PM", or "Connected" while nothing is known. */
  readonly detail: string
  /** The week is nearly used up (or a limit is hit): amber border, callout and bars. */
  readonly nearLimit: boolean
  readonly callout?: { readonly left: string; readonly rest: string }
  /** The five hours and the week, all their projects together in white. */
  readonly windows: ReadonlyArray<WindowBarView>
  /** Every project's share of the week; empty when the API can't say (it predates `GetAccountUsage`). */
  readonly projects: ReadonlyArray<ShareRowView>
  /** Shown with the shares, which it explains. */
  readonly footnote?: string
}

/** Whether a subscription's week is nearly used up, or one of its limits is hit. */
export const snapshotNearLimit = (usage: UsageSnapshot | undefined) =>
  usage !== undefined &&
  (usage.limitedUntil !== undefined || (usage.weekly !== undefined && usage.weekly.usedPercent >= nearLimitPercent))

/** The amber dot on Home's profile button: shown only when a connected subscription is near its limit. */
export const profileHint = (connections: ReadonlyArray<ModelConnection>) =>
  connections.some((c) => c.status === "connected" && snapshotNearLimit(c.usage))

/**
 * A connected subscription in Settings. `account` (`GetAccountUsage`) is newer than the connection's own usage
 * and splits each window between their projects and the rest; without it, the windows come from the connection,
 * drawn all grey because nothing says how much of them was Dream's, and there are no project shares.
 */
export const planCard = (
  connection: ModelConnection,
  account: AccountUsage | undefined,
  now: DateTime.Utc,
  timeZone?: string
): PlanCard => {
  const usage = connection.usage
  const title = usage?.plan ?? account?.plan ?? providerName(connection.provider)
  const week = account?.weekly ?? usage?.weekly
  const nearLimit = usage?.limitedUntil !== undefined || (week !== undefined && week.usedPercent >= nearLimitPercent)
  const bar = (label: string, name: "fiveHour" | "weekly") => {
    const split = account?.[name]
    if (split) return [windowBar(label, split.usedPercent, split.dreamPercent, split.resetsAt, now, timeZone)]
    const whole = usage?.[name]
    return whole ? [windowBar(label, whole.usedPercent, 0, whole.resetsAt, now, timeZone)] : []
  }
  const projects = account ? shareRows(account.projects, account.outsideDreamPercent, undefined) : []
  const detail =
    usage?.limitedUntil === undefined && account?.weekly
      ? `${100 - Math.round(account.weekly.usedPercent)}% of this week left`
      : ((usage ? usageDetail(usage, timeZone) : undefined) ?? "Connected")
  return {
    title,
    detail,
    nearLimit,
    ...(nearLimit && week ? { callout: limitCallout(week.usedPercent, week.resetsAt, now, timeZone) } : {}),
    windows: [...bar("5 hours", "fiveHour"), ...bar("Week", "weekly")],
    projects,
    ...(projects.length > 0
      ? {
          footnote: `Shares (≈) are estimated from how your plan moved while each project worked. Outside Dream is the rest: ${providerName(connection.provider)} used anywhere else.`
        }
      : {})
  }
}
