/**
 * The project's agent: the model and reasoning effort its top-level agent runs on. Dream's default is each
 * harness's flagship at high effort (dreamd's `harness/Fleet.ts` reads it from here); they can choose another when
 * they start a project (`CreateProject`) or later (`SetAgentModel`). The agent picks each subagent's model and effort
 * itself, whatever it runs on. Added November 2026.
 *
 * Only models that keep the agent orchestrating are offered: on Codex, only models whose catalog entry has the
 * multi-agent tools (`multi_agent_version` v2 in Codex 0.165.0's `codex debug models --bundled`) can start subagents,
 * and a thread keeps the tools it started with, so a model without them is never offered, at creation or later.
 * Every model offered takes every `ReasoningEffort` (Claude Code's aliases in 2.1.318 and Codex 0.165.0's catalog).
 * When a pinned CLI moves, check both again (docs/research/verified-facts.md, "Agent fleet").
 */
import type { Harness, Project, ReasoningEffort } from "./Project.ts"

export interface AgentModelOption {
  /** What the harness takes: a Claude Code alias (which each release points at that family's latest), a Codex slug. */
  readonly id: string
  readonly name: string
  /** One line for the picker: what it's good for, and what it costs of their plan. */
  readonly about: string
}

/** The models offered on each harness, most capable first. */
export const AgentModels: { readonly [H in Harness]: ReadonlyArray<AgentModelOption> } = {
  "claude-code": [
    { id: "fable", name: "Fable 5.1", about: "The most capable Claude. Uses your plan fastest." },
    { id: "opus", name: "Opus 5.5", about: "Strong judgment over a long project." },
    { id: "sonnet", name: "Sonnet 5.5", about: "Quicker, and lighter on your plan." }
  ],
  codex: [
    { id: "gpt-6-astra", name: "GPT-6 Astra", about: "OpenAI’s frontier model. Uses your plan fastest." },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", about: "The latest workhorse for building software." },
    { id: "gpt-6-luna", name: "GPT-6 Luna", about: "Fast and light on your plan, for simpler ideas." }
  ]
}

/** The levels offered, least first. */
export const ReasoningEfforts: ReadonlyArray<ReasoningEffort> = ["low", "medium", "high", "xhigh", "max"]

export interface AgentSettings {
  readonly model: string
  readonly effort: ReasoningEffort
}

/** Dream's default: each provider's flagship (the latest Opus; the newest Sol in the pinned Codex), reasoning high. */
export const DefaultAgent: { readonly [H in Harness]: AgentSettings } = {
  "claude-code": { model: "opus", effort: "high" },
  codex: { model: "gpt-6.1-sol", effort: "high" }
}

/** Whether `model` is one `harness` offers. */
export const offersModel = (harness: Harness, model: string): boolean =>
  AgentModels[harness].some((option) => option.id === model)

/** The model and effort a project's agent runs on, by its choice or Dream's default (the operator's QA overrides aside). */
export const agentOf = (project: Pick<Project, "harness" | "agentModel" | "agentEffort">): AgentSettings => ({
  model: project.agentModel ?? DefaultAgent[project.harness].model,
  effort: project.agentEffort ?? DefaultAgent[project.harness].effort
})

/**
 * The fields a project keeps for a choice: only what differs from Dream's default, so a project that keeps the
 * default follows it when it moves.
 */
export const agentChoice = (
  harness: Harness,
  choice: { readonly model?: string | undefined; readonly effort?: ReasoningEffort | undefined }
): Pick<Project, "agentModel" | "agentEffort"> => ({
  ...(choice.model === undefined || choice.model === DefaultAgent[harness].model ? {} : { agentModel: choice.model }),
  ...(choice.effort === undefined || choice.effort === DefaultAgent[harness].effort
    ? {}
    : { agentEffort: choice.effort })
})
