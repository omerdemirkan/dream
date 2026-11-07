/**
 * A running turn's harness events, condensed into steps a small model can read: "ran: Run the pronunciation tests
 * (failed)", "edited scorer.ts, lesson.tsx", "thought: …". This is all a progress line is written from, so it keeps
 * what says what the agent is doing and drops what could carry a secret: command lines are cut to their first plain
 * words (Claude Code's own description of a command is used instead when there is one), tool output is never kept,
 * and web fetches keep only the host.
 *
 * Pure: `observe` folds one part into the state; the clock comes in as `now` (epoch ms).
 */
import type { Part } from "../harness/Turn.ts"
import { fromImperative, fromSentence } from "./Phrase.ts"

export type StepKind =
  /** A shell command: Claude Code's description of it, or its first plain words. */
  | "command"
  /** Files read, edited or written, or the code searched. */
  | "files"
  | "web"
  /** A subagent started or finished, or its harness summarized what it's doing. */
  | "helper"
  /** The agent's own plan for the turn (Claude Code's `TodoWrite`). */
  | "plan"
  /** A summary of the model's reasoning (Claude Code's summarized thinking, Codex's reasoning summaries). */
  | "thought"
  /** What the model wrote between tool calls. */
  | "said"
  /** Something the person sees: a message, a question, the Status card (`dream …`). */
  | "dream"
  | "other"

export interface Step {
  readonly kind: StepKind
  /** When it started (epoch ms). */
  readonly at: number
  readonly text: string
  /** How many times in a row the same thing happened ("ran: Run the tests ×3"). */
  readonly count: number
  readonly failed: boolean
  /** A tool call whose result hasn't come back: it's still running. */
  readonly running: boolean
  /** For `files`: what was done to them. */
  readonly verb?: "read" | "edited" | "wrote" | "deleted" | "searched"
  readonly paths?: ReadonlyArray<string>
  readonly toolCallId?: string
  /** What this step could say to the person, if anything (see `Phrase.ts`), and how much it's worth saying. */
  readonly phrase?: string
  readonly score?: number
  /** Done by a subagent rather than the agent itself. */
  readonly helper?: boolean
}

export interface StepsState {
  readonly steps: ReadonlyArray<Step>
  /** Counts every new step (not repeats folded into the last one): the work moved on when it changes. */
  readonly version: number
  readonly reasoning: Readonly<Record<string, { readonly at: number; readonly text: string }>>
  readonly text: Readonly<Record<string, { readonly at: number; readonly text: string }>>
}

export const empty: StepsState = { steps: [], version: 0, reasoning: {}, text: {} }

/** Steps kept in memory; a window takes the last few. */
const kept = 40
const thoughtMax = 600
const saidMax = 300
const fieldMax = 120

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const squash = (text: string) => text.replace(/\s+/g, " ").trim()

/** At most `max` characters, cut at a word, marked as cut. */
export const clip = (text: string, max: number) => {
  const flat = squash(text)
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const space = cut.lastIndexOf(" ")
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** Looks like a credential: a long run of token characters, or a word that names one. */
const secretish = (token: string) =>
  /[A-Za-z0-9+/_=-]{24,}/.test(token) || /(token|secret|passw|apikey|api_key|bearer|authorization)/i.test(token)

const plainToken = /^[\w@./:+,-]+$/

/**
 * A command line, as its first plain words: `pnpm test`, `python scripts/score.py`, `git commit`. Stops at the
 * first pipe, redirect or `&&`, skips `cd …`, `export …` and leading `FOO=bar` settings, and drops anything quoted, anything with
 * `=`, URLs with queries, and anything that looks like a credential.
 */
export const commandWords = (command: string): string => {
  const segments = (command.split("\n")[0] ?? "")
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !/^(cd|export|source|\.)\s/.test(segment))
  const first = (segments[0] ?? "").split(/[<>]/)[0] ?? ""
  const words: Array<string> = []
  for (const token of first.split(/\s+/).filter(Boolean)) {
    if (words.length === 0 && token.includes("=")) continue
    if (!plainToken.test(token) || token.includes("=") || token.includes("?") || secretish(token)) break
    if (token.length > 40) break
    words.push(token)
    if (words.length === 4) break
  }
  return words.join(" ")
}

/** `dream message …` and friends: what the person sees happen. */
const dreamAction = (words: string): string | undefined => {
  const match = /^dream\s+([a-z-]+)/.exec(words)
  if (match === null) return undefined
  switch (match[1]) {
    case "message":
      return "sent them a message"
    case "ask":
      return "asked them a question"
    case "status":
      return "updated the Status card"
    case "publish":
      return "published the app"
    case "wake":
      return "scheduled a wake-up"
    case "live":
      return "updated the Live Activity"
    case "access":
      return "asked for access to a service"
    default:
      return `ran dream ${match[1]}`
  }
}

const fileName = (path: string) => {
  const parts = path.split("/").filter(Boolean)
  return parts.slice(-2).join("/") || path
}

const host = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return "a web page"
  }
}

const parseInput = (input: unknown): Record<string, unknown> => {
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input)
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

const str = (record: Record<string, unknown>, key: string) => {
  const value = record[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

type NewStep = Omit<Step, "at" | "count" | "failed" | "running">

/** Tools that say nothing about the work (waiting on output, finding tools), skipped. */
const quietTools = new Set(["Monitor", "TaskOutput", "TaskStop", "TaskGet", "TaskList", "ToolSearch", "Skill"])

const fromToolCall = (toolName: string, input: Record<string, unknown>): NewStep | undefined => {
  if (quietTools.has(toolName)) return undefined
  switch (toolName) {
    case "bash": {
      const command = str(input, "command") ?? ""
      const words = commandWords(command)
      const dream = dreamAction(words)
      if (dream !== undefined) {
        return dream === "published the app"
          ? { kind: "dream", text: dream, phrase: "Publishing the app", score: 3 }
          : { kind: "dream", text: dream }
      }
      const description = str(input, "description")
      if (description !== undefined) {
        return withPhrase(
          { kind: "command", text: clip(description.replace(/\.$/, ""), fieldMax) },
          fromImperative(description),
          2.5
        )
      }
      return { kind: "command", text: words.length > 0 ? `\`${words}\`` : "a command" }
    }
    case "read":
    case "NotebookRead":
      return fileStep("read", str(input, "file_path") ?? str(input, "path"))
    case "write":
      return fileStep("wrote", str(input, "file_path") ?? str(input, "path"))
    case "edit":
    case "MultiEdit":
    case "NotebookEdit":
      return fileStep("edited", str(input, "file_path") ?? str(input, "notebook_path") ?? str(input, "path"))
    case "fileChange": {
      const event = str(input, "event")
      return fileStep(event === "create" ? "wrote" : event === "delete" ? "deleted" : "edited", str(input, "path"))
    }
    case "glob":
    case "grep": {
      const pattern = str(input, "pattern")
      return {
        kind: "files",
        verb: "searched",
        paths: [],
        text: pattern === undefined || secretish(pattern) ? "the code" : `the code for “${clip(pattern, 40)}”`
      }
    }
    case "webSearch":
    case "WebSearch": {
      const query = str(input, "query")
      return {
        kind: "web",
        text: query === undefined ? "searched the web" : `searched the web for “${clip(query, 80)}”`
      }
    }
    case "WebFetch": {
      const url = str(input, "url")
      return { kind: "web", text: `read a page on ${url === undefined ? "the web" : host(url)}` }
    }
    case "Agent":
    case "Task": {
      const description = str(input, "description") ?? str(input, "prompt")
      return withPhrase(
        { kind: "helper", text: `started a helper: ${clip(description ?? "a task", fieldMax)}` },
        description === undefined ? undefined : fromImperative(description),
        3
      )
    }
    case "TodoWrite":
      return planStep(input)
    case "askUserQuestions":
    case "AskUserQuestion":
      return { kind: "dream", text: "asked them a question" }
    case "SendMessage":
      return { kind: "helper", text: "gave a helper more to do" }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName)
      if (mcp !== null) return { kind: "other", text: `used ${mcp[1]}'s ${mcp[2]}` }
      return { kind: "other", text: `used ${toolName}` }
    }
  }
}

const withPhrase = (step: NewStep, phrase: string | undefined, score: number): NewStep =>
  phrase === undefined ? step : { ...step, phrase, score }

/** The first sentence of a thought or narration that says what the agent is doing, as a phrase. */
const sentencePhrase = (text: string) => {
  for (const paragraph of text.split(/\n\s*\n/)) {
    for (const sentence of paragraph.trim().split(/(?<=[.!?])\s+/)) {
      const phrase = fromSentence(sentence)
      if (phrase !== undefined) return phrase
    }
  }
  return undefined
}

const fileStep = (verb: NonNullable<Step["verb"]>, path: string | undefined): NewStep => ({
  kind: "files",
  verb,
  paths: path === undefined ? [] : [fileName(path)],
  text: ""
})

const planStep = (input: Record<string, unknown>): NewStep | undefined => {
  const todos = Array.isArray(input.todos) ? input.todos : []
  const items = todos.flatMap((todo) => {
    const record = parseInput(todo)
    const content = str(record, "content")
    const status = str(record, "status")
    return content === undefined ? [] : [{ content, status, active: str(record, "activeForm") }]
  })
  if (items.length === 0) return undefined
  const done = items.filter((item) => item.status === "completed").length
  const current = items.find((item) => item.status === "in_progress")
  const next = current ?? items.find((item) => item.status !== "completed")
  const now = next === undefined ? "all done" : `now: ${clip(next.active ?? next.content, fieldMax)}`
  const phrase =
    current === undefined
      ? undefined
      : current.active !== undefined
        ? fromSentence(current.active)
        : fromImperative(current.content)
  return withPhrase({ kind: "plan", text: `plan ${done} of ${items.length} done, ${now}` }, phrase, 4)
}

/** The text a files step renders as: "edited scorer.ts, lesson.tsx". */
export const filesText = (step: Step) => {
  if (step.verb === "searched") return `searched ${step.text}`
  const paths = step.paths ?? []
  const shown = paths.slice(-4)
  const more = paths.length - shown.length
  const list = shown.length === 0 ? "a file" : shown.join(", ") + (more > 0 ? ` and ${more} more` : "")
  return `${step.verb ?? "touched"} ${list}`
}

// ---------------------------------------------------------------------------
// Folding parts in
// ---------------------------------------------------------------------------

const sameWork = (last: Step, next: NewStep) =>
  last.kind === next.kind &&
  !last.running &&
  ((next.kind === "files" && last.verb === next.verb && next.verb !== "searched") ||
    (next.kind !== "files" && next.kind !== "plan" && last.text === next.text))

/** Steps that take a while, so "still running" says something: commands and helpers. */
const runs = (step: NewStep) => step.kind === "command" || (step.kind === "helper" && step.text.startsWith("started"))

const push = (state: StepsState, next: NewStep, now: number, toolCallId?: string): StepsState => {
  const last = state.steps.at(-1)
  if (last !== undefined && sameWork(last, next)) {
    const merged: Step = {
      ...last,
      count: next.kind === "files" ? last.count : last.count + 1,
      failed: false,
      running: toolCallId !== undefined && runs(next),
      ...(next.kind === "files"
        ? { paths: [...(last.paths ?? []).filter((path) => !(next.paths ?? []).includes(path)), ...(next.paths ?? [])] }
        : {}),
      ...(toolCallId === undefined ? {} : { toolCallId })
    }
    return { ...state, steps: [...state.steps.slice(0, -1), merged] }
  }
  const step: Step = {
    ...next,
    at: now,
    count: 1,
    failed: false,
    running: toolCallId !== undefined && runs(next),
    ...(toolCallId === undefined ? {} : { toolCallId })
  }
  return { ...state, steps: [...state.steps, step].slice(-kept), version: state.version + 1 }
}

const settle = (state: StepsState, toolCallId: string, failed: boolean, now: number): StepsState => {
  const index = state.steps.findLastIndex((step) => step.toolCallId === toolCallId)
  if (index < 0) return state
  const step = state.steps[index]!
  const helperDone = step.kind === "helper" && step.text.startsWith("started a helper: ")
  const settled: Step = { ...step, running: false, failed: step.failed || failed }
  const steps = [...state.steps]
  steps[index] = settled
  const next = { ...state, steps }
  // A helper finishing is news of its own.
  return helperDone && !failed
    ? push(next, { kind: "helper", text: step.text.replace("started a helper: ", "a helper finished: ") }, now)
    : next
}

/** Closes a reasoning or text block into a step. */
const closeBlock = (state: StepsState, which: "reasoning" | "text", id: string, now: number): StepsState => {
  const open = state[which][id]
  if (open === undefined) return state
  const { [id]: _, ...rest } = state[which]
  const without = { ...state, [which]: rest }
  if (squash(open.text).length === 0) return without
  const pushed = push(without, blockStep(which === "reasoning" ? "thought" : "said", open.text), now)
  // The step starts when the block did.
  const last = pushed.steps.at(-1)!
  return { ...pushed, steps: [...pushed.steps.slice(0, -1), { ...last, at: Math.min(last.at, open.at) }] }
}

/** Closes every open block: a tool call or the end of the turn means the model stopped writing them. */
const closeAll = (state: StepsState, now: number) => {
  let next = state
  for (const id of Object.keys(next.reasoning)) next = closeBlock(next, "reasoning", id, now)
  for (const id of Object.keys(next.text)) next = closeBlock(next, "text", id, now)
  return next
}

const blockStep = (kind: "thought" | "said", text: string): NewStep =>
  withPhrase(
    { kind, text: clip(text, kind === "thought" ? thoughtMax : saidMax) },
    kind === "thought" ? sentencePhrase(text) : fromSentence(squash(text)),
    3
  )

/** Claude Code's native tool names, as the adapter names them in `tool-call` parts. */
const commonName: Readonly<Record<string, string>> = {
  Bash: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
  WebSearch: "webSearch"
}

const helperStep = (step: NewStep): NewStep => ({ ...step, helper: true })

/** The step a turn held for background work shows (`harness/Background.ts`), running until the hold ends. */
const holdId = "dream-background-hold"

/** What a held turn waits on, as a phrase: "Waiting for 2 helpers to report back". */
export const holdPhrase = (types: ReadonlyArray<string | undefined>): string => {
  const helpers = types.filter((type) => type === "local_agent" || type === "subagent").length
  const commands = types.filter((type) => type === "local_bash").length
  if (helpers === types.length) {
    return helpers === 1 ? "Waiting for a helper to report back" : `Waiting for ${helpers} helpers to report back`
  }
  if (commands === types.length) {
    return commands === 1 ? "Waiting for a command to finish" : `Waiting for ${commands} commands to finish`
  }
  return "Waiting for background work to finish"
}

/** The bridges' report on background work: while the turn is held for it, that's what it's doing. */
const observeHold = (state: StepsState, record: Record<string, unknown>, now: number): StepsState => {
  const live = Array.isArray(record.live) ? record.live.map((task) => str(parseInput(task), "type")) : []
  const open = state.steps.some((step) => step.toolCallId === holdId && step.running)
  if (record.holding === true && live.length > 0) {
    if (open) return state
    return push(
      state,
      withPhrase({ kind: "command", text: "waiting for background work to report back" }, holdPhrase(live), 3),
      now,
      holdId
    )
  }
  return open ? settle(state, holdId, false, now) : state
}

/**
 * A raw harness message: a subagent's own messages (Claude Code forwards their tool calls, and their thinking and
 * text with `forwardSubagentText`), and its progress summaries (`agentProgressSummaries`, written by Claude Code).
 */
const observeRaw = (state: StepsState, raw: unknown, now: number): StepsState => {
  const record = parseInput(raw)
  if (record.type === "dream_background") return observeHold(state, record, now)
  if (record.type === "system" && record.subtype === "task_progress") {
    const summary = str(record, "summary") ?? str(record, "description")
    if (summary === undefined) return state
    return push(
      state,
      helperStep(
        withPhrase({ kind: "helper", text: `a helper is ${clip(summary, fieldMax)}` }, fromSentence(summary), 3.5)
      ),
      now
    )
  }
  if (record.parent_tool_use_id === undefined || record.parent_tool_use_id === null) return state
  const message = parseInput(record.message)
  const content = Array.isArray(message.content) ? message.content : []
  let next = state
  for (const item of content) {
    const block = parseInput(item)
    if (record.type === "assistant" && (block.type === "thinking" || block.type === "text")) {
      const text = str(block, block.type === "thinking" ? "thinking" : "text")
      if (text !== undefined)
        next = push(next, helperStep(blockStep(block.type === "thinking" ? "thought" : "said", text)), now)
    } else if (record.type === "assistant" && block.type === "tool_use") {
      const name = str(block, "name") ?? "unknown"
      const step = fromToolCall(commonName[name] ?? name, parseInput(block.input))
      if (step !== undefined) next = push(next, helperStep(step), now, str(block, "id"))
    } else if (record.type === "user" && block.type === "tool_result") {
      const id = str(block, "tool_use_id")
      if (id !== undefined) next = settle(next, id, block.is_error === true, now)
    }
  }
  return next
}

export const observe = (state: StepsState, part: Part, now: number): StepsState => {
  switch (part.type) {
    case "reasoning-start":
      return { ...state, reasoning: { ...state.reasoning, [part.id]: { at: now, text: "" } } }
    case "reasoning-delta": {
      const open = state.reasoning[part.id] ?? { at: now, text: "" }
      return { ...state, reasoning: { ...state.reasoning, [part.id]: { ...open, text: open.text + part.text } } }
    }
    case "reasoning-end":
      return closeBlock(state, "reasoning", part.id, now)
    case "text-start":
      return { ...state, text: { ...state.text, [part.id]: { at: now, text: "" } } }
    case "text-delta": {
      const open = state.text[part.id] ?? { at: now, text: "" }
      return { ...state, text: { ...state.text, [part.id]: { ...open, text: open.text + part.text } } }
    }
    case "text-end":
      return closeBlock(state, "text", part.id, now)
    case "tool-call": {
      const closed = closeAll(state, now)
      const step = fromToolCall(part.toolName, parseInput(part.input))
      return step === undefined ? closed : push(closed, step, now, part.toolCallId)
    }
    case "tool-result": {
      const output = parseInput(part.output)
      const exitCode = output.exitCode
      return settle(state, part.toolCallId, typeof exitCode === "number" && exitCode !== 0, now)
    }
    case "tool-error":
      return settle(state, part.toolCallId, true, now)
    case "raw":
      return observeRaw(state, part.rawValue, now)
    default:
      return state
  }
}

/** Every step, with open reasoning and text blocks closed as they stand. */
export const current = (state: StepsState, now: number): ReadonlyArray<Step> => closeAll(state, now).steps
