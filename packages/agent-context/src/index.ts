/**
 * @dream/agent-context — everything the agent reads from Dream:
 * the system prompt, the `dream` skill, and each turn's prompt.
 *
 * The prompt and skill text is canonical in docs/agent-context.md and
 * docs/dream-skill.md; `bun run sync` regenerates ./generated/prompts.ts.
 */
import { renderAgentEvent, type AgentEvent } from "@dream/domain"
import { DateTime, Order } from "effect"

export { dreamSkill, systemPrompt, taskPrompt } from "./generated/prompts.ts"

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

const render = (heading: string, { events, now, timeZone }: TurnPromptInput): string => {
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
  return `It's ${clock} where they are (${zone}).\n\n${heading}:\n\n${body}\n`
}

/**
 * The user-turn prompt that starts a turn: the current time where they are,
 * then what woke the agent.
 */
export const renderTurnPrompt = (input: TurnPromptInput): string => render("What woke you", input)

/**
 * Input given to a turn that's already running (Claude Code and Codex both
 * accept it mid-turn), for events that arrive while the agent works.
 */
export const renderSteerPrompt = (input: TurnPromptInput): string =>
  render("This arrived while you were working", input)

export interface TaskPromptInput {
  /** The wake's reason, as the agent gave it. */
  readonly why: string
  /** The agent's brief: the whole of what the task's session is told about the job. */
  readonly brief: string
  readonly now: DateTime.Utc
  readonly timeZone?: string | undefined
}

/** The prompt that starts a scheduled task's session (`dream wake --task`): the time where they are, then the brief. */
export const renderTaskPrompt = ({ why, brief, now, timeZone }: TaskPromptInput): string => {
  const zone = timeZone ?? "UTC"
  const clock = DateTime.format(now, { locale: "en-US", timeZone: zone, dateStyle: "full", timeStyle: "short" })
  return `It's ${clock} where they are (${zone}).\n\nThe agent scheduled this job ("${why}"). Its brief:\n\n${brief.trim()}\n`
}
