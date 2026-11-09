/**
 * Settings as an index (Settings direction B, mocks/screens/settings-directions): one line per plan, Dream usage,
 * connected service and the account, each with its answer on the right, and the page each row opens. What every
 * row and page says comes from here, so it's tested in Node. Only what Dream knows: a plan whose week it hasn't
 * seen says "Connected", with no ring.
 */
import type { AccountCosts, AccountUsage, Integration, ModelConnection, ProjectId, User } from "@dream/domain"
import { DateTime } from "effect"
import { dollars, monthName } from "./costs.ts"
import { providerName, resetLabel, timeLabel } from "./format.ts"
import { type PlanCard, planCard, type RingArcs } from "./usage.ts"

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** One plan's line in Settings: its name, and what's left of its week on the right. */
export interface PlanRow {
  /** "ChatGPT Pro", or the provider's name while the plan's name isn't known. */
  readonly title: string
  /** "36% left", "Paused until 3:40 PM", "Connected", "Finishing sign-in", "Sign-in expired" */
  readonly value: string
  /** Amber: near the end of the week, paused at a limit, or a sign-in that stopped working. */
  readonly need: boolean
  /** The week as a ring, their projects in white and the rest in grey; absent when the week isn't known. */
  readonly ring?: RingArcs
  /** Under the plans, in a sentence: what happens if a nearly used week runs out. */
  readonly note?: string
}

/** The week from the freshest source: `GetAccountUsage` splits it between their projects and the rest. */
const weekOf = (connection: ModelConnection, account: AccountUsage | undefined) => {
  if (account?.weekly) return { ...account.weekly, split: true }
  const whole = connection.usage?.weekly
  return whole ? { usedPercent: whole.usedPercent, dreamPercent: 0, resetsAt: whole.resetsAt, split: false } : undefined
}

const fraction = (percent: number) => Math.min(1, Math.max(0, percent / 100))

/** Their projects' part in white (none when nothing splits it), the rest of what's used in grey. */
const weekArcs = (week: NonNullable<ReturnType<typeof weekOf>>): RingArcs => {
  const project = fraction(Math.min(week.dreamPercent, week.usedPercent))
  return { project, others: Math.max(0, fraction(week.usedPercent) - project) }
}

const leftOf = (usedPercent: number) => 100 - Math.round(usedPercent)

/** The bar's two parts in whole percents that add up to the week's rounded figure. */
const legendOf = (week: { readonly usedPercent: number; readonly dreamPercent: number }) => {
  const used = Math.round(week.usedPercent)
  const projects = Math.min(used, Math.round(Math.min(week.dreamPercent, week.usedPercent)))
  return { projects: `Your projects ${projects}%`, outside: `Outside Dream ${used - projects}%` }
}

export const planRow = (
  connection: ModelConnection,
  account: AccountUsage | undefined,
  now: DateTime.Utc,
  timeZone?: string
): PlanRow => {
  const name = providerName(connection.provider)
  if (connection.status === "pending")
    return { title: connection.usage?.plan ?? name, value: "Finishing sign-in", need: false }
  if (connection.status !== "connected")
    return { title: name, value: connection.status === "expired" ? "Sign-in expired" : "Sign-in failed", need: true }
  const card = planCard(connection, account, now, timeZone)
  const week = weekOf(connection, account)
  const ring = week ? { ring: weekArcs(week) } : {}
  const limited = connection.usage?.limitedUntil
  // No ring while paused: when it picks up is the answer, and the plan's name stays whole beside it.
  if (limited) return { title: card.title, value: `Paused until ${timeLabel(limited.until, timeZone)}`, need: true }
  if (week)
    return {
      title: card.title,
      value: `${leftOf(week.usedPercent)}% left`,
      need: card.nearLimit,
      ...ring,
      ...(card.nearLimit
        ? {
            note: week.resetsAt
              ? `If it runs out before ${resetLabel(week.resetsAt, now, timeZone)}, your projects on ${name} pause, and they pick up on their own when it resets.`
              : `If it runs out, your projects on ${name} pause, and they pick up on their own when it resets.`
          }
        : {})
    }
  const five = connection.usage?.fiveHour
  if (five) return { title: card.title, value: `${leftOf(five.usedPercent)}% left for now`, need: false }
  return { title: card.title, value: "Connected", need: false }
}

/** A plan's page (`app/plan/[provider]`): what's left in large type, the week, each project's share, its actions. */
export interface PlanPage {
  readonly title: string
  /** The large line: "36%" over "of this week left", or a state ("Paused until 3:40 PM", "Connected"). */
  readonly headline: { readonly big: string; readonly rest?: string; readonly need: boolean }
  /** "Resets Wed 6:00 AM" */
  readonly resets?: string
  /** A sentence under the headline, when the numbers can't say it. */
  readonly about?: string
  /** The week as a bar, their projects in focus. */
  readonly week?: { readonly focus: number; readonly others: number; readonly need: boolean }
  /** What the bar's two parts are, when the week is split between their projects and the rest. */
  readonly legend?: { readonly projects: string; readonly outside: string }
  /** The plan card's pieces: the five hours under the week, and each project's share. */
  readonly card?: PlanCard
  /** Which actions it has: a working plan reconnects or goes; a sign-in under way cancels; a broken one reconnects. */
  readonly actions: "connected" | "pending" | "broken"
}

export const planPage = (
  connection: ModelConnection,
  account: AccountUsage | undefined,
  now: DateTime.Utc,
  timeZone?: string
): PlanPage => {
  const name = providerName(connection.provider)
  if (connection.status === "pending")
    return {
      title: name,
      headline: { big: "Finishing sign-in", need: false },
      about: `Dream is waiting for ${name} to confirm it. This takes a moment once you’ve approved it.`,
      actions: "pending"
    }
  if (connection.status !== "connected")
    return {
      title: name,
      headline: { big: connection.status === "expired" ? "Sign-in expired" : "Sign-in failed", need: true },
      about: `Your projects on ${name} wait until you connect it again. Their work is kept.`,
      actions: "broken"
    }
  const card = planCard(connection, account, now, timeZone)
  const week = weekOf(connection, account)
  const limited = connection.usage?.limitedUntil
  const resets = week?.resetsAt ? { resets: `Resets ${resetLabel(week.resetsAt, now, timeZone)}` } : {}
  const bar = week
    ? {
        week: { focus: weekArcs(week).project, others: weekArcs(week).others, need: card.nearLimit },
        ...(week.split ? { legend: legendOf(week) } : {})
      }
    : {}
  // The week is the large line and its bar, so only the five hours stay as a window.
  const shown: PlanCard = { ...card, windows: card.windows.filter((w) => w.label !== "Week") }
  const { callout: _, ...withoutCallout } = shown
  if (limited)
    return {
      title: card.title,
      headline: { big: `Paused until ${timeLabel(limited.until, timeZone)}`, need: true },
      about: `Its limit was reached. Your projects on ${name} pick up on their own then.`,
      ...bar,
      card: withoutCallout,
      actions: "connected"
    }
  if (week)
    return {
      title: card.title,
      headline: { big: `${leftOf(week.usedPercent)}%`, rest: "of this week left", need: card.nearLimit },
      ...resets,
      // Near the limit, what happens if it runs out; the callout would only repeat the large line.
      ...(card.nearLimit
        ? {
            about: `If it runs out first, your projects on ${name} pause, and they pick up on their own when it resets.`
          }
        : {}),
      ...bar,
      card: withoutCallout,
      actions: "connected"
    }
  return {
    title: card.title,
    headline: { big: "Connected", need: false },
    about: `Dream shows how much of the week is left once a project has run on ${name}.`,
    card: shown,
    actions: "connected"
  }
}

// ---------------------------------------------------------------------------
// Dream usage
// ---------------------------------------------------------------------------

/** Dream usage's line: this month so far, and whether there's anything behind it to open. */
export interface CostsRow {
  /** "November so far" */
  readonly title: string
  /** "$44.81", or "Nothing yet" */
  readonly value: string
  readonly opens: boolean
}

/** Absent while the costs haven't loaded, or against an API without them. */
export const costsRow = (costs: AccountCosts | undefined): CostsRow | undefined => {
  if (costs === undefined) return undefined
  const spent = costs.month.lines.some((l) => l.payer === "dream") || costs.month.usd > 0
  return {
    title: `${monthName(costs.month)} so far`,
    value: spent ? dollars(costs.month.usd) : "Nothing yet",
    // Last month's figures, or an operator's way into everyone's, are worth the page even before this month costs.
    opens: spent || costs.lastMonth.usd > 0 || costs.everyone !== undefined
  }
}

// ---------------------------------------------------------------------------
// Connected services
// ---------------------------------------------------------------------------

export type ServiceIcon = "lock" | "key" | "doc" | "apple"

/** A connected service's line: who can use it on the right, or that it stopped working. */
export interface ServiceRow {
  readonly title: string
  readonly icon: ServiceIcon
  readonly value: string
  readonly need: boolean
}

const iconOf = (integration: Integration): ServiceIcon => {
  switch (integration.access._tag) {
    case "Google":
    case "OAuth":
      return "lock"
    case "Key":
      return "key"
    case "File":
      return "doc"
    case "Apple":
      return "apple"
  }
}

export const serviceRow = (integration: Integration): ServiceRow => ({
  title: integration.label,
  icon: iconOf(integration),
  value:
    integration.status !== "connected"
      ? "Stopped working"
      : integration.access._tag === "File"
        ? "One project"
        : "All projects",
  need: integration.status !== "connected"
})

/** A connected service's page (`app/service/[id]`). */
export interface ServicePage {
  readonly title: string
  readonly icon: ServiceIcon
  /** What it is, and since when: "Key for api.openai.com, added Nov 6". */
  readonly kind: string
  /** Who can use it and how, in a sentence; absent while it doesn't work. */
  readonly about?: string
  /** A key file's project, which the page links to. */
  readonly projectId?: ProjectId
  readonly projectTitle?: string
  /** It stopped working, and where to connect it again. */
  readonly stopped?: string
  /** Pasted keys and key files can be swapped for a new one here; sign-ins reconnect from a project's card. */
  readonly replace?: {
    readonly label: string
    readonly placeholder: string
    readonly save: string
    readonly done: string
  }
  readonly remove: { readonly label: string; readonly title: string; readonly message: string; readonly done: string }
}

const dateLabel = (dt: DateTime.Utc, timeZone?: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) }).format(
    DateTime.toDateUtc(dt)
  )

const kindOf = (integration: Integration): string => {
  const access = integration.access
  switch (access._tag) {
    case "Google":
      return access.email ? `Signed in as ${access.email}` : "Signed in with Google"
    case "OAuth":
      return access.account ? `Signed in as ${access.account}` : `Signed in with ${access.service}`
    case "Key":
      return `Key for ${access.host}`
    case "File":
      return "Key file"
    case "Apple":
      return `App Store Connect key ${access.keyId}`
  }
}

const aboutOf = (integration: Integration, projectTitle: string | undefined): string => {
  const access = integration.access
  switch (access._tag) {
    case "Google":
    case "OAuth":
      return "Every project can use it. Dream keeps the sign-in fresh."
    case "Key":
      return `Every project can use it. The key stays in Dream’s vault, and Dream adds it to requests to ${access.host}.`
    case "File":
      return `It lives on ${projectTitle ? `${projectTitle}’s` : "one project’s"} computer, so no other project can reach it.`
    case "Apple":
      return "Every project can use it. The private key stays encrypted with Dream."
  }
}

export const servicePage = (
  integration: Integration,
  projectTitle: (id: ProjectId) => string | undefined,
  timeZone?: string
): ServicePage => {
  const access = integration.access
  const file = access._tag === "File"
  const owner = file ? projectTitle(access.projectId) : undefined
  const name = integration.label
  return {
    title: name,
    icon: iconOf(integration),
    kind: `${kindOf(integration)}, added ${dateLabel(integration.connectedAt, timeZone)}`,
    ...(integration.status === "connected" ? { about: aboutOf(integration, owner) } : {}),
    ...(file ? { projectId: access.projectId, ...(owner ? { projectTitle: owner } : {}) } : {}),
    ...(integration.status !== "connected"
      ? { stopped: `${name} stopped working. Connect it again from the card of the project that asked for it.` }
      : {}),
    ...(access._tag === "Key" || file
      ? {
          replace: {
            label: file ? "Replace key file" : "Replace key",
            placeholder: `New ${name} key`,
            save: file ? "Save to this project" : "Save to vault",
            done: file ? `New ${name} key saved. The project will pick it up.` : `New ${name} key saved.`
          }
        }
      : {}),
    remove: file
      ? {
          label: "Remove",
          title: `Remove ${name}?`,
          message:
            "Dream deletes the key file from that project’s computer. You can add it again from the project’s card.",
          done: `Removed ${name}`
        }
      : {
          label: "Disconnect",
          title: `Disconnect ${name}?`,
          message:
            "No project can use it after this. You can connect it again from the card of the project that asked for it.",
          done: `Disconnected ${name}`
        }
  }
}

// ---------------------------------------------------------------------------
// The account
// ---------------------------------------------------------------------------

/** The account's line and page: their name over their email, or the email alone. */
export const accountView = (user: User | undefined, timeZone?: string) => {
  if (user === undefined) return { title: "Signed in", subtitle: undefined, since: undefined }
  return {
    title: user.name ?? user.email,
    subtitle: user.name ? user.email : undefined,
    since: `On Dream since ${new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      ...(timeZone ? { timeZone } : {})
    }).format(DateTime.toDateUtc(user.createdAt))}`
  }
}
