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
  type Harness,
  harnessOf,
  type ModelConnection,
  type ModelProvider,
  offersModel,
  type Project,
  type ProjectSummary,
  type ReasoningEffort,
  type UsageLimitName,
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
      : picked.model !== undefined && offersModel(harness, picked.model)
        ? picked.model
        : DefaultAgent[harness].model
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

/**
 * The usage sheet's quiet line on how the project is set up: "It runs GPT-6 Luna at low effort, with no limits."
 * The limit that holds the project is left out, since the sheet's first sentence already says so.
 */
export const setupSentence = (
  project: Pick<Project, "harness" | "agentModel" | "agentEffort">,
  limits: UsageLimits,
  reached?: UsageLimitName
): string => {
  const { model, effort } = agentOf(project)
  const name = AgentModels[project.harness].find((option) => option.id === model)?.name ?? model
  const runs = `It runs ${name} at ${effortName[effort].toLowerCase()} effort`
  const cap = reached === "project" ? undefined : limits.projectWeekPercent
  const floor = reached === "planLeft" ? undefined : limits.planLeftPercent
  const mayUse = cap === undefined ? undefined : `may use up to ${cap}% of the week`
  const stops = floor === undefined ? undefined : `stops when the plan has ${floor}% left`
  if (mayUse && stops) return `${runs}. It ${mayUse}, and ${stops}.`
  if (mayUse || stops) return `${runs}, and ${mayUse ?? stops}.`
  return reached === undefined ? `${runs}, with no limits.` : `${runs}.`
}
