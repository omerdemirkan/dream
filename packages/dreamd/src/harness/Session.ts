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
 */
import { createHash } from "node:crypto"
import { type HandoffInput, renderGuidanceNote, renderHandoff } from "@dream/agent-context"
import { Harness as HarnessName } from "@dream/domain"
import { Effect, Option, Schema } from "effect"
import * as Usage from "../Usage.ts"
import type { Skill } from "./Skill.ts"

/** Which guidance a conversation runs on, as hashes of the system prompt and of the skills together. */
export const Guidance = Schema.Struct({ prompt: Schema.String, skill: Schema.String })
export type Guidance = typeof Guidance.Type

export const SavedSession = Schema.Struct({
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
  preamble: Schema.optionalKey(Schema.String)
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
  ...(session.preamble === undefined ? {} : { preamble: session.preamble })
})

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
  const recent: Array<HandoffInput["recent"][number]> = []
  let budget = quoted.totalChars
  for (const message of messages.slice(-quoted.messages).reverse()) {
    if (budget <= 0) break
    const text = clip(message.text, Math.min(quoted.messageChars, budget))
    recent.unshift({ ...message, text })
    budget -= text.length
  }
  return recent
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
