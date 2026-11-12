/**
 * What dreamd keeps of the agent's harness session (`session.json` in its state dir), and how new guidance from
 * Dream (the system prompt and Dream's skills, which a template refresh brings) reaches it.
 *
 * Neither harness changes a conversation's instructions once it has started: Claude Code sends the system prompt it
 * recorded on the conversation's first request, and a Codex thread keeps its developer instructions, until the
 * conversation compacts. So:
 *
 *   - Claude Code's bridge renders the prompt on every request instead (`bridgePatches` in `Bridges.ts`), so the
 *     session keeps its conversation and gets the new prompt; its next turn starts with a note saying so.
 *   - A Codex thread can't take them, and its adapter would start a new thread on its own when the instructions or
 *     skills change, with no word of the old one. dreamd starts it instead, with a handoff from the old thread's
 *     log: where the log is, and how the conversation ended.
 *
 * A project moved to another plan (`AppRpcs.SwitchPlan`) runs on another harness, which can't resume the old one's
 * conversation at all. dreamd starts a new one there, opening with what it can read of the old without a model
 * (`planHandoff`): where its log is, the summary the old harness wrote when it last compacted (Claude Code's is
 * plain text; Codex's, made on OpenAI's side, usually isn't), and how it ended. The handoff the old agent wrote, and
 * the rest, come in the turn's `PlanSwitched` event.
 *
 * The session also keeps the concrete model its turns run on. A project's choice is a family, so a CLI release can
 * move it to a newer model between turns (Fable 5.1 to 5.2), and so can their choosing another; either way the next
 * turn opens with a sentence saying so (`onModel`).
 */
import { createHash } from "node:crypto"
import {
  type HandoffInput,
  renderGuidanceNote,
  renderHandoff,
  renderModelNote,
  renderPlanHandoff
} from "@dream/agent-context"
import { Harness as HarnessName } from "@dream/domain"
import { Effect, FileSystem, Option, Path, Schema } from "effect"
import * as Usage from "../Usage.ts"
import type { Skill } from "./Skill.ts"

/** Which guidance a conversation runs on, as hashes of the system prompt and of the skills together. */
export const Guidance = Schema.Struct({ prompt: Schema.String, skill: Schema.String })
export type Guidance = typeof Guidance.Type

const sessionFields = {
  harness: HarnessName,
  sessionId: Schema.String,
  resumeFrom: Schema.optionalKey(
    Schema.Struct({
      type: Schema.Literal("resume-session"),
      harnessId: Schema.String,
      specificationVersion: Schema.Literal("harness-v1"),
      data: Schema.MutableJson
    })
  ),
  /** The guidance the conversation runs on; missing in a session saved before dreamd kept it. */
  guidance: Schema.optionalKey(Guidance),
  /** Said before the next turn's prompt, until a turn gets going: what changed (a note, or a handoff). */
  preamble: Schema.optionalKey(Schema.String),
  /**
   * The concrete model the conversation's turns run on (`claude-fable-5-2`), as the installed CLI's list says
   * (`Models.ts`); missing in a session saved before dreamd kept it.
   */
  model: Schema.optionalKey(Schema.String)
}

export const SavedSession = Schema.Struct({
  ...sessionFields,
  /**
   * The session on the harness the project moved from (`switchTo`), kept so that moving back before this
   * conversation began (a move that failed and was put back, say) goes on with it as if nothing happened.
   */
  previous: Schema.optionalKey(Schema.Struct(sessionFields))
})
export type SavedSession = typeof SavedSession.Type

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16)

export const guidanceOf = (instructions: string, skills: ReadonlyArray<Skill>): Guidance => ({
  prompt: digest(instructions),
  skill: digest(JSON.stringify(skills.map((skill) => [skill.name, skill.description, skill.content])))
})

/** The same session as a new conversation, under `sessionId`. */
export const restart = (session: SavedSession, sessionId: string): SavedSession => ({
  harness: session.harness,
  sessionId,
  ...(session.guidance === undefined ? {} : { guidance: session.guidance }),
  ...(session.preamble === undefined ? {} : { preamble: session.preamble }),
  ...(session.model === undefined ? {} : { model: session.model })
})

/**
 * The session running on `model` (a concrete id), and if that's a change from what it ran on (`was`, for a session
 * saved before dreamd kept its model: what the last turn's own steps were on), a note before the next turn's prompt.
 * A project's choice is a family, so this is usually a CLI release moving the family to a newer model.
 */
export const onModel = (
  session: SavedSession,
  harness: HarnessName,
  model: string,
  was: string | undefined
): Option.Option<SavedSession> => {
  const before = session.model ?? was
  if (session.model === model) return Option.none()
  if (before === undefined || before === model) return Option.some({ ...session, model })
  const note = renderModelNote({ harness, model, was: before })
  return Option.some({
    ...session,
    model,
    preamble: session.preamble === undefined ? note : `${session.preamble}\n${note}`
  })
}

/** The session once a turn got going: nothing left to say first. */
export const delivered = (session: SavedSession): SavedSession => {
  if (session.preamble === undefined) return session
  const { preamble: _, ...rest } = session
  return rest
}

/**
 * The session on `guidance`, if that's a change: the same conversation with a note (Claude Code), or a new one,
 * `newSessionId`, with `handoff` (Codex). A conversation that hasn't started yet just takes it.
 */
export const carryOver = Effect.fn("Session.carryOver")(function* (
  session: SavedSession,
  guidance: Guidance,
  options: { readonly newSessionId: string; readonly handoff: Effect.Effect<string> }
) {
  const was = session.guidance
  if (was?.prompt === guidance.prompt && was.skill === guidance.skill) return Option.none<SavedSession>()
  if (session.resumeFrom === undefined) return Option.some<SavedSession>({ ...session, guidance })
  if (session.harness === "claude-code") {
    // A note still waiting was about an earlier change, which this one's note has to cover too.
    const changed =
      was === undefined || session.preamble !== undefined
        ? { prompt: true, skill: true }
        : { prompt: was.prompt !== guidance.prompt, skill: was.skill !== guidance.skill }
    return Option.some<SavedSession>({ ...session, guidance, preamble: renderGuidanceNote(changed) })
  }
  // A handoff still waiting describes the conversation that had the context; the one it replaced has none.
  const preamble = session.preamble ?? (yield* options.handoff)
  return Option.some<SavedSession>({ ...restart(session, options.newSessionId), guidance, preamble })
})

// ---------------------------------------------------------------------------
// The Codex handoff
// ---------------------------------------------------------------------------

/** How much of the old conversation the handoff quotes: its last messages, each cut short, within a budget. */
const quoted = { messages: 12, messageChars: 2_000, totalChars: 12_000 }

/** What Codex adds to a conversation's first user message (its environment and AGENTS.md), not said by Dream. */
const codexContext = ["<environment_context>", "<user_instructions>", "# AGENTS.md"]

const RolloutMessage = Schema.Struct({
  type: Schema.Literal("response_item"),
  payload: Schema.Struct({
    type: Schema.Literal("message"),
    role: Schema.String,
    content: Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) }))
  })
})
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(RolloutMessage))

const clip = (text: string, chars: number) => (text.length <= chars ? text : `${text.slice(0, chars).trimEnd()} […]`)

/**
 * A quoted message cut short in the middle: how it opens and, mostly, how it ends. A turn's prompt ends with what woke
 * the agent, and the first prompt of a conversation that took over from another opens with that one's handoff, which
 * would otherwise crowd out the rest.
 */
const clipMiddle = (text: string, chars: number) => {
  if (text.length <= chars) return text
  const head = Math.floor(chars * 0.3)
  return `${text.slice(0, head).trimEnd()} […] ${text.slice(text.length - (chars - head)).trimStart()}`
}

/** The last of `messages` (oldest first), each cut short, within the budget. */
const lastOf = (messages: HandoffInput["recent"]): HandoffInput["recent"] => {
  const recent: Array<HandoffInput["recent"][number]> = []
  let budget = quoted.totalChars
  for (const message of messages.slice(-quoted.messages).reverse()) {
    if (budget <= 0) break
    const text = clipMiddle(message.text, Math.min(quoted.messageChars, budget))
    recent.unshift({ ...message, text })
    budget -= text.length
  }
  return recent
}

/** The last exchanges of a Codex rollout (or the tail of one): Dream's prompts and the agent's messages. */
export const recentExchanges = (rollout: string): HandoffInput["recent"] => {
  const messages = rollout.split("\n").flatMap((line): HandoffInput["recent"] => {
    if (!line.includes('"response_item"')) return []
    const decoded = decodeMessage(line)
    if (Option.isNone(decoded)) return []
    const { role, content } = decoded.value.payload
    const text = content
      .map((part) => part.text ?? "")
      .join("\n")
      .trim()
    if (text === "") return []
    if (role === "assistant") return [{ from: "you" as const, text }]
    if (role === "user" && !codexContext.some((prefix) => text.startsWith(prefix))) {
      return [{ from: "dream" as const, text }]
    }
    return []
  })
  return lastOf(messages)
}

/** The handoff from the Codex thread `threadId`, from its rollout under `codexHome`, as far as it can be read. */
export const codexHandoff = (codexHome: string, threadId: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isNone(threadId)) return renderHandoff({ recent: [] })
    const log = yield* Usage.findCodexRollout(codexHome, threadId.value)
    if (Option.isNone(log)) return renderHandoff({ recent: [] })
    return renderHandoff({ log: log.value, recent: recentExchanges(yield* Usage.readTail(log.value)) })
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Couldn't read the old Codex thread for its handoff", { error: String(error) }).pipe(
        Effect.as(renderHandoff({ recent: [] }))
      )
    )
  )

// ---------------------------------------------------------------------------
// The handoff to another harness
// ---------------------------------------------------------------------------

/** How much of a harness's own summary the handoff quotes. */
const summaryChars = 24_000

/** How much of the end of a Claude Code transcript is read for the handoff: its last compaction is usually in it. */
const claudeTail = 16 * 1024 * 1024

const CodexCompacted = Schema.Struct({
  type: Schema.Literal("compacted"),
  payload: Schema.Struct({ message: Schema.optionalKey(Schema.String) })
})
const decodeCompacted = Schema.decodeUnknownOption(Schema.fromJsonString(CodexCompacted))

/** The summary in a Codex rollout's last compaction, when it's readable (a compaction made locally writes one). */
export const codexSummary = (rollout: string): Option.Option<string> => {
  let summary = Option.none<string>()
  for (const line of rollout.split("\n")) {
    if (!line.includes('"compacted"')) continue
    const decoded = decodeCompacted(line)
    if (Option.isNone(decoded)) continue
    const message = decoded.value.payload.message?.trim() ?? ""
    summary = message === "" ? Option.none() : Option.some(message)
  }
  return summary
}

const ClaudeLine = Schema.Struct({
  type: Schema.Literals(["user", "assistant"]),
  isCompactSummary: Schema.optionalKey(Schema.Boolean),
  isMeta: Schema.optionalKey(Schema.Boolean),
  isSidechain: Schema.optionalKey(Schema.Boolean),
  message: Schema.Struct({
    content: Schema.Union([
      Schema.String,
      Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }))
    ])
  })
})
const decodeClaudeLine = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeLine))

/** What Claude Code adds to the conversation itself (reminders, command echoes), not said by Dream. */
const claudeContext = ["<system-reminder>", "<command-", "<local-command-", "Caveat: "]

/**
 * A Claude Code transcript (or the tail of one), read for the handoff: its last exchanges, Dream's prompts and the
 * agent's text, and the summary its last compaction wrote.
 */
export const claudeTranscript = (
  transcript: string
): { readonly recent: HandoffInput["recent"]; readonly summary: Option.Option<string> } => {
  let summary = Option.none<string>()
  const messages: Array<HandoffInput["recent"][number]> = []
  for (const line of transcript.split("\n")) {
    if (!line.includes('"message"')) continue
    const decoded = decodeClaudeLine(line)
    if (Option.isNone(decoded)) continue
    const { type, isCompactSummary, isMeta, isSidechain, message } = decoded.value
    if (isMeta === true || isSidechain === true) continue
    const text = (
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n")
    ).trim()
    if (text === "") continue
    if (isCompactSummary === true) {
      summary = Option.some(text)
      // What it summarized came before; the exchanges that count are the ones after it.
      messages.length = 0
      continue
    }
    if (type === "assistant") messages.push({ from: "you", text })
    else if (!claudeContext.some((prefix) => text.startsWith(prefix))) messages.push({ from: "dream", text })
  }
  return { recent: lastOf(messages), summary }
}

/** The file Claude Code keeps conversation `sessionId` in, under `home`. */
export const findClaudeTranscript = Effect.fn("Session.findClaudeTranscript")(function* (
  home: string,
  sessionId: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const projects = path.join(home, ".claude", "projects")
  if (!(yield* fs.exists(projects))) return Option.none<string>()
  for (const project of yield* fs.readDirectory(projects)) {
    const file = path.join(projects, project, `${sessionId}.jsonl`)
    if (yield* fs.exists(file)) return Option.some(file)
  }
  return Option.none<string>()
})

/** A string the adapter keeps in a saved session's resume state: Codex's `threadId`, Claude Code's `claudeSessionId`. */
export const resumeString = (session: SavedSession, key: string): Option.Option<string> => {
  const data = session.resumeFrom?.data
  const value = typeof data === "object" && data !== null && !Array.isArray(data) ? data[key] : undefined
  return typeof value === "string" ? Option.some(value) : Option.none()
}

/**
 * The handoff into a new conversation on `to` from `previous`, a session on another harness, as far as its log can
 * be read under `home`.
 */
export const planHandoff = (previous: SavedSession, to: HarnessName, home: string) =>
  Effect.gen(function* () {
    const from = previous.harness
    const read = Effect.gen(function* () {
      if (from === "codex") {
        const threadId = resumeString(previous, "threadId")
        if (Option.isNone(threadId)) return { recent: [] }
        const log = yield* Usage.findCodexRollout(`${home}/.codex`, threadId.value)
        if (Option.isNone(log)) return { recent: [] }
        const rollout = yield* Usage.readTail(log.value, claudeTail)
        return {
          log: log.value,
          recent: recentExchanges(rollout),
          summary: Option.getOrUndefined(codexSummary(rollout))
        }
      }
      const sessionId = resumeString(previous, "claudeSessionId")
      if (Option.isNone(sessionId)) return { recent: [] }
      const log = yield* findClaudeTranscript(home, sessionId.value)
      if (Option.isNone(log)) return { recent: [] }
      const { recent, summary } = claudeTranscript(yield* Usage.readTail(log.value, claudeTail))
      return { log: log.value, recent, summary: Option.getOrUndefined(summary) }
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Couldn't read the old conversation for the handoff", { error: String(error) }).pipe(
          Effect.as({ recent: [] })
        )
      )
    )
    const found: { log?: string; recent: HandoffInput["recent"]; summary?: string | undefined } = yield* read
    return renderPlanHandoff({
      from,
      to,
      ...(found.log === undefined ? {} : { log: found.log }),
      ...(found.summary === undefined ? {} : { summary: clip(found.summary, summaryChars) }),
      recent: found.recent
    })
  })

/**
 * The session for `harness` from the one saved, which ran on another: a new conversation, `sessionId`, that opens
 * with `handoff` (and keeps the one it left). Moved back before that conversation began, it's the one it left again.
 */
export const switchTo = <R>(
  saved: SavedSession,
  harness: HarnessName,
  sessionId: string,
  handoff: Effect.Effect<string, never, R>
): Effect.Effect<SavedSession, never, R> => {
  if (saved.resumeFrom === undefined && saved.previous?.harness === harness) return Effect.succeed(saved.previous)
  const { previous: _, ...left } = saved
  return Effect.map(handoff, (preamble) => ({ harness, sessionId, preamble, previous: left }))
}
