/**
 * @dream/agent-context — everything the agent reads from Dream:
 * the system prompt, the `dream` skill, and each turn's prompt.
 *
 * The prompt, skill and task-prompt text is canonical in the sections in
 * docs/prompts/; `bun run sync-prompts` regenerates ./generated/prompts.ts.
 */
import { renderAgentEvent, type AgentEvent, type MediaId } from "@dream/domain"
import { DateTime, Order } from "effect"

export { dreamSkill, systemPrompt, taskPrompt } from "./generated/prompts.ts"

/** Where the skill goes: `<skills dir>/dream/SKILL.md` for Claude Code and Codex. */
export const dreamSkillName = "dream"

/** One session that worked in a turn: the agent's own, or a subagent's. */
export interface SessionSpend {
  readonly own: boolean
  /** A subagent's description, as the agent gave it. */
  readonly description?: string | undefined
  /** The model, as the agent named it or as the provider reports it. */
  readonly model?: string | undefined
  readonly effort?: string | undefined
  /** Model calls. */
  readonly steps: number
  /** The most context one of its steps sent, in tokens. */
  readonly peakContext: number
  /** What it cost: dollars at list prices, or (`LastTurn.priced` false) a unit common to the turn's sessions. */
  readonly cost: number
  /** The part of `cost` spent sending the session afresh after a pause had let its cache lapse. */
  readonly recached: number
}

/** What the previous turn used, which the next turn's prompt opens with (`renderLastTurn`). */
export interface LastTurn {
  readonly startedAt: DateTime.Utc
  readonly endedAt: DateTime.Utc
  /** Whether `cost` is in dollars (it isn't for a provider whose prices dreamd doesn't know). */
  readonly priced: boolean
  /** Every session with a step in the turn, the agent's own included. */
  readonly sessions: ReadonlyArray<SessionSpend>
  /** Their weekly window (used percent) at the turn's first model call and at its end, when both were read. */
  readonly weekly?: { readonly before: number; readonly after: number } | undefined
}

export interface TurnPromptInput {
  /** The events that woke the agent, in any order; they are shown oldest first. */
  readonly events: ReadonlyArray<AgentEvent>
  readonly now: DateTime.Utc
  /** Their IANA time zone. Times are shown in it, so "7:00" means 7:00 where they are. */
  readonly timeZone?: string | undefined
  /** Attachments dreamd couldn't copy into the sandbox, so the prompt doesn't point at a missing file. */
  readonly missingAttachments?: ReadonlySet<MediaId> | undefined
  /** What the previous turn used; the prompt says so after the time. */
  readonly lastTurn?: LastTurn | undefined
}

const byTime = Order.mapInput(DateTime.Order, (event: AgentEvent) => event.at)

const render = (heading: string, { events, now, timeZone, missingAttachments, lastTurn }: TurnPromptInput): string => {
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
  const spent = lastTurn === undefined ? "" : renderLastTurn(lastTurn)
  return `It's ${clock} where they are (${zone}).\n\n${spent === "" ? "" : `${spent}\n\n`}${heading}:\n\n${body}\n`
}

/**
 * The user-turn prompt that starts a turn: the current time where they are, what the last turn used, then what
 * woke the agent.
 */
export const renderTurnPrompt = (input: TurnPromptInput): string => render("What woke you", input)

/**
 * Input given to a turn that's already running (Claude Code and Codex both
 * accept it mid-turn), for events that arrive while the agent works.
 */
export const renderSteerPrompt = ({ lastTurn: _, ...input }: TurnPromptInput): string =>
  render("This arrived while you were working", input)

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

const dollars = (n: number) => (n < 1 ? `$${n.toFixed(2)}` : n < 10 ? `$${n.toFixed(1)}` : `$${Math.round(n)}`)

const span = (startedAt: DateTime.Utc, endedAt: DateTime.Utc) => {
  const minutes = Math.max(
    1,
    Math.round((DateTime.toEpochMillis(endedAt) - DateTime.toEpochMillis(startedAt)) / 60_000)
  )
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`
}

const sum = (sessions: ReadonlyArray<SessionSpend>, of: (session: SessionSpend) => number) =>
  sessions.reduce((total, session) => total + of(session), 0)

const sized = (steps: number, peakContext: number, unit = "") =>
  `${steps} ${steps === 1 ? "step" : "steps"}, up to ${tokens(peakContext)}${unit}`

const subagentName = ({ description, model, effort }: SessionSpend) => {
  const how = [model, effort].filter((part) => part !== undefined && part !== "").join(", ")
  const name = description === undefined ? "a subagent" : `"${description}"`
  return how === "" ? name : `${name} (${how})`
}

/**
 * What the previous turn used, session by session, since the agent can't see its own spending otherwise: the total
 * in dollars at list prices when they're known, each session's share with its steps and the most context it sent,
 * and, when it's large, the share spent re-sending sessions whose cache had lapsed. The system prompt's Usage
 * section tells the agent what this paragraph is.
 */
export const renderLastTurn = ({ startedAt, endedAt, priced, sessions, weekly }: LastTurn): string => {
  const total = sum(sessions, (session) => session.cost)
  if (total <= 0) return ""
  const share = (cost: number) => {
    const percent = (100 * cost) / total
    return percent < 1 ? "under 1%" : `${Math.round(percent)}%`
  }
  const own = sessions.filter((session) => session.own)
  const subagents = sessions.filter((session) => !session.own).sort((a, b) => b.cost - a.cost)
  const ownSize = sized(
    sum(own, (session) => session.steps),
    Math.max(0, ...own.map((session) => session.peakContext)),
    " tokens of context"
  )
  const rest = subagents.slice(3)
  const parts = [
    `Your last turn ran ${span(startedAt, endedAt)}${priced ? ` and came to about ${dollars(total)} at API prices` : ""}.`,
    ...(weekly !== undefined && weekly.after > weekly.before
      ? [
          `Their weekly window went from ${Math.round(weekly.before)}% to ${Math.round(weekly.after)}% while it ran, which counts anything else on their plan meanwhile.`
        ]
      : []),
    ...(own.length === 0
      ? []
      : subagents.length === 0
        ? [`It was all your own session: ${ownSize}.`]
        : [`Your own session was ${share(sum(own, (session) => session.cost))} of it: ${ownSize}.`]),
    ...(subagents.length === 0
      ? []
      : [
          `Subagents: ${[
            ...subagents
              .slice(0, 3)
              .map(
                (session) =>
                  `${subagentName(session)} ${share(session.cost)}, ${sized(session.steps, session.peakContext)}`
              ),
            ...(rest.length === 0
              ? []
              : [`${rest.length} more, ${share(sum(rest, (session) => session.cost))} together`])
          ].join("; ")}.`
        ]),
    ...(sum(sessions, (session) => session.recached) / total >= 0.1
      ? [
          `About ${share(sum(sessions, (session) => session.recached))} of it went to sending sessions afresh after a pause had let their cache lapse.`
        ]
      : [])
  ]
  return parts.join(" ")
}

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
