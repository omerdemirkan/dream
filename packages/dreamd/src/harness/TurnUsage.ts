/**
 * What one turn used of the model, sent with `ReportTurn` "finished" (`TurnUsage` in the domain).
 *
 * - The agent's own tokens come from each stream's `finish` part (`totalUsage`), or, for a stream that ended
 *   without one, the sum of its steps. A turn can have several streams (question-tool continuations), which add up.
 * - Neither harness counts subagents there (`scripts/usage-probe.ts` with the fake model servers shows it): Claude
 *   Code's total is its `result` messages', the top-level conversation's; Codex adds up only the active thread's
 *   `thread/tokenUsage/updated`. So subagents' tokens are read from the files the CLIs keep: Claude Code's subagent
 *   transcripts (`~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`, an `assistant` entry per
 *   content block, each with its message's final usage), and Codex's rollouts, where every response is a
 *   `token_usage_record` naming its thread and its root thread (`session_id`). A ledger of how far each file has been
 *   read counts every response once, in the turn that ends after it, so what a background subagent does after its
 *   turn ended counts toward the next.
 * - Claude Code's `costUsd` is the session's running total (it carries over when the CLI restarts on a resumed
 *   session) and includes subagents, so the turn's cost is how much it rose.
 */
import type { Harness, TokenUsage, TurnUsage } from "@dream/domain"
import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect"
import * as JsonFile from "../JsonFile.ts"

export const noTokens: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

export const addTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output
})

const count = (value: number | undefined) => Math.max(0, Math.round(value ?? 0))

// ---------------------------------------------------------------------------
// The turn's streams
// ---------------------------------------------------------------------------

/** The AI SDK's `LanguageModelUsage`, whose counts may be `undefined`. */
const StreamUsage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Finite),
  inputTokenDetails: Schema.optional(
    Schema.Struct({
      noCacheTokens: Schema.optional(Schema.Finite),
      cacheReadTokens: Schema.optional(Schema.Finite),
      cacheWriteTokens: Schema.optional(Schema.Finite)
    })
  ),
  outputTokens: Schema.optional(Schema.Finite)
})

const UsagePart = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("finish"),
    totalUsage: StreamUsage,
    providerMetadata: Schema.optional(
      Schema.Struct({
        "claude-code": Schema.optional(
          Schema.Struct({ costUsd: Schema.optional(Schema.Finite), sessionId: Schema.optional(Schema.String) })
        )
      })
    )
  }),
  Schema.Struct({ type: Schema.Literal("finish-step"), usage: StreamUsage })
])
const decodeUsagePart = Schema.decodeUnknownOption(UsagePart)

const fromStreamUsage = (usage: typeof StreamUsage.Type): TokenUsage => {
  const cacheRead = count(usage.inputTokenDetails?.cacheReadTokens)
  const cacheWrite = count(usage.inputTokenDetails?.cacheWriteTokens)
  const noCache = usage.inputTokenDetails?.noCacheTokens
  return {
    input: noCache === undefined ? Math.max(0, count(usage.inputTokens) - cacheRead - cacheWrite) : count(noCache),
    cacheRead,
    cacheWrite,
    output: count(usage.outputTokens)
  }
}

/** What a turn's streams have said about usage so far. */
export interface Tally {
  /** Streams that ended, added up. */
  readonly ended?: TokenUsage
  /** The current stream's steps so far. */
  readonly steps?: TokenUsage
  /** The current stream's total, once it finished. */
  readonly finished?: TokenUsage
  /** Claude Code's running cost, and the session it's for, as last reported. */
  readonly claudeCostUsd?: number
  readonly claudeSessionId?: string
}

export const emptyTally: Tally = {}

const add = (a: TokenUsage | undefined, b: TokenUsage | undefined) =>
  a === undefined ? b : b === undefined ? a : addTokens(a, b)

/** Take in a stream part; only `finish-step` and `finish` matter. */
export const observe = (tally: Tally, part: { readonly type: string }): Tally => {
  if (part.type !== "finish" && part.type !== "finish-step") return tally
  const decoded = decodeUsagePart(part)
  if (Option.isNone(decoded)) return tally
  const value = decoded.value
  if (value.type === "finish-step")
    return { ...tally, steps: addTokens(tally.steps ?? noTokens, fromStreamUsage(value.usage)) }
  const claude = value.providerMetadata?.["claude-code"]
  return {
    ...tally,
    finished: fromStreamUsage(value.totalUsage),
    ...(claude?.costUsd === undefined ? {} : { claudeCostUsd: claude.costUsd }),
    ...(claude?.sessionId === undefined ? {} : { claudeSessionId: claude.sessionId })
  }
}

/** A stream ended (finished or not): its total, or what its steps added up to, joins the turn's. */
export const endStream = ({ ended, steps, finished, ...rest }: Tally): Tally => {
  const total = add(ended, finished ?? steps)
  return { ...rest, ...(total === undefined ? {} : { ended: total }) }
}

/** The agent's own tokens over the turn, if any stream said. */
export const agentTokens = (tally: Tally): Option.Option<TokenUsage> => Option.fromUndefinedOr(endStream(tally).ended)

// ---------------------------------------------------------------------------
// Subagents, from the CLIs' files
// ---------------------------------------------------------------------------

const Count = Schema.optional(Schema.Finite)

const ClaudeAssistantEntry = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("assistant"),
    message: Schema.Struct({
      id: Schema.String,
      usage: Schema.Struct({
        input_tokens: Count,
        cache_creation_input_tokens: Count,
        cache_read_input_tokens: Count,
        output_tokens: Count
      })
    })
  })
)
const decodeClaudeEntry = Schema.decodeUnknownOption(ClaudeAssistantEntry)

/**
 * The tokens in lines of a Claude Code subagent transcript. Each content block of a message is its own entry,
 * with the message's usage, so each message counts once; `lastId` is the last one counted before these lines.
 */
export const fromClaudeTranscript = (
  text: string,
  lastId?: string
): { readonly tokens: TokenUsage; readonly responses: number; readonly lastId?: string } => {
  const seen = new Set(lastId === undefined ? [] : [lastId])
  let tokens = noTokens
  let last = lastId
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue
    const entry = decodeClaudeEntry(line)
    if (Option.isNone(entry)) continue
    const { id, usage } = entry.value.message
    last = id
    if (seen.has(id)) continue
    seen.add(id)
    tokens = addTokens(tokens, {
      input: count(usage.input_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
      cacheWrite: count(usage.cache_creation_input_tokens),
      output: count(usage.output_tokens)
    })
  }
  return {
    tokens,
    responses: seen.size - (lastId === undefined ? 0 : 1),
    ...(last === undefined ? {} : { lastId: last })
  }
}

const CodexUsageRecord = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("token_usage_record"),
    payload: Schema.Struct({
      thread_id: Schema.String,
      session_id: Schema.String,
      usage: Schema.Struct({
        input_tokens: Count,
        cached_input_tokens: Count,
        cache_write_input_tokens: Count,
        output_tokens: Count
      })
    })
  })
)
const decodeCodexRecord = Schema.decodeUnknownOption(CodexUsageRecord)

/**
 * The tokens of `root`'s subagents in lines of a Codex rollout: one `token_usage_record` per response, whose
 * `session_id` is the root thread. Input counts cached tokens too, and output counts reasoning.
 */
export const fromCodexRollout = (
  text: string,
  root: string
): { readonly tokens: TokenUsage; readonly responses: number } => {
  let tokens = noTokens
  let responses = 0
  for (const line of text.split("\n")) {
    if (!line.includes('"token_usage_record"')) continue
    const record = decodeCodexRecord(line)
    if (Option.isNone(record)) continue
    const { thread_id, session_id, usage } = record.value.payload
    if (session_id !== root || thread_id === root) continue
    const cacheRead = count(usage.cached_input_tokens)
    const cacheWrite = count(usage.cache_write_input_tokens)
    responses++
    tokens = addTokens(tokens, {
      input: Math.max(0, count(usage.input_tokens) - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
      output: count(usage.output_tokens)
    })
  }
  return { tokens, responses }
}

const Ledger = Schema.Struct({
  /** When the files were last looked at (epoch milliseconds). */
  readAt: Schema.optionalKey(Schema.Finite),
  /** How far each file has been read, in bytes, and (Claude Code) the last message counted there. */
  files: Schema.Record(
    Schema.String,
    Schema.Struct({ bytes: Schema.Finite, lastId: Schema.optionalKey(Schema.String) })
  ),
  /** Claude Code's running cost after the last turn. */
  claudeCost: Schema.optionalKey(Schema.Struct({ sessionId: Schema.String, costUsd: Schema.Finite }))
})
type Ledger = typeof Ledger.Type

/** The complete lines of a file from byte `from` on, and where they end. */
const readNewLines = Effect.fn("TurnUsage.readNewLines")(function* (file: string, from: number, size: number) {
  const fs = yield* FileSystem.FileSystem
  const bytes = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(file, { flag: "r" })
      yield* handle.seek(BigInt(from), "start")
      const buffer = new Uint8Array(size - from)
      let read = 0
      while (read < buffer.length) {
        const n = Number(yield* handle.read(buffer.subarray(read)))
        if (n === 0) break
        read += n
      }
      return buffer.subarray(0, read)
    })
  )
  const end = bytes.lastIndexOf(0x0a) + 1
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), bytes: from + end }
})

/** Where each harness keeps the files subagents' usage is in, for this session. */
const subagentFiles = Effect.fn("TurnUsage.subagentFiles")(function* (
  harness: Harness,
  home: string,
  sessionId: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (harness === "claude-code") {
    const projects = path.join(home, ".claude", "projects")
    if (!(yield* fs.exists(projects))) return []
    const files: Array<string> = []
    for (const project of yield* fs.readDirectory(projects)) {
      const dir = path.join(projects, project, sessionId, "subagents")
      if (!(yield* fs.exists(dir))) continue
      for (const name of yield* fs.readDirectory(dir)) {
        if (name.startsWith("agent-") && name.endsWith(".jsonl")) files.push(path.join(dir, name))
      }
    }
    return files
  }
  const sessions = path.join(home, ".codex", "sessions")
  if (!(yield* fs.exists(sessions))) return []
  return (yield* fs.readDirectory(sessions, { recursive: true }))
    .filter((name) => name.endsWith(".jsonl") && !name.endsWith(`-${sessionId}.jsonl`))
    .map((name) => path.join(sessions, name))
})

/**
 * The turn's usage: the agent's own from `tally`, its subagents' from the CLIs' files, and (Claude Code) the rise
 * in cost. `sessionId` is Claude Code's session or Codex's root thread; `resumed` says whether the session existed
 * before this turn, in which case a cost with nothing to compare against isn't reported. Never fails: what can't be
 * read is left out, with `subagents: "excluded"`.
 */
export const settle = Effect.fn("TurnUsage.settle")(function* (options: {
  readonly harness: Harness
  readonly home: string
  readonly stateDir: string
  readonly tally: Tally
  readonly sessionId: Option.Option<string>
  readonly resumed: boolean
  readonly startedAt: DateTime.Utc
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const store = JsonFile.make(Ledger, path.join(options.stateDir, "turn-usage.json"))
  const ledger: Ledger = yield* store.read.pipe(
    Effect.map(Option.getOrElse((): Ledger => ({ files: {} }))),
    Effect.catch((error) =>
      Effect.logWarning("Couldn't read the turn usage ledger; starting over", { error: error.message }).pipe(
        Effect.as<Ledger>({ files: {} })
      )
    )
  )
  const readAt = DateTime.toEpochMillis(yield* DateTime.now)
  const cutoff = ledger.readAt ?? DateTime.toEpochMillis(options.startedAt)

  const readSubagents = Effect.gen(function* () {
    if (Option.isNone(options.sessionId)) return yield* Effect.fail("the harness session isn't known")
    const sessionId = options.sessionId.value
    const files = { ...ledger.files }
    let tokens = noTokens
    let responses = 0
    for (const file of yield* subagentFiles(options.harness, options.home, sessionId)) {
      const info = yield* fs.stat(file)
      const size = Number(info.size)
      const known = files[file]
      // A file that hasn't changed since before the ledger knew about it was counted already, or never will be.
      const modified = Option.match(info.mtime, { onNone: () => Infinity, onSome: (date) => date.getTime() })
      if (known === undefined && modified < cutoff) {
        files[file] = { bytes: size }
        continue
      }
      const from = known === undefined || known.bytes > size ? 0 : known.bytes
      if (from === size) continue
      const lines = yield* readNewLines(file, from, size)
      if (options.harness === "claude-code") {
        const read = fromClaudeTranscript(lines.text, from === 0 ? undefined : known?.lastId)
        tokens = addTokens(tokens, read.tokens)
        responses += read.responses
        files[file] = { bytes: lines.bytes, ...(read.lastId === undefined ? {} : { lastId: read.lastId }) }
      } else {
        const read = fromCodexRollout(lines.text, sessionId)
        tokens = addTokens(tokens, read.tokens)
        responses += read.responses
        files[file] = { bytes: lines.bytes }
      }
    }
    return { files, tokens, responses }
  })
  const subagents = yield* readSubagents.pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      Effect.logWarning("Couldn't read subagents' usage", { error: String(error) }).pipe(Effect.as(Option.none()))
    )
  )

  const cost = Effect.gen(function* () {
    const { claudeCostUsd: costUsd, claudeSessionId: sessionId } = options.tally
    if (costUsd === undefined || sessionId === undefined) return { costUsd: undefined, claudeCost: ledger.claudeCost }
    const before =
      ledger.claudeCost?.sessionId === sessionId ? ledger.claudeCost.costUsd : options.resumed ? undefined : 0
    if (before === undefined) {
      yield* Effect.logInfo("No earlier cost for this Claude Code session; the turn's cost isn't reported")
    }
    // A running total that went down started over.
    const rise = before === undefined ? undefined : costUsd >= before ? costUsd - before : costUsd
    return { costUsd: rise, claudeCost: { sessionId, costUsd } }
  })
  const { costUsd, claudeCost } = yield* cost

  yield* store
    .write({
      readAt,
      files: Option.match(subagents, { onNone: () => ledger.files, onSome: (read) => read.files }),
      ...(claudeCost === undefined ? {} : { claudeCost })
    })
    .pipe(Effect.catch((error) => Effect.logWarning("Couldn't save the turn usage ledger", { error: error.message })))

  const own = agentTokens(options.tally)
  const theirs = Option.filter(subagents, (read) => read.responses > 0)
  if (Option.isNone(own) && Option.isNone(theirs)) return Option.none<TurnUsage>()
  const tokens = addTokens(
    Option.getOrElse(own, () => noTokens),
    Option.match(theirs, { onNone: () => noTokens, onSome: (read) => read.tokens })
  )
  return Option.some<TurnUsage>({
    tokens,
    ...(costUsd === undefined ? {} : { costUsd }),
    subagents: Option.isSome(subagents) ? "included" : "excluded"
  })
})
