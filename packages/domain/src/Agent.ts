/**
 * The project's agent: the model family and reasoning effort its top-level agent runs on. Dream's default is each
 * harness's flagship family at high effort (dreamd's `harness/Fleet.ts` reads it from here); they can choose another
 * when they start a project (`CreateProject`) or later (`SetAgentModel`). The agent picks each subagent's model and
 * effort itself, whatever it runs on. Added November 2026.
 *
 * A choice is a family, never a version: each turn runs on the family's newest model in the CLI the sandbox has
 * installed. Claude Code takes the family's alias (`fable`) and each release points it at the family's newest model;
 * Codex has no aliases, so dreamd picks the newest slug of the family from the installed Codex's own catalog
 * (`codex debug models --bundled`; dreamd's `harness/Models.ts`). A model a CLI release adds to a family reaches every
 * project on that family with no change here, and the app shows family names, so it needs no update either.
 * Codex projects and tasks saved before families name a slug (`gpt-6.1-sol`); `familyOf` reads one as its family.
 *
 * Only families that keep the agent orchestrating are offered: on Codex, only models whose catalog entry has the
 * multi-agent tools (`multi_agent_version` v2) can start subagents, and a thread keeps the tools it started with.
 * Every family offered takes every `ReasoningEffort` (Claude Code 2.1.322's model list, Codex 0.167.2's catalog).
 * `bun run harness:update` checks both again whenever it moves the CLIs (docs/research/verified-facts.md, "Agent
 * fleet").
 */
import type { Harness, Project, ReasoningEffort } from "./Project.ts"

export interface AgentModelOption {
  /** The family, as Dream stores it and dreamd passes it on: Claude Code's alias for it, or its Codex slug suffix. */
  readonly id: string
  readonly name: string
  /** One line for the picker: what it's good for, and what it costs of their plan. */
  readonly about: string
}

/** The families offered on each harness, most capable first. */
export const AgentModels: { readonly [H in Harness]: ReadonlyArray<AgentModelOption> } = {
  "claude-code": [
    { id: "fable", name: "Fable", about: "The most capable Claude. Uses your plan fastest." },
    { id: "opus", name: "Opus", about: "Strong judgment over a long project." },
    { id: "sonnet", name: "Sonnet", about: "Quicker, and lighter on your plan." },
    { id: "haiku", name: "Haiku", about: "The fastest and lightest, for simple ideas." }
  ],
  codex: [
    { id: "astra", name: "Astra", about: "OpenAI’s frontier model. Uses your plan fastest." },
    { id: "sol", name: "Sol", about: "OpenAI’s workhorse for building software." },
    { id: "terra", name: "Terra", about: "Balanced, and lighter on your plan." },
    { id: "luna", name: "Luna", about: "Fast and light on your plan, for simpler ideas." }
  ]
}

/** The levels offered, least first. */
export const ReasoningEfforts: ReadonlyArray<ReasoningEffort> = ["low", "medium", "high", "xhigh", "max"]

export interface AgentSettings {
  readonly model: string
  readonly effort: ReasoningEffort
}

/** Dream's default: each provider's flagship family (Opus; Sol, OpenAI's workhorse), reasoning high. */
export const DefaultAgent: { readonly [H in Harness]: AgentSettings } = {
  "claude-code": { model: "opus", effort: "high" },
  codex: { model: "sol", effort: "high" }
}

/** A Codex slug names its family: `gpt-6.1-sol` is a Sol. */
const codexSlug = /^gpt-\d+(?:\.\d+)*-([a-z]+)$/

/**
 * The family `model` stands for on `harness`, if it's one offered there: the family's own id, or on Codex a slug of
 * it (`gpt-6-luna`), as projects and tasks saved before families name them. A Claude id (`claude-haiku-4-5`) is
 * no family: Claude Code tells an alias, which follows the family, from an id, which pins a model, and Dream only
 * ever stored aliases.
 */
export const familyOf = (harness: Harness, model: string): string | undefined => {
  const id = harness === "codex" ? (codexSlug.exec(model)?.[1] ?? model) : model
  return AgentModels[harness].some((option) => option.id === id) ? id : undefined
}

/** Whether `model` is a family `harness` offers, or a Codex slug of one. */
export const offersModel = (harness: Harness, model: string): boolean => familyOf(harness, model) !== undefined

/** The family's name for people ("Fable"), or the model as it's named when it isn't one. */
export const modelName = (harness: Harness, model: string): string => {
  const family = familyOf(harness, model)
  return AgentModels[harness].find((option) => option.id === family)?.name ?? model
}

/**
 * The family and effort a project's agent runs on, by its choice or Dream's default (the operator's QA overrides
 * aside). A choice saved as a Codex slug reads as its family.
 */
export const agentOf = (project: Pick<Project, "harness" | "agentModel" | "agentEffort">): AgentSettings => ({
  model:
    project.agentModel === undefined
      ? DefaultAgent[project.harness].model
      : (familyOf(project.harness, project.agentModel) ?? project.agentModel),
  effort: project.agentEffort ?? DefaultAgent[project.harness].effort
})

/**
 * The fields a project keeps for a choice: the family (a Codex slug given for one is stored as the family), and
 * only what differs from Dream's default, so a project that keeps the default follows it when it moves.
 */
export const agentChoice = (
  harness: Harness,
  choice: { readonly model?: string | undefined; readonly effort?: ReasoningEffort | undefined }
): Pick<Project, "agentModel" | "agentEffort"> => {
  const model = choice.model === undefined ? undefined : (familyOf(harness, choice.model) ?? choice.model)
  return {
    ...(model === undefined || model === DefaultAgent[harness].model ? {} : { agentModel: model }),
    ...(choice.effort === undefined || choice.effort === DefaultAgent[harness].effort
      ? {}
      : { agentEffort: choice.effort })
  }
}

/**
 * The family on `to` that stands where `model` stands on `from`, for a project moving to another plan: by rank among
 * the families offered (the most capable for the most capable, the lightest for the lightest), so a choice made for
 * capability or for lightness on the plan keeps its intent. A family `to` offers (or a slug of one) stays, as its
 * family; any other name (a model the agent picked for a task, say) gets `to`'s lightest, since that's what such picks
 * are usually for. Added November 2026.
 */
export const equivalentModel = (from: Harness, to: Harness, model: string): string => {
  const here = familyOf(to, model)
  if (here !== undefined) return here
  const offered = AgentModels[to]
  const family = familyOf(from, model)
  const rank = AgentModels[from].findIndex((option) => option.id === family)
  const at = rank === -1 ? offered.length - 1 : Math.min(rank, offered.length - 1)
  return offered[at]!.id
}

/**
 * The project's choice on `to`, moving from its own harness: the counterpart of its model (`equivalentModel`), and
 * the same effort, which both harnesses take. A project on Dream's default stays on it.
 */
export const agentChoiceOn = (
  project: Pick<Project, "harness" | "agentModel" | "agentEffort">,
  to: Harness
): Pick<Project, "agentModel" | "agentEffort"> =>
  agentChoice(to, {
    ...(project.agentModel === undefined ? {} : { model: equivalentModel(project.harness, to, project.agentModel) }),
    ...(project.agentEffort === undefined ? {} : { effort: project.agentEffort })
  })
