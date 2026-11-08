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
// The CLIs' files
// ---------------------------------------------------------------------------

const Count = Schema.optional(Schema.Finite)

const ClaudeAssistantEntry = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("assistant"),
    timestamp: Schema.optional(Schema.String),
    message: Schema.Struct({
      id: Schema.String,
      model: Schema.optional(Schema.String),
      usage: Schema.Struct({
        input_tokens: Count,
        cache_creation_input_tokens: Count,
        cache_read_input_tokens: Count,
        output_tokens: Count,
        cache_creation: Schema.optional(
          Schema.Struct({ ephemeral_5m_input_tokens: Count, ephemeral_1h_input_tokens: Count })
        )
      })
    })
  })
)
const decodeClaudeEntry = Schema.decodeUnknownOption(ClaudeAssistantEntry)

/** One model call: its tokens, what it cost, and enough to tell a session's growth from a re-send. */
export interface Step {
  readonly tokens: TokenUsage
  /** Everything it sent: fresh input, cache reads and writes. */
  readonly context: number
  /** Dollars at list prices; or, with `priced` false, a unit common to the provider's steps. */
  readonly cost: number
  /** What its input sent afresh (not read from the cache) cost. */
  readonly freshCost: number
  readonly priced: boolean
  readonly model?: string
  /** Epoch milliseconds, when the file says. */
  readonly at?: number
}

const epoch = (timestamp: string | undefined) => {
  const ms = timestamp === undefined ? Number.NaN : Date.parse(timestamp)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * List prices in dollars per million tokens by model family, for the next turn's note (`LastTurn`); the ledger's
 * weights are the Worker's (`apps/api/src/usage/Shares.ts`). Cache writes cost 1.25× input for five minutes and 2×
 * for an hour. A family's newest model sets its prices.
 */
const claudePrices: ReadonlyArray<{
  readonly family: string
  readonly input: number
  readonly cacheRead: number
  readonly output: number
}> = [
  { family: "fable", input: 10, cacheRead: 0.25, output: 50 },
  { family: "mythos", input: 10, cacheRead: 0.25, output: 50 },
  { family: "opus", input: 4, cacheRead: 0.2, output: 20 },
  { family: "sonnet", input: 2, cacheRead: 0.2, output: 10 },
  { family: "haiku", input: 1, cacheRead: 0.1, output: 5 }
]

const claudeStep = (entry: typeof ClaudeAssistantEntry.Type): Step => {
  const { model, usage } = entry.message
  const tokens = {
    input: count(usage.input_tokens),
    cacheRead: count(usage.cache_read_input_tokens),
    cacheWrite: count(usage.cache_creation_input_tokens),
    output: count(usage.output_tokens)
  }
  const prices = claudePrices.find(({ family }) => model?.includes(family) === true)
  const hour = Math.min(tokens.cacheWrite, count(usage.cache_creation?.ephemeral_1h_input_tokens))
  const freshCost =
    prices === undefined ? 0 : (tokens.input + 1.25 * (tokens.cacheWrite - hour) + 2 * hour) * prices.input
  const at = epoch(entry.timestamp)
  return {
    tokens,
    context: tokens.input + tokens.cacheRead + tokens.cacheWrite,
    cost:
      prices === undefined
        ? 0
        : (freshCost + tokens.cacheRead * prices.cacheRead + tokens.output * prices.output) / 1e6,
    freshCost: freshCost / 1e6,
    priced: prices !== undefined,
    ...(model === undefined ? {} : { model }),
    ...(at === undefined ? {} : { at })
  }
}

/**
 * The model calls in lines of a Claude Code transcript (the agent's own or a subagent's). Each content block of a
 * message is its own entry, with the message's usage, so each message counts once; `lastId` is the last one counted
 * before these lines. Calls that sent nothing (Claude Code's synthetic messages) aren't steps.
 */
export const claudeSteps = (
  text: string,
  lastId?: string
): { readonly steps: ReadonlyArray<Step>; readonly lastId?: string } => {
  const seen = new Set(lastId === undefined ? [] : [lastId])
  const steps: Array<Step> = []
  let last = lastId
  for (const line of text.split("\n")) {
    if (!line.includes('"assistant"')) continue
    const entry = decodeClaudeEntry(line)
    if (Option.isNone(entry)) continue
    const { id } = entry.value.message
    last = id
    if (seen.has(id)) continue
    seen.add(id)
    const step = claudeStep(entry.value)
    if (step.context > 0 || step.tokens.output > 0) steps.push(step)
  }
  return { steps, ...(last === undefined ? {} : { lastId: last }) }
}

/** The tokens in lines of a Claude Code subagent transcript (see `claudeSteps`). */
export const fromClaudeTranscript = (
  text: string,
  lastId?: string
): { readonly tokens: TokenUsage; readonly responses: number; readonly lastId?: string } => {
  const read = claudeSteps(text, lastId)
  return {
    tokens: read.steps.reduce((total, step) => addTokens(total, step.tokens), noTokens),
    responses: read.steps.length,
    ...(read.lastId === undefined ? {} : { lastId: read.lastId })
  }
}

const CodexUsageRecord = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("token_usage_record"),
    timestamp: Schema.optional(Schema.String),
    payload: Schema.Struct({
      thread_id: Schema.String,
      session_id: Schema.String,
      response_id: Schema.optional(Schema.String),
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

/** What each kind of OpenAI token costs relative to fresh input (as in the Worker's `RelativePrice`). */
const codexWeights = { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 8 }

/**
 * The model calls of `root`'s threads in lines of a Codex rollout: one `token_usage_record` per response, whose
 * `session_id` is the root thread. Input counts cached tokens too, and output counts reasoning. Priced in relative
 * units, since dreamd doesn't know OpenAI's prices.
 */
export const codexSteps = (
  text: string,
  root: string
): ReadonlyArray<Step & { readonly thread: string; readonly responseId?: string }> => {
  const steps: Array<Step & { readonly thread: string; readonly responseId?: string }> = []
  for (const line of text.split("\n")) {
    if (!line.includes('"token_usage_record"')) continue
    const record = decodeCodexRecord(line)
    if (Option.isNone(record)) continue
    const { thread_id, session_id, response_id, usage } = record.value.payload
    if (session_id !== root) continue
    const cacheRead = count(usage.cached_input_tokens)
    const cacheWrite = count(usage.cache_write_input_tokens)
    const tokens = {
      input: Math.max(0, count(usage.input_tokens) - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
      output: count(usage.output_tokens)
    }
    const freshCost = tokens.input * codexWeights.input + tokens.cacheWrite * codexWeights.cacheWrite
    const at = epoch(record.value.timestamp)
    steps.push({
      thread: thread_id,
      ...(response_id === undefined ? {} : { responseId: response_id }),
      tokens,
      context: tokens.input + cacheRead + cacheWrite,
      cost: freshCost + cacheRead * codexWeights.cacheRead + tokens.output * codexWeights.output,
      freshCost,
      priced: false,
      ...(at === undefined ? {} : { at })
    })
  }
  return steps
}

/** The tokens of `root`'s subagents in lines of a Codex rollout (see `codexSteps`), not the root's own. */
export const fromCodexRollout = (
  text: string,
  root: string
): { readonly tokens: TokenUsage; readonly responses: number } => {
  const steps = codexSteps(text, root).filter((step) => step.thread !== root)
  return { tokens: steps.reduce((total, step) => addTokens(total, step.tokens), noTokens), responses: steps.length }
}

// ---------------------------------------------------------------------------
// Where the turn's tokens went, session by session
// ---------------------------------------------------------------------------

/** A session's part in a turn, for the next turn's note (`LastTurn` in `@dream/agent-context`). */
export interface SessionSpend {
  readonly own: boolean
  readonly description?: string
  readonly model?: string
  readonly effort?: string
  readonly steps: number
  readonly peakContext: number
  readonly cost: number
  readonly recached: number
}

/** Where a session's previous step left off: what it sent, and when. */
interface Mark {
  readonly context: number
  readonly at?: number
}

/**
 * A step that sends this much more afresh than its session grew by, at least this long after the previous one, sent
 * the session again because its cache had lapsed (Claude's lasts five minutes, or an hour for the top level; OpenAI's
 * minutes too). A shorter gap is a compaction or the like, not a pause.
 */
const resendFloor = 4_096
const pauseFloorMs = 4 * 60_000

/** Steps of one session, added up; `from` is where its last step before these left off. */
export const spend = (
  steps: ReadonlyArray<Step>,
  from?: Mark
): {
  readonly steps: number
  readonly peakContext: number
  readonly cost: number
  readonly recached: number
  readonly priced: boolean
  readonly model?: string
  readonly last?: Mark
} => {
  let previous = from
  let peakContext = 0
  let cost = 0
  let recached = 0
  let model: string | undefined
  for (const step of steps) {
    const fresh = step.tokens.input + step.tokens.cacheWrite
    const grew = previous === undefined ? step.context : Math.max(0, step.context - previous.context)
    const paused =
      previous === undefined ||
      previous.at === undefined ||
      step.at === undefined ||
      step.at - previous.at >= pauseFloorMs
    const resent = Math.max(0, fresh - grew)
    if (paused && resent >= resendFloor && fresh > 0) recached += step.freshCost * (resent / fresh)
    peakContext = Math.max(peakContext, step.context)
    cost += step.cost
    model = step.model ?? model
    previous = { context: step.context, ...(step.at === undefined ? {} : { at: step.at }) }
  }
  return {
    steps: steps.length,
    peakContext,
    cost,
    recached,
    priced: steps.every((step) => step.priced),
    ...(model === undefined ? {} : { model }),
    ...(previous === undefined ? {} : { last: previous })
  }
}

/** What Claude Code keeps beside a subagent's transcript (`agent-<id>.meta.json`): how the agent started it. */
const ClaudeSubagentMeta = Schema.fromJsonString(
  Schema.Struct({
    description: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    effort: Schema.optional(Schema.String)
  })
)
const decodeSubagentMeta = Schema.decodeUnknownOption(ClaudeSubagentMeta)

const Ledger = Schema.Struct({
  /** When the files were last looked at (epoch milliseconds). */
  readAt: Schema.optionalKey(Schema.Finite),
  /** How far each file has been read, in bytes, and (Claude Code) the last message counted there. */
  files: Schema.Record(
    Schema.String,
    Schema.Struct({ bytes: Schema.Finite, lastId: Schema.optionalKey(Schema.String) })
  ),
  /** Claude Code's running cost after the last turn. */
  claudeCost: Schema.optionalKey(Schema.Struct({ sessionId: Schema.String, costUsd: Schema.Finite })),
  /** The agent's own session's last step (its id, what it sent, when), to tell a cold start in the next turn. */
  own: Schema.optionalKey(
    Schema.Struct({ sessionId: Schema.String, context: Schema.Finite, at: Schema.optionalKey(Schema.Finite) })
  )
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

/**
 * Where each harness keeps this session's files: the agent's own (Claude Code's transcript, Codex's root rollout)
 * and its subagents' (Claude Code's subagent transcripts; every other Codex rollout, which may hold the root's
 * subagents).
 */
const sessionFiles = Effect.fn("TurnUsage.sessionFiles")(function* (harness: Harness, home: string, sessionId: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files: Array<{ readonly file: string; readonly own: boolean }> = []
  if (harness === "claude-code") {
    const projects = path.join(home, ".claude", "projects")
    if (!(yield* fs.exists(projects))) return files
    for (const project of yield* fs.readDirectory(projects)) {
      const transcript = path.join(projects, project, `${sessionId}.jsonl`)
      if (yield* fs.exists(transcript)) files.push({ file: transcript, own: true })
      const dir = path.join(projects, project, sessionId, "subagents")
      if (!(yield* fs.exists(dir))) continue
      for (const name of yield* fs.readDirectory(dir)) {
        if (name.startsWith("agent-") && name.endsWith(".jsonl")) files.push({ file: path.join(dir, name), own: false })
      }
    }
    return files
  }
  const sessions = path.join(home, ".codex", "sessions")
  if (!(yield* fs.exists(sessions))) return files
  for (const name of yield* fs.readDirectory(sessions, { recursive: true })) {
    if (name.endsWith(".jsonl"))
      files.push({ file: path.join(sessions, name), own: name.endsWith(`-${sessionId}.jsonl`) })
  }
  return files
})

/**
 * The turn's usage: the agent's own from `tally`, its subagents' from the CLIs' files, and (Claude Code) the rise
 * in cost; and, for the next turn's prompt, each session's part, from the same files (the agent's own transcript
 * too). `sessionId` is Claude Code's session or Codex's root thread; `resumed` says whether the session existed
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

  const readSessions = Effect.gen(function* () {
    if (Option.isNone(options.sessionId)) return yield* Effect.fail("the harness session isn't known")
    const sessionId = options.sessionId.value
    const files = { ...ledger.files }
    let tokens = noTokens
    let responses = 0
    /** Each session's new steps: the agent's own under "own", a subagent's under its file or (Codex) thread. */
    const steps = new Map<string, { readonly file: string; readonly steps: Array<Step> }>()
    const seenResponses = new Set<string>()
    const add = (key: string, file: string, step: Step) => {
      const session = steps.get(key) ?? { file, steps: [] }
      session.steps.push(step)
      steps.set(key, session)
    }
    for (const { file, own } of yield* sessionFiles(options.harness, options.home, sessionId)) {
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
      // A file read from its start may hold earlier turns' steps (the agent's own transcript, first seen).
      const fresh = (step: Step) => from > 0 || step.at === undefined || step.at >= cutoff
      if (options.harness === "claude-code") {
        const read = claudeSteps(lines.text, from === 0 ? undefined : known?.lastId)
        if (!own) {
          tokens = read.steps.reduce((total, step) => addTokens(total, step.tokens), tokens)
          responses += read.steps.length
        }
        for (const step of read.steps) if (fresh(step)) add(own ? "own" : file, file, step)
        files[file] = { bytes: lines.bytes, ...(read.lastId === undefined ? {} : { lastId: read.lastId }) }
      } else {
        for (const step of codexSteps(lines.text, sessionId)) {
          const ownThread = step.thread === sessionId
          if (!own && !ownThread) {
            tokens = addTokens(tokens, step.tokens)
            responses++
          }
          // The root's steps come from its own rollout; a subagent's rollout can repeat the steps it forked from.
          if (ownThread !== own || !fresh(step)) continue
          if (step.responseId !== undefined) {
            if (seenResponses.has(step.responseId)) continue
            seenResponses.add(step.responseId)
          }
          add(ownThread ? "own" : step.thread, file, step)
        }
        files[file] = { bytes: lines.bytes }
      }
    }
    return { files, tokens, responses, steps, sessionId }
  })
  const read = yield* readSessions.pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      Effect.logWarning("Couldn't read subagents' usage", { error: String(error) }).pipe(Effect.as(Option.none()))
    )
  )

  const sessions = Effect.gen(function* () {
    const spent: Array<SessionSpend> = []
    let own = ledger.own
    if (Option.isNone(read)) return { sessions: spent, priced: false, own }
    const { steps, sessionId } = read.value
    let priced = true
    for (const [key, session] of steps) {
      const isOwn = key === "own"
      const from = isOwn && ledger.own?.sessionId === sessionId ? ledger.own : undefined
      const total = spend(session.steps, from)
      priced &&= total.priced
      if (isOwn && total.last !== undefined) own = { sessionId, ...total.last }
      const meta =
        isOwn || options.harness !== "claude-code"
          ? undefined
          : yield* fs.readFileString(session.file.replace(/\.jsonl$/, ".meta.json")).pipe(
              Effect.map((text) => Option.getOrUndefined(decodeSubagentMeta(text))),
              Effect.orElseSucceed(() => undefined)
            )
      const description = meta?.description
      const effort = meta?.effort
      const shownModel = meta?.model ?? total.model
      spent.push({
        own: isOwn,
        ...(description === undefined ? {} : { description }),
        ...(shownModel === undefined ? {} : { model: shownModel }),
        ...(effort === undefined ? {} : { effort }),
        steps: total.steps,
        peakContext: total.peakContext,
        cost: total.cost,
        recached: total.recached
      })
    }
    return { sessions: spent, priced, own }
  })
  const spent = yield* sessions

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
      files: Option.match(read, { onNone: () => ledger.files, onSome: (sessions) => sessions.files }),
      ...(claudeCost === undefined ? {} : { claudeCost }),
      ...(spent.own === undefined ? {} : { own: spent.own })
    })
    .pipe(Effect.catch((error) => Effect.logWarning("Couldn't save the turn usage ledger", { error: error.message })))

  const own = agentTokens(options.tally)
  const theirs = Option.filter(read, (sessions) => sessions.responses > 0)
  const usage: Option.Option<TurnUsage> =
    Option.isNone(own) && Option.isNone(theirs)
      ? Option.none()
      : Option.some({
          tokens: addTokens(
            Option.getOrElse(own, () => noTokens),
            Option.match(theirs, { onNone: () => noTokens, onSome: (sessions) => sessions.tokens })
          ),
          ...(costUsd === undefined ? {} : { costUsd }),
          subagents: Option.isSome(read) ? "included" : "excluded"
        })
  return { usage, sessions: spent.sessions, priced: spent.priced }
})
