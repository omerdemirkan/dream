/**
 * How a project's use of the subscription reads on screen: the ring in the project header (Deck v3, project usage
 * option A) and the usage sheet it opens. Pure, so it's tested in Node. Tokens are exact; shares are estimates.
 */
import type { ModelProvider, ProjectUsage, ProjectUsageGlance, UsagePeriod, WindowShare } from "@dream/domain"
import { DateTime } from "effect"
import { resetLabel } from "./format.ts"

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

/** Exact token counts, short: "640", "45K", "0.9M", "2.1M", "142M". */
export const tokensLabel = (tokens: number) => {
  if (tokens < 1_000) return `${tokens}`
  if (tokens < 100_000) return `${Math.round(tokens / 1_000)}K`
  if (tokens < 100_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  return `${Math.round(tokens / 1_000_000)}M`
}

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

/** The header's ring: absent when the week isn't known or this project hasn't used any of it (never a fake 0%). */
export interface UsageBadge {
  readonly arcs: RingArcs
  readonly nearLimit: boolean
  /** "4%" (this project's share), or near the limit "8% left" (the whole week's). */
  readonly value: string
  readonly caption: "of week"
  /** What VoiceOver reads. */
  readonly accessibilityLabel: string
}

export const usageBadge = (glance: ProjectUsageGlance | undefined): UsageBadge | undefined => {
  const week = glance?.weekly
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
// The sheet
// ---------------------------------------------------------------------------

export interface UsageSheet {
  /** "Lift Log · ChatGPT Pro" */
  readonly subtitle: string
  /** The week as the hero ring with its legend; absent when the week isn't known. */
  readonly hero?: {
    readonly arcs: RingArcs
    readonly nearLimit: boolean
    readonly share: string
    readonly legend: { readonly project: string; readonly others: string; readonly left: string }
  }
  /** Near the limit: what's left and until when. */
  readonly callout?: { readonly left: string; readonly rest: string }
  readonly periods: ReadonlyArray<{ readonly label: string; readonly value: string; readonly detail?: string }>
  /** "Your ChatGPT Pro", over each window known. */
  readonly windowsTitle: string
  readonly windows: ReadonlyArray<{
    readonly label: string
    readonly used: string
    readonly resets?: string
    /** Bar widths, 0–1: this project's part, then everything else's. */
    readonly project: number
    readonly others: number
    readonly nearLimit: boolean
  }>
  readonly projects: ReadonlyArray<{
    readonly key: string
    readonly title: string
    readonly icon?: string
    readonly share: string
    /** Bar width, 0–1, against the largest share listed. */
    readonly bar: number
    readonly current: boolean
    readonly outside: boolean
  }>
  readonly footnote: string
}

const planName = (provider: ModelProvider, plan: string | undefined) =>
  plan ?? (provider === "chatgpt" ? "ChatGPT plan" : "Claude plan")

const period = (label: string, p: UsagePeriod, of: string) => ({
  label,
  value: p.tokens === undefined ? "—" : tokensLabel(p.tokens),
  ...(p.sharePercent !== undefined
    ? { detail: `≈${percentLabel(p.sharePercent)} of ${of}` }
    : p.costUsd !== undefined
      ? { detail: `$${p.costUsd.toFixed(2)}` }
      : {})
})

export const usageSheet = (
  usage: ProjectUsage,
  projectTitle: string,
  projectId: string,
  now: DateTime.Utc,
  timeZone?: string
): UsageSheet => {
  const plan = planName(usage.provider, usage.plan)
  const week = usage.weekly
  const nearLimit = week !== undefined && week.usedPercent >= nearLimitPercent
  const window = (label: string, w: WindowShare | undefined) => {
    if (!w) return []
    const used = clamp(w.usedPercent / 100)
    const project = clamp(Math.min(w.projectPercent, w.usedPercent) / 100)
    return [
      {
        label,
        used: `${Math.round(w.usedPercent)}% used`,
        ...(w.resetsAt ? { resets: `resets ${resetLabel(w.resetsAt, now, timeZone)}` } : {}),
        project,
        others: used - project,
        nearLimit: w.usedPercent >= nearLimitPercent
      }
    ]
  }
  const largest = Math.max(0, ...usage.projects.map((p) => p.sharePercent), usage.outsideDreamPercent ?? 0)
  const bar = (percent: number) => (largest > 0 ? percent / largest : 0)
  return {
    subtitle: `${projectTitle} · ${usage.billing === "apiKey" ? "API key" : plan}`,
    ...(week
      ? {
          hero: {
            arcs: ringArcs(week, 0.03),
            nearLimit,
            share: percentLabel(week.projectPercent),
            legend: legend(week)
          }
        }
      : {}),
    ...(week && nearLimit
      ? {
          callout: {
            left: `${leftPercent(week)}% of your week is left`,
            rest: `${week.resetsAt ? `, until ${resetLabel(week.resetsAt, now, timeZone)}` : ""}. If it runs out, your projects pause and pick up on their own when it resets.`
          }
        }
      : {}),
    periods: [
      period("Today", usage.today, "week"),
      period("This 5 hours", usage.fiveHour, "5 hours"),
      period("This week", usage.week, "week")
    ],
    windowsTitle: `Your ${plan}`,
    windows: [...window("5 hours", usage.fiveHourWindow), ...window("Week", week)],
    projects: [
      ...usage.projects.map((p) => ({
        key: p.projectId,
        title: p.title,
        ...(p.icon ? { icon: p.icon } : {}),
        share: percentLabel(p.sharePercent),
        bar: bar(p.sharePercent),
        current: p.projectId === projectId,
        outside: false
      })),
      ...(usage.outsideDreamPercent !== undefined
        ? [
            {
              key: "outside",
              title: "Outside Dream",
              share: percentLabel(usage.outsideDreamPercent),
              bar: bar(usage.outsideDreamPercent),
              current: false,
              outside: true
            }
          ]
        : [])
    ],
    footnote:
      usage.subagents === "excluded"
        ? "Tokens are exact but leave out what subagents used. Shares (≈) are estimated from how your plan moved while each project worked."
        : "Tokens are exact. Shares (≈) are estimated from how your plan moved while each project worked."
  }
}

/** This project, everything else and what's left, in whole percent that add up to 100. */
const legend = (week: WindowShare) => {
  const used = Math.round(week.usedPercent)
  const project = Math.min(Math.round(week.projectPercent), used)
  return {
    project: percentLabel(week.projectPercent),
    others: `${used - project}%`,
    left: `${100 - used}%`
  }
}

const clamp = (fraction: number) => Math.min(1, Math.max(0, fraction))
