/**
 * The model family and reasoning effort each harness's top-level agent runs on. A subscription fixes the fleet: the
 * top-level agent is its provider's flagship family, reasoning high, unless they chose another, and it picks a model
 * and effort for each subagent it starts (Claude Code's `Agent` tool takes `model` and `effort`, Codex's
 * `spawn_agent` takes `model` and `reasoning_effort`; see docs/research/verified-facts.md).
 *
 * - Claude Code: `opus`, an alias each Claude Code release points at the newest Opus (2.1.322: claude-opus-5-5).
 * - Codex: `sol`, which runs as the newest Sol in the installed Codex's catalog (0.167.2: gpt-6.1-sol). Codex has no
 *   aliases, so `Models.ts` picks the slug, from the models with Codex's multi-agent tools (gpt-5.5, the adapter's
 *   default, has none, and a thread keeps the tools it started with).
 *
 * So moving the pinned CLIs (`scripts/update-harnesses.ts`) moves every project to its family's newest model.
 * The flagship is the domain's `DefaultAgent`, beside the families a project may choose instead (`AgentModels`).
 * dreamd's env says which it runs on (`DaemonEnv.model`, `DaemonEnv.effort`): the Worker writes the operator's QA
 * override if there is one, else the project's choice, and nothing for Dream's default (`daemonSettings` in the
 * ProjectDO's `SandboxManager.ts`). A changed choice rewrites the env file between turns, which restarts dreamd on
 * the new model in the same session.
 */
import { DefaultAgent, type Harness, type ReasoningEffort } from "@dream/domain"
import { Option } from "effect"

export interface TopLevel {
  readonly model: string
  readonly effort: ReasoningEffort
}

export const flagship: Readonly<Record<Harness, TopLevel>> = DefaultAgent

/**
 * Codex's context window, as `model_context_window` in its config: the most any model allows. Codex clamps it to
 * the model's `max_context_window` (gpt-6.1-sol in 0.167.2's catalog: 872,000, of which it uses 95%), raises the
 * auto-compact limit with it, and applies it to subagents too, whatever model they're on.
 */
export const codexContextWindow = 1_000_000

/**
 * Where Claude Code compacts a conversation (`autoCompactWindow` in its settings). Left on "auto", the window is
 * whatever Claude Code tunes for the model, up to Opus 5.5's 1M, and the top-level session lives as long as the
 * project, so every step could grow toward re-sending a million tokens, and the first step after an hour's sleep (when the prompt cache has gone) would
 * re-cache all of it. 300k bounds both, at the cost of a summary instead of the full history past that point; the
 * agent's memory, the project's files and git keep what matters. See docs/research/agent-token-usage.md.
 */
export const claudeAutoCompactWindow = 300_000

export const topLevel = (
  harness: Harness,
  override: { readonly model: Option.Option<string>; readonly effort: Option.Option<ReasoningEffort> }
): TopLevel => ({
  model: Option.getOrElse(override.model, () => flagship[harness].model),
  effort: Option.getOrElse(override.effort, () => flagship[harness].effort)
})
