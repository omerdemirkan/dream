/**
 * Turns recorded Claude Code sessions into the evaluation's fixtures: every turn of three minutes or more, as timed
 * stream parts, keeping only what progress lines are made from and nothing that could hold a secret. Commands are
 * cut to their first plain words (`commandWords`), tool output is dropped, web fetches keep only the host, and
 * email addresses, long token-like strings and URL queries are blanked in any text.
 *
 *   node packages/dreamd/scripts/progress-eval/extract.ts <name>=<dir> …
 *
 * Each <dir> holds a session's transcript (`~/.claude/projects/<project>/<session>.jsonl`) and, in `sub/`, its
 * subagents' transcripts. Writes packages/dreamd/test/fixtures/progress/<name>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { commandWords } from "../../src/progress/Steps.ts"
import { recordedTurns } from "./transcript.ts"

const out = join(import.meta.dirname, "../../test/fixtures/progress")

const redact = (text: string) =>
  text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "<redacted>")
    .replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/g, "$1")

const host = (url: unknown) => {
  try {
    return `https://${new URL(String(url)).host}`
  } catch {
    return undefined
  }
}

type Record_ = Record<string, unknown>

/** A tool call's input, keeping only what `Steps.ts` reads. */
const keepInput = (name: string, input: Record_): Record_ => {
  const pick = (...keys: ReadonlyArray<string>) =>
    Object.fromEntries(keys.flatMap((key) => (typeof input[key] === "string" ? [[key, redact(input[key])]] : [])))
  switch (name) {
    case "bash":
    case "Bash":
      return {
        command: commandWords(String(input.command ?? "")),
        ...(typeof input.description === "string" ? { description: redact(input.description) } : {})
      }
    case "read":
    case "write":
    case "edit":
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return pick("file_path")
    case "glob":
    case "grep":
    case "Glob":
    case "Grep":
      return pick("pattern")
    case "webSearch":
    case "WebSearch":
      return pick("query")
    case "WebFetch":
      return { url: host(input.url) }
    case "Agent":
    case "Task":
      return pick("description")
    case "TodoWrite":
      return {
        todos: Array.isArray(input.todos)
          ? input.todos.map((todo: Record_) => ({
              content: redact(String(todo.content ?? "")),
              status: todo.status,
              activeForm: redact(String(todo.activeForm ?? ""))
            }))
          : []
      }
    default:
      return {}
  }
}

const keepBlock = (block: Record_): Record_ | undefined => {
  switch (block.type) {
    case "thinking":
      return { type: "thinking", thinking: redact(String(block.thinking ?? "")) }
    case "text":
      return { type: "text", text: redact(String(block.text ?? "")) }
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: keepInput(String(block.name), (block.input ?? {}) as Record_)
      }
    case "tool_result":
      return { type: "tool_result", tool_use_id: block.tool_use_id, is_error: block.is_error === true }
    default:
      return undefined
  }
}

const keepPart = (part: Record_): Record_ => {
  switch (part.type) {
    case "reasoning-delta":
    case "text-delta":
      return { ...part, text: redact(String(part.text ?? "")) }
    case "tool-call":
      return { ...part, input: keepInput(String(part.toolName), (part.input ?? {}) as Record_) }
    case "raw": {
      const raw = part.rawValue as Record_
      const message = (raw.message ?? {}) as Record_
      const content = Array.isArray(message.content) ? message.content : []
      return {
        type: "raw",
        rawValue: {
          type: raw.type,
          parent_tool_use_id: raw.parent_tool_use_id,
          message: { content: content.flatMap((block: Record_) => keepBlock(block) ?? []) }
        }
      }
    }
    default:
      return part
  }
}

mkdirSync(out, { recursive: true })
for (const arg of process.argv.slice(2)) {
  const [name, dir] = arg.split("=")
  if (name === undefined || dir === undefined) throw new Error(`expected <name>=<dir>, got ${arg}`)
  const turns = recordedTurns(name, dir)
    .filter((turn) => turn.endedAt - turn.startedAt >= 3 * 60_000)
    .map((turn) => ({
      project: name,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      trigger: turn.trigger === undefined ? undefined : redact(turn.trigger),
      parts: turn.parts
        .map(({ at, part }) => ({ at: at - turn.startedAt, part: keepPart(part as unknown as Record_) }))
        .filter(
          ({ part }) =>
            part.type !== "raw" ||
            ((part.rawValue as Record_).message as { content: Array<unknown> }).content.length > 0
        )
    }))
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify({ project: name, turns }, null, 1)}\n`)
  console.log(`${name}: ${turns.length} turns, ${turns.reduce((n, turn) => n + turn.parts.length, 0)} parts`)
}
