/**
 * @dream/agent-context — everything the agent reads from Dream:
 * the system prompt, the `dream` skill, and each turn's prompt.
 *
 * The prompt and skill text is canonical in docs/agent-context.md and
 * docs/dream-skill.md; `bun run sync` regenerates ./generated/prompts.ts.
 */
import { renderAgentEvent, type AgentEvent } from "@dream/domain"
import { DateTime, Order } from "effect"

export { dreamSkill, systemPrompt } from "./generated/prompts.ts"

/** Where the skill goes: `<skills dir>/dream/SKILL.md` for Claude Code and Codex. */
export const dreamSkillName = "dream"

export interface TurnPromptInput {
  /** The events that woke the agent, in any order; they are shown oldest first. */
  readonly events: ReadonlyArray<AgentEvent>
  readonly now: DateTime.Utc
  /** Their IANA time zone. Times are shown in it, so "7:00" means 7:00 where they are. */
  readonly timeZone?: string | undefined
}

const byTime = Order.mapInput(DateTime.Order, (event: AgentEvent) => event.at)

/**
 * The user-turn prompt that starts a turn: the current time where they are,
 * then what woke the agent.
 */
export const renderTurnPrompt = ({ events, now, timeZone }: TurnPromptInput): string => {
  const zone = timeZone ?? "UTC"
  const clock = DateTime.format(now, {
    locale: "en-US",
    timeZone: zone,
    dateStyle: "full",
    timeStyle: "short"
  })
  const sorted = [...events].sort(byTime)
  const body =
    sorted.length === 0
      ? "Nothing new has arrived."
      : sorted.map((event) => renderAgentEvent(event, { timeZone: zone })).join("\n\n")
  return `It's ${clock} where they are (${zone}).\n\nWhat woke you:\n\n${body}\n`
}
