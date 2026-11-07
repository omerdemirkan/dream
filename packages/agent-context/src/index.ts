/**
 * @dream/agent-context — everything the agent reads from Dream:
 * the system prompt, the `dream` skill, and each turn's prompt.
 *
 * The prompt and skill text is canonical in docs/agent-context.md and
 * docs/dream-skill.md; `bun run sync` regenerates ./generated/prompts.ts.
 */
import { renderAgentEvent, type AgentEvent, type MediaId } from "@dream/domain"
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
  /** Attachments dreamd couldn't copy into the sandbox, so the prompt doesn't point at a missing file. */
  readonly missingAttachments?: ReadonlySet<MediaId> | undefined
}

const byTime = Order.mapInput(DateTime.Order, (event: AgentEvent) => event.at)

const render = (heading: string, { events, now, timeZone, missingAttachments }: TurnPromptInput): string => {
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
      : sorted.map((event) => renderAgentEvent(event, { timeZone: zone, missingAttachments })).join("\n\n")
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

export interface GuidanceChange {
  /** Whether the system prompt changed. */
  readonly prompt: boolean
  /** Whether the `dream` skill changed. */
  readonly skill: boolean
}

/**
 * Said before the turn's prompt the first time a session that keeps its conversation (Claude Code's) runs on new
 * guidance from Dream, so the agent doesn't work from what it remembers of the old.
 */
export const renderGuidanceNote = ({ prompt, skill }: GuidanceChange): string => {
  const changed = [
    ...(prompt ? ["your system prompt is the new version now"] : []),
    ...(skill ? ["the dream skill changed, so load it again before you rely on what you remember of it"] : [])
  ]
  return `Dream updated its guidance for you since your last turn: ${changed.join(", and ")}.\n`
}

export interface HandoffInput {
  /** The previous conversation's log, if it was found. */
  readonly log?: string | undefined
  /** Its last exchanges, oldest first: Dream's prompts to the agent, and what the agent said. */
  readonly recent: ReadonlyArray<{ readonly from: "dream" | "you"; readonly text: string }>
}

/**
 * Said before the turn's prompt in a new conversation that replaces one whose guidance changed (Codex keeps a
 * conversation's instructions for its whole life): where the old one is, and how it ended.
 */
export const renderHandoff = ({ log, recent }: HandoffInput): string => {
  const where =
    log === undefined
      ? "Its log wasn't found, so the project's files and git history are what you have of it."
      : `Its log is ${log} (JSON lines; the messages are the "response_item" lines). Read more of it when you need to.`
  const exchanges =
    recent.length === 0
      ? ""
      : `\n\nHow it ended:\n\n${recent.map(({ from, text }) => `[${from === "dream" ? "Dream" : "You"}]\n${text.trim()}`).join("\n\n")}`
  return `Dream started this conversation for you because its guidance for you changed; your instructions are the new version. It continues your previous conversation with this project. ${where}${exchanges}\n`
}
