/**
 * A recorded Claude Code session (its JSONL transcript and its subagents'), replayed as the timed stream parts
 * dreamd's harness adapter would have delivered: the agent's thinking, text and tool calls as parts, and each
 * subagent's messages as `raw` parts carrying `parent_tool_use_id` (what the adapter forwards with
 * `forwardSubagentText`). Split into turns at dreamd's turn prompts ("It's Friday, …").
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Part } from "../../src/harness/Turn.ts"

export interface TimedPart {
  readonly at: number
  readonly part: Part
}

export interface RecordedTurn {
  readonly project: string
  readonly startedAt: number
  readonly endedAt: number
  /** The person's message that started it, if one did. */
  readonly trigger: string | undefined
  readonly parts: ReadonlyArray<TimedPart>
}

type Row = {
  readonly type?: string
  readonly timestamp?: string
  readonly message?: { readonly content?: unknown }
}
type Block = Record<string, unknown>

const commonName: Readonly<Record<string, string>> = {
  Bash: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
  WebSearch: "webSearch"
}

const rows = (file: string): ReadonlyArray<Row> =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Row)

const blocks = (row: Row): ReadonlyArray<Block> =>
  Array.isArray(row.message?.content) ? (row.message.content as ReadonlyArray<Block>) : []

const time = (row: Row) => Date.parse(row.timestamp ?? "")

let ids = 0

/** The parts one transcript row stands for. */
const partsOf = (row: Row): ReadonlyArray<Part> => {
  const parts: Array<Part> = []
  for (const block of blocks(row)) {
    const id = `b${++ids}`
    if (row.type === "assistant" && block.type === "thinking" && typeof block.thinking === "string") {
      parts.push({ type: "reasoning-start", id } as Part)
      parts.push({ type: "reasoning-delta", id, text: block.thinking } as Part)
      parts.push({ type: "reasoning-end", id } as Part)
    } else if (row.type === "assistant" && block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text-start", id } as Part)
      parts.push({ type: "text-delta", id, text: block.text } as Part)
      parts.push({ type: "text-end", id } as Part)
    } else if (row.type === "assistant" && block.type === "tool_use") {
      const name = String(block.name)
      parts.push({
        type: "tool-call",
        toolCallId: String(block.id),
        toolName: commonName[name] ?? name,
        input: block.input,
        providerExecuted: true
      } as unknown as Part)
    } else if (row.type === "user" && block.type === "tool_result") {
      parts.push(
        (block.is_error === true
          ? {
              type: "tool-error",
              toolCallId: String(block.tool_use_id),
              toolName: "",
              error: "",
              providerExecuted: true
            }
          : {
              type: "tool-result",
              toolCallId: String(block.tool_use_id),
              toolName: "",
              output: "",
              providerExecuted: true
            }) as unknown as Part
      )
    }
  }
  return parts
}

const promptText = (row: Row) => {
  const content = row.message?.content
  return typeof content === "string"
    ? content
    : blocks(row)
        .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
        .join("\n")
}

/** dreamd's turn prompts start "It's <weekday>, <date> at <time> where they are". */
const isTurnPrompt = (row: Row) => row.type === "user" && /^It's \w+day, /.test(promptText(row))

const triggerOf = (prompt: string) => {
  const quoted = /They wrote \([^)]*\):\n([\s\S]*?)(\n\n|$)/.exec(prompt)
  return quoted === null ? undefined : quoted[1]!.replace(/^>\s?/gm, "").trim()
}

/** Every turn in `dir`: the session transcript, with `sub/` holding its subagents' transcripts. */
export const recordedTurns = (project: string, dir: string): ReadonlyArray<RecordedTurn> => {
  const main = readdirSync(dir).find((name) => name.endsWith(".jsonl"))
  if (main === undefined) return []
  const top = rows(join(dir, main))
  const subDir = join(dir, "sub")
  let subs: ReadonlyArray<Row> = []
  try {
    subs = readdirSync(subDir)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => rows(join(subDir, name)).map((row) => ({ ...row, sub: name })))
  } catch {
    subs = []
  }
  const starts = top.filter(isTurnPrompt)
  return starts.map((start, index) => {
    const startedAt = time(start)
    const next = starts[index + 1]
    const until = next === undefined ? Number.POSITIVE_INFINITY : time(next)
    const own = top.filter((row) => time(row) >= startedAt && time(row) < until)
    const endedAt = Math.max(...own.filter((row) => row.type === "assistant").map(time), startedAt)
    const parts: Array<TimedPart> = []
    for (const row of own) for (const part of partsOf(row)) parts.push({ at: time(row), part })
    for (const row of subs) {
      const at = time(row)
      if (at < startedAt || at > endedAt || (row.type !== "assistant" && row.type !== "user")) continue
      parts.push({
        at,
        part: {
          type: "raw",
          rawValue: { type: row.type, message: row.message, parent_tool_use_id: "recorded" }
        } as unknown as Part
      })
    }
    parts.sort((a, b) => a.at - b.at)
    return { project, startedAt, endedAt, trigger: triggerOf(promptText(start)), parts }
  })
}
