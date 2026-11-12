/**
 * A project's starting settings, from the new-idea screen's Advanced sheet: which plan it runs on (only with more
 * than one connected), its agent's model and reasoning effort, and its usage limits. Left alone, they are what Dream
 * does anyway, and nothing extra is sent. The model and effort show again in the project's usage sheet, where they
 * can be changed.
 */
import {
  AgentModels,
  agentOf,
  DefaultAgent,
  familyOf,
  type Harness,
  harnessOf,
  type ModelConnection,
  type ModelProvider,
  modelName,
  type Project,
  type ProjectSummary,
  type ReasoningEffort,
  type UsageLimits
} from "@dream/domain"
import { connectedPlans, defaultPlan, harnessToSend } from "./plans.ts"

/** What they picked in the sheet; anything left out is the default. */
export interface Picked {
  readonly provider?: ModelProvider
  readonly model?: string
  readonly effort?: ReasoningEffort
  readonly limits: UsageLimits
}

export const nothingPicked: Picked = { limits: {} }

export interface ModelRow {
  readonly id: string
  readonly name: string
  readonly about: string
  readonly chosen: boolean
  readonly isDefault: boolean
}

export interface AdvancedView {
  /** The connected plans, when they have a choice of more than one. */
  readonly plans: ReadonlyArray<ModelProvider>
  readonly provider: ModelProvider | undefined
  /** Absent with no plan connected: then there's no model to choose yet. */
  readonly harness: Harness | undefined
  readonly models: ReadonlyArray<ModelRow>
  readonly effort: ReasoningEffort
  readonly limits: UsageLimits
  /** Anything differs from the defaults. */
  readonly changed: boolean
}

const hasLimits = (limits: UsageLimits) =>
  limits.projectWeekPercent !== undefined || limits.planLeftPercent !== undefined

/**
 * Under the models: each row is a family, which moves to its newest model as it comes out (`AgentModels`), so a turn
 * on a newer model than the last is no surprise.
 */
export const latestNote = "Always the newest version of each."

/** The families offered, by name: each runs on its newest model, so a row never names a version. */
export const modelRows = (harness: Harness, model: string): ReadonlyArray<ModelRow> =>
  AgentModels[harness].map((option) => ({
    ...option,
    chosen: option.id === model,
    isDefault: option.id === DefaultAgent[harness].model
  }))

/**
 * The sheet as it stands. A plan that's no longer connected falls back to the default one, and a model the plan
 * doesn't offer (they switched plans after choosing one) to that plan's default; the effort carries over.
 */
export const advancedView = (
  connections: ReadonlyArray<ModelConnection>,
  projects: ReadonlyArray<ProjectSummary>,
  picked: Picked
): AdvancedView => {
  const plans = connectedPlans(connections)
  const fallback = defaultPlan(connections, projects)
  const provider = picked.provider !== undefined && plans.includes(picked.provider) ? picked.provider : fallback
  const harness = provider === undefined ? undefined : harnessOf(provider)
  const model =
    harness === undefined
      ? undefined
      : ((picked.model === undefined ? undefined : familyOf(harness, picked.model)) ?? DefaultAgent[harness].model)
  const effort = picked.effort ?? (harness === undefined ? DefaultAgent["claude-code"] : DefaultAgent[harness]).effort
  return {
    plans: plans.length > 1 ? plans : [],
    provider,
    harness,
    models: harness === undefined || model === undefined ? [] : modelRows(harness, model),
    effort,
    limits: picked.limits,
    changed:
      provider !== fallback ||
      (harness !== undefined && model !== DefaultAgent[harness].model) ||
      (harness !== undefined && effort !== DefaultAgent[harness].effort) ||
      hasLimits(picked.limits)
  }
}

/** What goes with the idea to `CreateProject`: only what differs from Dream's defaults, so a plain idea sends none. */
export const createSettings = (
  connections: ReadonlyArray<ModelConnection>,
  projects: ReadonlyArray<ProjectSummary>,
  picked: Picked
): {
  readonly harness?: Harness
  readonly model?: string
  readonly effort?: ReasoningEffort
  readonly limits?: UsageLimits
} => {
  const view = advancedView(connections, projects, picked)
  const harness = harnessToSend(connections, view.provider)
  const model = view.models.find((row) => row.chosen)
  return {
    ...(harness === undefined ? {} : { harness }),
    ...(model === undefined || model.isDefault ? {} : { model: model.id }),
    ...(view.harness === undefined || view.effort === DefaultAgent[view.harness].effort ? {} : { effort: view.effort }),
    ...(hasLimits(picked.limits) ? { limits: picked.limits } : {})
  }
}

export const effortName: Readonly<Record<ReasoningEffort, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
}

/** One line under the effort control: what the chosen level does. */
export const effortAbout: Readonly<Record<ReasoningEffort, string>> = {
  low: "Quick, light steps. Fine for a simple idea.",
  medium: "Thinks enough for most steps.",
  high: "Thinks each step through. Dream’s default.",
  xhigh: "Thinks longer before each step.",
  max: "Thinks as long as it takes. Uses your plan fastest."
}

/** The project's model family by name, for the usage sheet's Agent row: "Sol". */
export const agentModelName = (project: Pick<Project, "harness" | "agentModel" | "agentEffort">): string =>
  modelName(project.harness, agentOf(project).model)
