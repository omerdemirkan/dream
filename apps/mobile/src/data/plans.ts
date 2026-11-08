/**
 * A person can connect both plans, Claude and ChatGPT, and each project runs on the one it was started on (its
 * harness). These say which plans are connected, which one a new idea goes to, and which projects wait because
 * their plan isn't connected (Dream holds their work until it is).
 */
import {
  type Harness,
  harnessOf,
  type ModelConnection,
  type ModelProvider,
  type ProjectSummary,
  providerOf
} from "@dream/domain"
import { DateTime } from "effect"
import { providerName } from "./format.ts"

/** Settings and the new-idea picker list plans in this order. */
export const PlanOrder: ReadonlyArray<ModelProvider> = ["claude", "chatgpt"]

/** The plans that work now, in `PlanOrder`. */
export const connectedPlans = (connections: ReadonlyArray<ModelConnection>): ReadonlyArray<ModelProvider> =>
  PlanOrder.filter((provider) => connections.some((c) => c.provider === provider && c.status === "connected"))

/**
 * Whether a project on `harness` waits for its plan. `undefined` connections (not loaded yet) never say so, and
 * neither does an empty list: then Home sends them to connect a plan at all.
 */
export const planMissing = (connections: ReadonlyArray<ModelConnection> | undefined, harness: Harness): boolean =>
  connections !== undefined && connections.length > 0 && !connectedPlans(connections).includes(providerOf(harness))

/**
 * The plan a new idea goes to when both are connected: the one their newest project runs on, else the one
 * connected most recently. The Worker picks the same when the app sends none.
 */
export const defaultPlan = (
  connections: ReadonlyArray<ModelConnection>,
  projects: ReadonlyArray<ProjectSummary>
): ModelProvider | undefined => {
  const plans = connectedPlans(connections)
  if (plans.length <= 1) return plans[0]
  const newest = [...projects].sort(
    (a, b) => DateTime.toEpochMillis(b.project.createdAt) - DateTime.toEpochMillis(a.project.createdAt)
  )[0]
  if (newest !== undefined) return providerOf(newest.project.harness)
  const at = (provider: ModelProvider) => {
    const connectedAt = connections.find((c) => c.provider === provider && c.status === "connected")?.connectedAt
    return connectedAt === undefined ? 0 : DateTime.toEpochMillis(connectedAt)
  }
  return [...plans].sort((a, b) => at(b) - at(a))[0]
}

/** The harness to send with a new idea: only when they have a choice, so one plan behaves as it always has. */
export const harnessToSend = (
  connections: ReadonlyArray<ModelConnection>,
  chosen: ModelProvider | undefined
): Harness | undefined =>
  chosen !== undefined && connectedPlans(connections).length > 1 ? harnessOf(chosen) : undefined

/** A plan their projects run on that isn't connected, for Home's banner: why, and how many projects wait. */
export interface MissingPlan {
  readonly provider: ModelProvider
  /** `expired`/`failed`: its sign-in stopped working; `removed`: they disconnected it. */
  readonly reason: "expired" | "failed" | "removed"
  readonly waiting: number
}

export const missingPlans = (
  connections: ReadonlyArray<ModelConnection>,
  projects: ReadonlyArray<ProjectSummary>
): ReadonlyArray<MissingPlan> => {
  if (connections.length === 0) return []
  const connected = connectedPlans(connections)
  return PlanOrder.flatMap((provider): Array<MissingPlan> => {
    if (connected.includes(provider)) return []
    const waiting = projects.filter((s) => providerOf(s.project.harness) === provider).length
    const broken = connections.find((c) => c.provider === provider && (c.status === "expired" || c.status === "failed"))
    // A sign-in under way isn't missing, and a plan nothing runs on needs no banner unless its sign-in broke.
    if (connections.some((c) => c.provider === provider && c.status === "pending")) return []
    if (broken === undefined && waiting === 0) return []
    return [
      {
        provider,
        reason: broken === undefined ? "removed" : broken.status === "expired" ? "expired" : "failed",
        waiting
      }
    ]
  })
}

/** What removing `provider` does to their projects, in a sentence. */
export const removeConsequence = (provider: ModelProvider, projects: ReadonlyArray<ProjectSummary>): string => {
  const name = providerName(provider)
  const on = projects.filter((s) => providerOf(s.project.harness) === provider)
  const only = on.length === 1 ? on[0] : undefined
  if (only !== undefined) return `${only.project.title} runs on ${name}. It pauses until you connect ${name} again.`
  if (on.length > 1) return `${on.length} projects run on ${name}. They pause until you connect ${name} again.`
  return `You can connect ${name} again any time.`
}

/**
 * Settings' plan section: one row per plan (the working connection over a broken one, the newest of each), in
 * `PlanOrder`, then a tile to add each plan that has none.
 */
export const settingsPlans = (connections: ReadonlyArray<ModelConnection>) => {
  const rank = (c: ModelConnection) => (c.status === "connected" ? 0 : c.status === "pending" ? 1 : 2)
  const shown = PlanOrder.flatMap((provider) => {
    const best = connections.filter((c) => c.provider === provider).sort((a, b) => rank(a) - rank(b))[0]
    return best === undefined ? [] : [best]
  })
  return {
    shown,
    connected: connectedPlans(connections),
    addable: PlanOrder.filter((provider) => !shown.some((c) => c.provider === provider))
  }
}
