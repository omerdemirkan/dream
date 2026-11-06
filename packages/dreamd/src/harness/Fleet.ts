/**
 * The model and reasoning effort each harness's top-level agent runs on. A subscription fixes the fleet: the
 * top-level agent is always its provider's latest flagship, reasoning high, and it picks a model and effort for
 * each subagent it starts (Claude Code's `Agent` tool takes `model` and `effort`, Codex's `spawn_agent` takes
 * `model` and `reasoning_effort`; see docs/research/verified-facts.md).
 *
 * - Claude Code: the `opus` alias, which each Claude Code release points at the latest Opus (2.1.318:
 *   claude-opus-5-5), so moving the pinned CLI moves the model.
 * - Codex has no alias that tracks a family, so the model is pinned here: the newest Sol in the pinned Codex's
 *   catalog (0.165.0: gpt-6.1-sol). When Codex moves, check `codex debug models --bundled` in the new build.
 *   Only models with Codex's multi-agent tools can start subagents (gpt-6.1-sol has them; gpt-5.5, the
 *   adapter's default, doesn't), and a thread keeps the tools it started with.
 *
 * The operator can override either for a run (`DaemonEnv.model`, `DaemonEnv.effort`), e.g. a cheap model for QA.
 */
import type { Harness, ReasoningEffort } from "@dream/domain"
import { Option } from "effect"

export interface TopLevel {
  readonly model: string
  readonly effort: ReasoningEffort
}

export const flagship: Readonly<Record<Harness, TopLevel>> = {
  "claude-code": { model: "opus", effort: "high" },
  codex: { model: "gpt-6.1-sol", effort: "high" }
}

/**
 * Codex's context window, as `model_context_window` in its config: the most any model allows. Codex clamps it to
 * the model's `max_context_window` (gpt-6.1-sol in 0.165.0's catalog: 872,000, of which it uses 95%), raises the
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
