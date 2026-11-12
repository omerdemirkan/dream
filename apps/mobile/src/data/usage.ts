/**
 * How a project's use of the subscription reads on screen: the ring in the project header (Deck v3, project usage
 * option A) and the usage sheet it opens. Pure, so it's tested in Node. Shares are estimates.
 */
import type {
  AccountUsage,
  ModelConnection,
  ModelProvider,
  Project,
  ProjectShare,
  ProjectUsage,
  ProjectUsageGlance,
  UsageLimitName,
  UsageLimitReached,
  UsageLimits,
  UsageSnapshot,
  WindowShare
} from "@dream/domain"
import { DateTime } from "effect"
import { providerName, resetLabel, type Sentence, usageDetail } from "./format.ts"

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
// Pieces the project sheet and Settings' plan page share
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

/** What the API calls a project that's gone (`apps/api/src/usage/ProjectUsage.ts`); it has no icon. */
const deletedTitle = "Deleted project"

/**
 * Every project's share, largest first as given, then the deleted ones together as one row, then Outside Dream's;
 * bars against the largest.
 */
const shareRows = (
  projects: ReadonlyArray<ProjectShare>,
  outsideDreamPercent: number | undefined,
  currentId: string | undefined
): ReadonlyArray<ShareRowView> => {
  const isDeleted = (p: ProjectShare) => p.title === deletedTitle && p.icon === undefined && p.projectId !== currentId
  const named = projects.filter((p) => !isDeleted(p))
  const deleted = projects.filter(isDeleted)
  const deletedPercent = deleted.reduce((n, p) => n + p.sharePercent, 0)
  const largest = Math.max(0, ...named.map((p) => p.sharePercent), deletedPercent, outsideDreamPercent ?? 0)
  const bar = (percent: number) => (largest > 0 ? percent / largest : 0)
  return [
    ...named.map((p) => ({
      key: p.projectId,
      title: p.title,
      ...(p.icon ? { icon: p.icon } : {}),
      share: percentLabel(p.sharePercent),
      bar: bar(p.sharePercent),
      current: p.projectId === currentId,
      outside: false
    })),
    ...(deleted.length > 0
      ? [
          {
            key: "deleted",
            title: deleted.length > 1 ? "Deleted projects" : deletedTitle,
            icon: "trash",
            share: percentLabel(deletedPercent),
            bar: bar(deletedPercent),
            current: false,
            outside: false
          }
        ]
      : []),
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
// The sheet (usage sheet direction B, "Read, then adjust": mocks/screens/usage-sheet-directions)
// ---------------------------------------------------------------------------

/**
 * The top of the usage sheet: where the project stands on its plan, said in a sentence beside a small ring of the
 * week, and the one thing that fixes a trouble, when a tap can. Everything they can change sits behind Adjust.
 */
export interface UsageSummary {
  /** The week as a ring, absent when the week isn't known. */
  readonly ring?: {
    readonly arcs: RingArcs
    /** This project's share: "4%". */
    readonly label: string
    /** Amber: near the end of the week, the week ran out, or a limit they set holds the project. */
    readonly need: boolean
  }
  /** Where it stands; the lead is amber when something holds the project back. */
  readonly plan: Sentence
  /** The fix beside Adjust: clear the limit that holds it, or move it to their other plan, which has room. */
  readonly fix?: UsageFix
  /** Why the move is offered: "Your Claude plan has 62% of its week left…", when Dream knows how much. */
  readonly otherPlan?: string
}

export type UsageFix =
  | { readonly _tag: "ClearLimit"; readonly limit: UsageLimitName }
  | { readonly _tag: "Move"; readonly to: ModelProvider }

/** Where the project stands against its limits, for their fields on the Adjust page. */
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

/** A share in words, for a sentence: "under 1%", "about 4%"; undefined when the project used none of it. */
const shareWords = (percent: number) =>
  percent <= 0 ? undefined : percent < 0.5 ? "under 1%" : `about ${Math.round(percent)}%`

/** A connection's pause that still holds. */
const pauseOf = (connection: ModelConnection | undefined, now: DateTime.Utc) => {
  const limited = connection?.usage?.limitedUntil
  return limited && DateTime.isGreaterThan(limited.until, now) ? limited : undefined
}

/** Their other connected plan, when it could take the project now: not paused, and not near the end of its week. */
const roomyOtherPlan = (connections: ReadonlyArray<ModelConnection>, provider: ModelProvider, now: DateTime.Utc) => {
  const other = connections.find((c) => c.provider !== provider && c.status === "connected")
  if (other === undefined || pauseOf(other, now)) return undefined
  const week = other.usage?.weekly
  if (week !== undefined && week.usedPercent >= nearLimitPercent) return undefined
  return { provider: other.provider, left: week === undefined ? undefined : leftOf(week.usedPercent) }
}

const leftOf = (usedPercent: number) => 100 - Math.round(usedPercent)

/**
 * The sheet's summary. `connections` are their plans (`ListModelConnections`): the project's says when the plan
 * itself paused it (its five hours or its week ran out), and the other's whether a move would help.
 */
export const usageSummary = (
  usage: ProjectUsage,
  project: Pick<Project, "planSwitch">,
  connections: ReadonlyArray<ModelConnection>,
  now: DateTime.Utc,
  timeZone?: string
): UsageSummary => {
  const name = providerName(usage.provider)
  // `weekWindow` is there whether or not this project worked this week; APIs from before it send `weekly` alone.
  const week = usage.weekWindow ?? usage.weekly
  const reached = usage.limitReached
  const paused = pauseOf(
    connections.find((c) => c.provider === usage.provider && c.status === "connected"),
    now
  )
  const nearLimit = week !== undefined && week.usedPercent >= nearLimitPercent
  const resets = week?.resetsAt ? resetLabel(week.resetsAt, now, timeZone) : undefined
  const share = week === undefined ? undefined : shareWords(week.projectPercent)
  const left = week === undefined ? undefined : leftOf(week.usedPercent)
  const other = project.planSwitch?.state === "waiting" ? undefined : roomyOtherPlan(connections, usage.provider, now)
  const move = (): Pick<UsageSummary, "fix" | "otherPlan"> =>
    other === undefined
      ? {}
      : {
          fix: { _tag: "Move", to: other.provider },
          ...(other.left === undefined
            ? {}
            : {
                otherPlan: `Your ${providerName(other.provider)} plan has ${other.left}% of its week left, if you’d rather move it there.`
              })
        }
  const ring =
    week === undefined
      ? {}
      : {
          ring: {
            arcs: ringArcs(week, 0.05),
            label: percentLabel(week.projectPercent),
            need: nearLimit || reached !== undefined || paused?.window === "weekly"
          }
        }
  const orWhenResets = resets ? `, or when your week resets ${resets}` : ""

  if (reached) {
    return {
      ...ring,
      plan: [
        {
          text:
            reached.limit === "project"
              ? `Paused at the ${reached.percent}% you gave it.`
              : `Paused to keep ${reached.percent}% of your week free.`,
          tone: "need"
        },
        {
          text: ` It picks up when you ${reached.limit === "project" ? "raise" : "lower"} or clear the limit${orWhenResets}.`
        }
      ],
      fix: { _tag: "ClearLimit", limit: reached.limit }
    }
  }
  if (paused?.window === "fiveHour") {
    const rest =
      left === undefined
        ? ""
        : share
          ? ` This project used ${share} of your week, and ${left}% of it is left.`
          : ` ${left}% of your week is left.`
    return {
      ...ring,
      plan: [
        { text: "Your five hours ran out.", tone: "need" },
        { text: ` The agent picks up on its own at ${resetLabel(paused.until, now, timeZone)}.${rest}` }
      ]
    }
  }
  if (paused?.window === "weekly") {
    return {
      ...ring,
      plan: [
        { text: "Your week ran out.", tone: "need" },
        {
          text: ` The agent picks up on its own when it resets ${resetLabel(paused.until, now, timeZone)}.${share ? ` This project used ${share} of it.` : ""}`
        }
      ],
      ...move()
    }
  }
  if (week !== undefined && nearLimit) {
    return {
      ...ring,
      plan: [
        { text: `Only ${left}% of your week is left`, tone: "need" },
        {
          text: `${resets ? `, until ${resets}` : ""}.${share ? ` This project used ${share} of it.` : ""} If it runs out, its work pauses and picks up on its own when the week resets.`
        }
      ],
      ...move()
    }
  }
  if (week !== undefined) {
    const after = [
      { text: `${left}%`, tone: "strong" as const },
      { text: ` is left${resets ? `, and it resets ${resets}` : ""}.` }
    ]
    return {
      ...ring,
      plan: share
        ? [
            { text: "This project used " },
            { text: share, tone: "strong" },
            { text: ` of your ${name} week. ` },
            ...after
          ]
        : [{ text: `This project hasn’t used any of your ${name} week yet. ` }, ...after]
    }
  }
  return {
    plan: [
      {
        text:
          usage.billing === "apiKey"
            ? "It runs on an API key, so there’s no weekly limit to share."
            : `Dream doesn’t know yet how much of your ${name} week is used.`
      }
    ]
  }
}

/** Each limit as its field shows it, with a quiet line on where the project stands against it. */
export const limitsView = (usage: ProjectUsage): LimitsView => {
  const week = usage.weekWindow ?? usage.weekly
  const limits = usage.limits ?? {}
  const reached = usage.limitReached
  return {
    project: {
      value: limits.projectWeekPercent,
      ...(week && limits.projectWeekPercent !== undefined
        ? { note: `About ${percentLabel(week.projectPercent)} used so far` }
        : {}),
      reached: reached?.limit === "project"
    },
    planLeft: {
      value: limits.planLeftPercent,
      ...(week && limits.planLeftPercent !== undefined ? { note: `${leftOf(week.usedPercent)}% left now` } : {}),
      reached: reached?.limit === "planLeft"
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
// Settings' plans (Deck v3, usage in Settings option B; the page from Settings direction B)
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
  /** Every project's share of the week, on the plan's page; empty when the API can't say (it predates `GetAccountUsage`). */
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
          footnote: "Shares are estimates."
        }
      : {})
  }
}
