/**
 * The coding agent: Claude Code or Codex, driven through `@ai-sdk/harness`'s
 * `HarnessAgent` against this machine (`LocalSandbox.ts`). One session lives
 * for the life of the project. After every turn dreamd detaches from it and
 * saves the resume state, so a sandbox that was paused and resumed reattaches
 * to the running bridge, and a restart, which stops the bridge with
 * everything else the harness spawned, resumes the CLI's own session.
 *
 * `layer` is the real thing; `layerTest` scripts turns for the loop's tests.
 */
import { HarnessAgent } from "@ai-sdk/harness/agent"
import type { HarnessAgentSession } from "@ai-sdk/harness/agent"
import { createClaudeCode } from "@ai-sdk/harness-claude-code"
import { createCodex } from "@ai-sdk/harness-codex"
import { systemPrompt } from "@dream/agent-context"
import { Harness as HarnessName, type ReasoningEffort, type TurnUsage } from "@dream/domain"
import {
  Cause,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Ref,
  Schema,
  Stream
} from "effect"
import { DreamdConfig } from "../Config.ts"
import * as JsonFile from "../JsonFile.ts"
import * as Usage from "../Usage.ts"
import { withPinnedCli } from "./Bridges.ts"
import { codexContextWindow, topLevel } from "./Fleet.ts"
import { agentEnv, harnessAuth } from "./HarnessEnv.ts"
import { killAllNow, makeLocalSandboxSession, makeSpawned, stopAll } from "./LocalSandbox.ts"
import { claudeSettings } from "./PersonChannel.ts"
import * as Skill from "./Skill.ts"
import { drive, type Part, type TurnHandlers } from "./Turn.ts"
import * as Tokens from "./TurnUsage.ts"

/** How a turn ended. Limits show up in `usage.limit`, whatever the outcome. */
export type TurnOutcome = Data.TaggedEnum<{
  Completed: {}
  Failed: { readonly message: string }
}>
export const TurnOutcome = Data.taggedEnum<TurnOutcome>()

export interface TurnResult {
  readonly outcome: TurnOutcome
  readonly usage: Usage.UsageReading
  /** Whether the agent did anything (wrote, reasoned or used a tool) before the turn ended. */
  readonly progressed: boolean
  /** The text of the turn's last step: what the model said last, which only the session saw. */
  readonly finalText?: string
  /** What the turn used of the model, for `ReportTurn`, when the harness said anything about it. */
  readonly turnUsage?: TurnUsage
}

/** The harness couldn't run a turn at all (it didn't start, or crashed outside a turn). */
export class HarnessError extends Data.TaggedError("HarnessError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** There's no running turn to steer, or the harness can't take input mid-turn. */
export class SteerUnavailable extends Data.TaggedError("SteerUnavailable")<{ readonly message: string }> {}

export class Harness extends Context.Service<
  Harness,
  {
    readonly name: HarnessName
    /**
     * Run one turn to its end. Interrupting it stops the turn, within a few
     * seconds. Questions the model asks through its harness go to `handlers`.
     */
    readonly turn: (prompt: string, handlers: TurnHandlers) => Effect.Effect<TurnResult, HarnessError>
    /** Give the running turn more input, e.g. a message that arrived while it works. */
    readonly steer: (text: string) => Effect.Effect<void, SteerUnavailable>
  }
>()("@dream/dreamd/Harness") {
  static readonly layer = Layer.effect(
    Harness,
    Effect.suspend(() => make)
  )

  /**
   * A scripted harness: each turn takes the next script from `turns` and
   * runs it (it can sleep, steer-check, ask questions through `handlers`, fail, …); prompts and steering are
   * recorded in `log`.
   */
  static readonly layerTest = (options: {
    readonly name?: HarnessName
    readonly turns: Queue.Dequeue<(prompt: string, handlers: TurnHandlers) => Effect.Effect<TurnResult, HarnessError>>
    readonly log: Ref.Ref<ReadonlyArray<string>>
    readonly steerable?: boolean
  }) =>
    Layer.effect(
      Harness,
      Effect.gen(function* () {
        const running = yield* Ref.make(false)
        return Harness.of({
          name: options.name ?? "claude-code",
          turn: (prompt, handlers) =>
            Ref.set(running, true).pipe(
              Effect.andThen(Ref.update(options.log, (log) => [...log, `turn: ${prompt}`])),
              Effect.andThen(Queue.take(options.turns)),
              Effect.flatMap((script) => script(prompt, handlers)),
              Effect.ensuring(Ref.set(running, false))
            ),
          steer: (text) =>
            Effect.gen(function* () {
              if (options.steerable === false || !(yield* Ref.get(running))) {
                return yield* new SteerUnavailable({ message: "no running turn" })
              }
              yield* Ref.update(options.log, (log) => [...log, `steer: ${text}`])
            })
        })
      })
    )
}

// ---------------------------------------------------------------------------
// The real harness
// ---------------------------------------------------------------------------

const SavedSession = Schema.Struct({
  harness: HarnessName,
  sessionId: Schema.String,
  resumeFrom: Schema.optionalKey(
    Schema.Struct({
      type: Schema.Literal("resume-session"),
      harnessId: Schema.String,
      specificationVersion: Schema.Literal("harness-v1"),
      data: Schema.MutableJson
    })
  )
})
type SavedSession = typeof SavedSession.Type

/** Turn off Claude Code's built-ins that can't work here (see `PersonChannel.ts`), keeping any other settings. */
const writeClaudeSettings = (file: string) => {
  const settings = JsonFile.make(Schema.Json, file)
  return settings.read.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Couldn't read Claude Code's settings; replacing them", { error: error.message }).pipe(
        Effect.as(Option.none())
      )
    ),
    Effect.flatMap((existing) => settings.write(claudeSettings(Option.getOrUndefined(existing)))),
    Effect.catch((error) => Effect.logError("Couldn't write Claude Code's settings", { error: error.message }))
  )
}

/**
 * The harness adapter on Dream's pinned CLI, authenticated with the placeholder credential that egress replaces,
 * at `effort`. Shared by the agent's session and scheduled tasks' (`Tasks.ts`).
 */
export const makeAdapter = (
  name: HarnessName,
  config: { readonly codexBaseUrl: Option.Option<string> },
  effort: ReasoningEffort
) => {
  const auth = {
    ...harnessAuth(name),
    ...(name === "codex"
      ? Option.match(config.codexBaseUrl, { onNone: () => ({}), onSome: (url) => ({ OPENAI_BASE_URL: url }) })
      : {})
  }
  return name === "claude-code"
    ? withPinnedCli("claude-code", createClaudeCode({ auth, effort }))
    : withPinnedCli(
        "codex",
        createCodex({ auth, reasoningEffort: effort, codexConfig: { model_context_window: codexContextWindow } })
      )
}

/** How long detaching from the session may take. */
const detachTimeout = Duration.seconds(5)

const make = Effect.gen(function* () {
  const config = yield* DreamdConfig
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const skill = yield* Skill.dream
  const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))

  const store = JsonFile.make(SavedSession, path.join(config.stateDir, "session.json"))

  // Everything the harness spawned (bridges and their CLIs) stops when dreamd does: gracefully when the layer
  // closes, and by SIGKILL if the process exits first (a forced exit doesn't run finalizers).
  const spawned = makeSpawned()
  const onExit = () => killAllNow(spawned)
  yield* Effect.acquireRelease(
    Effect.sync(() => process.on("exit", onExit)),
    () => Effect.promise(() => stopAll(spawned)).pipe(Effect.ensuring(Effect.sync(() => process.off("exit", onExit))))
  )
  const name = config.harness
  if (name === "claude-code") yield* provide(writeClaudeSettings(path.join(config.home, ".claude", "settings.json")))
  const env = agentEnv(process.env, config)
  const { model, effort } = topLevel(name, config)
  yield* Effect.logInfo(`The agent runs on ${name}, model ${model}, effort ${effort}`)

  const agent = new HarnessAgent({
    harness: makeAdapter(name, config, effort),
    instructions: systemPrompt,
    skills: [skill],
    sandboxConfig: { workDir: "." },
    permissionMode: "allow-all",
    model
  })

  const saved = yield* provide(store.read).pipe(
    Effect.map(Option.filter((session) => session.harness === name)),
    Effect.catch((error) =>
      Effect.logWarning("Couldn't read the saved harness session; starting a new one", { error: error.message }).pipe(
        Effect.as(Option.none<SavedSession>())
      )
    )
  )
  const state = yield* Ref.make<SavedSession>(
    Option.getOrElse(saved, () => ({ harness: name, sessionId: `dream-${config.projectId}` }))
  )
  const active = yield* Ref.make<Option.Option<HarnessAgentSession>>(Option.none())

  const open = Effect.fn("Harness.open")(function* () {
    const current = yield* Ref.get(state)
    const sandboxSession = yield* Effect.promise(() =>
      makeLocalSandboxSession({ id: `dream-${config.projectId}`, cwd: config.workDir, env, spawned })
    )
    const attempt = (resumeFrom: SavedSession["resumeFrom"]) =>
      Effect.tryPromise({
        try: () =>
          agent.createSession({
            sessionId: current.sessionId,
            sandboxSession,
            ...(resumeFrom === undefined ? {} : { resumeFrom })
          }),
        catch: (cause) => new HarnessError({ message: `The ${name} session didn't start: ${String(cause)}`, cause })
      })
    if (current.resumeFrom === undefined) return yield* attempt(undefined)
    return yield* attempt(current.resumeFrom).pipe(
      Effect.retry({ times: 1 }),
      Effect.catch((error) =>
        Effect.gen(function* () {
          // The conversation is gone (or unreadable); the project's files aren't.
          yield* Effect.logError("Couldn't resume the harness session; starting a new conversation", {
            error: error.message
          })
          const fresh = { harness: name, sessionId: `dream-${config.projectId}-${Date.now()}` }
          yield* Ref.set(state, fresh)
          yield* provide(store.write(fresh)).pipe(Effect.ignore)
          return yield* Effect.tryPromise({
            try: () => agent.createSession({ sessionId: fresh.sessionId, sandboxSession }),
            catch: (cause) => new HarnessError({ message: `The ${name} session didn't start: ${String(cause)}`, cause })
          })
        })
      )
    )
  })

  /**
   * Leave the bridge running and keep what's needed to come back to it. Bounded, because after an interrupted
   * turn the bridge may never answer; then the saved state stays as the last turn left it.
   */
  const detach = (session: HarnessAgentSession) =>
    Effect.tryPromise(() => session.detach()).pipe(
      Effect.timeoutOrElse({
        duration: detachTimeout,
        orElse: () => Effect.fail(`no answer within ${Duration.format(detachTimeout)}`)
      }),
      Effect.flatMap((resumeFrom) =>
        Schema.decodeUnknownEffect(SavedSession)({ harness: name, sessionId: session.sessionId, resumeFrom })
      ),
      Effect.tap((next) => Ref.set(state, next)),
      Effect.flatMap((next) => provide(store.write(next))),
      Effect.catch((error) => Effect.logError("Couldn't save the harness session", { error: String(error) }))
    )

  /** A string the adapter keeps in its resume state: Codex's `threadId`, Claude Code's `claudeSessionId`. */
  const savedString = (key: string) =>
    Ref.get(state).pipe(
      Effect.map(({ resumeFrom }) => {
        const data = resumeFrom?.data
        const value = typeof data === "object" && data !== null && !Array.isArray(data) ? data[key] : undefined
        return typeof value === "string" ? Option.some(value) : Option.none<string>()
      })
    )

  const codexUsage = (since: DateTime.Utc, options?: { readonly onlySince?: boolean }) =>
    Effect.gen(function* () {
      const threadId = Option.getOrUndefined(yield* savedString("threadId"))
      if (threadId === undefined) return {}
      const file = yield* Usage.findCodexRollout(path.join(config.home, ".codex"), threadId)
      if (Option.isNone(file)) return {}
      const text = yield* Usage.readTail(file.value)
      return Usage.fromCodexRollout(text, since, yield* DateTime.now, options)
    }).pipe(
      provide,
      Effect.catch((error) =>
        Effect.logWarning("Couldn't read Codex usage", { error: String(error) }).pipe(Effect.as({}))
      )
    )

  const turn = Effect.fn("Harness.turn")(function* (prompt: string, handlers: TurnHandlers) {
    const startedAt = yield* DateTime.now
    const resumed = (yield* Ref.get(state)).resumeFrom !== undefined
    const session = yield* open()
    const usage = yield* Ref.make<Usage.UsageReading>({})
    const tally = yield* Ref.make(Tokens.emptyTally)
    const lastError = yield* Ref.make<Option.Option<string>>(Option.none())
    const progressed = yield* Ref.make(false)
    const controller = new AbortController()

    const finalText = yield* Ref.make("")
    // The turn's first reading goes out as soon as there is one (`TurnHandlers.firstUsage`).
    const firstReported = yield* Ref.make(false)
    const reportFirst = (reading: Usage.UsageReading) =>
      Effect.gen(function* () {
        if (handlers.firstUsage === undefined || Object.keys(reading).length === 0) return
        if (yield* Ref.getAndSet(firstReported, true)) return
        yield* Effect.forkDetach(handlers.firstUsage(reading))
      })

    const streamOf = (start: () => ReturnType<typeof agent.stream>) =>
      Stream.unwrap(
        Effect.tryPromise(start).pipe(
          Effect.tap(() => Ref.set(active, Option.some(session))),
          Effect.map((result) => Stream.fromAsyncIterable(result.fullStream, (cause) => cause))
        )
      ).pipe(Stream.ensuring(Ref.update(tally, Tokens.endStream)))
    const onPart = (part: Part) =>
      Effect.gen(function* () {
        yield* Ref.update(tally, (previous) => Tokens.observe(previous, part))
        switch (part.type) {
          case "raw": {
            const reading = Usage.fromClaudeRaw(part.rawValue, yield* DateTime.now)
            if (Option.isSome(reading)) {
              yield* Ref.update(usage, (previous) => Usage.merge(previous, reading.value))
              yield* reportFirst(reading.value)
              if (reading.value.limit !== undefined) {
                yield* Effect.logWarning("Usage limit reached; stopping the turn", {
                  window: reading.value.limit.window,
                  until: DateTime.formatIso(reading.value.limit.until)
                })
                controller.abort(new Error("usage limit reached"))
              }
            }
            return
          }
          case "finish-step":
            // Codex writes its usage to the rollout, not the stream: read it once, after the turn's first call.
            if (name === "codex" && !(yield* Ref.get(firstReported))) {
              yield* reportFirst(yield* codexUsage(startedAt, { onlySince: true }))
            }
            return
          case "error":
            yield* Ref.set(lastError, Option.some(String(part.error)))
            return
          case "tool-call":
            yield* Ref.set(progressed, true)
            yield* Effect.logDebug("tool call", { tool: part.toolName })
            return
          case "text-delta":
          case "reasoning-delta":
            yield* Ref.set(progressed, true)
            return
          default:
            return
        }
      })
    const consume = drive(
      {
        start: streamOf(() => agent.stream({ session, prompt, abortSignal: controller.signal })),
        // A tool message ending the input continues the paused turn instead of starting one.
        answer: (results) =>
          streamOf(() =>
            agent.stream({
              session,
              messages: [{ role: "tool", content: [...results] }],
              abortSignal: controller.signal
            })
          )
      },
      handlers,
      onPart
    ).pipe(Effect.flatMap((result) => Ref.set(finalText, result.finalText)))

    const exit = yield* consume.pipe(
      Effect.onInterrupt(() => Effect.sync(() => controller.abort(new Error("dreamd interrupted the turn")))),
      Effect.ensuring(Ref.set(active, Option.none())),
      Effect.ensuring(detach(session)),
      Effect.exit
    )
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt

    if (name === "codex") {
      const reading = yield* codexUsage(startedAt)
      yield* Ref.update(usage, (previous) => Usage.merge(previous, reading))
    }
    // Claude Code's session as the turn reported it, or as the adapter keeps it; Codex's root thread.
    const counted = yield* Ref.get(tally)
    const reported = name === "claude-code" ? Option.fromUndefinedOr(counted.claudeSessionId) : Option.none()
    const turnUsage = yield* provide(
      Tokens.settle({
        harness: name,
        home: config.home,
        stateDir: config.stateDir,
        tally: counted,
        sessionId: Option.isSome(reported)
          ? reported
          : yield* savedString(name === "claude-code" ? "claudeSessionId" : "threadId"),
        resumed,
        startedAt
      })
    )
    const errorMessage = Exit.isFailure(exit)
      ? Option.some(String(Cause.squash(exit.cause)))
      : yield* Ref.get(lastError)
    const reading = yield* Ref.get(usage)
    const unreadLimit =
      reading.limit === undefined && Option.isSome(errorMessage) && Usage.isCodexUsageLimitMessage(errorMessage.value)
    return {
      outcome: Option.match(errorMessage, {
        onNone: () => TurnOutcome.Completed(),
        onSome: (message) => TurnOutcome.Failed({ message })
      }),
      usage: unreadLimit
        ? Usage.merge(reading, { limit: Usage.fallbackLimit("fiveHour", yield* DateTime.now) })
        : reading,
      progressed: yield* Ref.get(progressed),
      finalText: yield* Ref.get(finalText),
      ...Option.match(turnUsage, { onNone: () => ({}), onSome: (turnUsage) => ({ turnUsage }) })
    } satisfies TurnResult
  })

  const steer = Effect.fn("Harness.steer")(function* (text: string) {
    const session = yield* Ref.get(active)
    if (Option.isNone(session)) return yield* new SteerUnavailable({ message: "There's no running turn." })
    yield* Effect.tryPromise({
      try: () => agent.experimental_steer({ session: session.value, text }),
      catch: (cause) => new SteerUnavailable({ message: String(cause) })
    })
  })

  return Harness.of({ name, turn, steer })
})
