/**
 * Scheduled tasks (`dream wake --task`): when one comes due, dreamd runs it in a session of its own, a new
 * conversation on the harness the project uses, on the model and effort the agent picked, that starts from the
 * agent's brief. It has the project directory, the agent's environment (so `dream` works) and Dream's skills,
 * and its system prompt is `taskPrompt` from `@dream/agent-context`. The agent's own session isn't touched, so a
 * run costs what the job takes instead of re-sending everything that session holds.
 *
 * A run fails when the session can't start, errors, hits a usage limit or runs past `taskTimeout`; a failure reaches
 * the agent as the wake with `task.result`. Anything else succeeds: the session wakes the agent itself
 * (`dream wake "why"`) when the job can't be done. Each run is reported (`ReportTask`) with its last words and
 * tokens, which the ledger counts for the project, and with the usage readings it saw.
 *
 * `layer` is the real thing; `layerTest` scripts runs for the command runner's tests.
 */
import { HarnessAgent } from "@ai-sdk/harness/agent"
import { renderTaskPrompt, taskPrompt } from "@dream/agent-context"
import type { TaskFailure, TaskOutcome, TurnUsage, WakeTask, WakeId } from "@dream/domain"
import { Cause, Context, DateTime, Duration, Effect, Exit, FileSystem, Layer, Option, Path, Ref, Stream } from "effect"
import { DreamdConfig } from "./Config.ts"
import { makeAdapter } from "./harness/Harness.ts"
import { agentEnv } from "./harness/HarnessEnv.ts"
import { makeLocalSandboxSession, makeSpawned, stopAll } from "./harness/LocalSandbox.ts"
import * as Skill from "./harness/Skill.ts"
import { drive, type Part, type TurnHandlers } from "./harness/Turn.ts"
import * as Tokens from "./harness/TurnUsage.ts"
import * as Usage from "./Usage.ts"

/** Past this the run is stopped and counts as failed. */
export const taskTimeout = Duration.minutes(30)
/** The most of the session's last words that's kept for the agent. */
export const reportChars = 2_000

export interface TaskRunInput {
  /** The `WakeDue` event's id: names the session, so a run that's tried again after a restart is a new one. */
  readonly eventId: string
  readonly wakeId: WakeId
  readonly why: string
  readonly task: WakeTask
  readonly timeZone?: string | undefined
}

export interface TaskRunResult {
  readonly outcome: TaskOutcome
  /** Set when it failed. */
  readonly failure?: TaskFailure
  /** The session's last words, shortened. */
  readonly report?: string
  readonly startedAt: DateTime.Utc
  readonly endedAt: DateTime.Utc
  readonly usage?: TurnUsage
  /** The subscription's usage as the session first and last saw it. */
  readonly firstReading?: Usage.UsageReading
  readonly lastReading?: Usage.UsageReading
}

const shorten = (text: string) => {
  const trimmed = text.trim()
  return trimmed.length <= reportChars ? trimmed : `…${trimmed.slice(-reportChars)}`
}

/** A task's session has nobody to answer questions, so a question tool call gets this instead of an answer. */
const noQuestions: TurnHandlers = {
  ask: () =>
    Effect.succeed({
      _tag: "NotSent",
      reason:
        "a scheduled task has nobody to ask; settle it from the brief, or `dream wake` the project's agent with " +
        "what it needs to decide"
    })
}

export class Tasks extends Context.Service<
  Tasks,
  {
    /** Run one task's session to its end. Never fails: what went wrong is the result. */
    readonly run: (input: TaskRunInput) => Effect.Effect<TaskRunResult>
  }
>()("@dream/dreamd/Tasks") {
  static readonly layer = Layer.effect(
    Tasks,
    Effect.gen(function* () {
      const config = yield* DreamdConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const skills = yield* Skill.all
      const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        effect.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))
      const name = config.harness
      const env = agentEnv(process.env, config)
      // Every process a task's session starts stops when dreamd does.
      const spawned = makeSpawned()
      yield* Effect.addFinalizer(() => Effect.promise(() => stopAll(spawned)))

      const run = Effect.fn("Tasks.run")(function* (input: TaskRunInput) {
        const startedAt = yield* DateTime.now
        const sessionId = `dream-task-${input.eventId}`
        const scratch = path.join(config.stateDir, "tasks", input.eventId)
        yield* Effect.logInfo("Running a scheduled task", {
          wake: input.wakeId,
          model: input.task.model,
          effort: input.task.effort
        })

        const agent = new HarnessAgent({
          harness: makeAdapter(name, config, input.task.effort),
          instructions: taskPrompt,
          skills,
          sandboxConfig: { workDir: "." },
          permissionMode: "allow-all",
          model: input.task.model
        })
        const tally = yield* Ref.make(Tokens.emptyTally)
        const first = yield* Ref.make<Option.Option<Usage.UsageReading>>(Option.none())
        const last = yield* Ref.make<Usage.UsageReading>({})
        const lastError = yield* Ref.make<Option.Option<string>>(Option.none())
        const controller = new AbortController()

        const onPart = (part: Part) =>
          Effect.gen(function* () {
            yield* Ref.update(tally, (previous) => Tokens.observe(previous, part))
            if (part.type === "error") return yield* Ref.set(lastError, Option.some(String(part.error)))
            if (part.type !== "raw") return
            const reading = Usage.fromClaudeRaw(part.rawValue, yield* DateTime.now)
            if (Option.isNone(reading)) return
            // An event can name no window at all (the API sent none); that's no reading of where they stand.
            const windows = reading.value.fiveHour !== undefined || reading.value.weekly !== undefined
            yield* Ref.update(first, (seen) => (Option.isSome(seen) || !windows ? seen : reading))
            yield* Ref.update(last, (previous) => Usage.merge(previous, reading.value))
            if (reading.value.limit !== undefined) controller.abort(new Error("usage limit reached"))
          })

        const prompt = renderTaskPrompt({
          why: input.why,
          brief: input.task.brief,
          now: startedAt,
          timeZone: input.timeZone
        })
        const streamOf = (start: () => ReturnType<typeof agent.stream>) =>
          Stream.unwrap(
            Effect.tryPromise(start).pipe(
              Effect.map((result) => Stream.fromAsyncIterable(result.fullStream, (cause) => cause))
            )
          ).pipe(Stream.ensuring(Ref.update(tally, Tokens.endStream)))

        const exit = yield* Effect.acquireUseRelease(
          Effect.tryPromise(async () => {
            const sandboxSession = await makeLocalSandboxSession({ id: sessionId, cwd: config.workDir, env, spawned })
            return { sandboxSession, session: await agent.createSession({ sessionId, sandboxSession }) }
          }),
          ({ session }) =>
            drive(
              {
                start: streamOf(() => agent.stream({ session, prompt, abortSignal: controller.signal })),
                answer: (results) =>
                  streamOf(() =>
                    agent.stream({
                      session,
                      messages: [{ role: "tool", content: [...results] }],
                      abortSignal: controller.signal
                    })
                  )
              },
              noQuestions,
              onPart
            ).pipe(
              Effect.timeoutOption(taskTimeout),
              Effect.onInterrupt(() => Effect.sync(() => controller.abort(new Error("dreamd stopped the task"))))
            ),
          // The conversation isn't kept: a task's next run starts fresh.
          ({ session, sandboxSession }) =>
            Effect.tryPromise(() => session.destroy()).pipe(
              Effect.timeout("10 seconds"),
              Effect.ignore,
              Effect.andThen(Effect.promise(() => sandboxSession.stop()))
            )
        ).pipe(Effect.exit)
        const endedAt = yield* DateTime.now
        const counted = yield* Ref.get(tally)
        const usage = yield* provide(
          Tokens.settle({
            harness: name,
            home: config.home,
            stateDir: scratch,
            tally: counted,
            sessionId: name === "claude-code" ? Option.fromUndefinedOr(counted.claudeSessionId) : Option.none(),
            resumed: false,
            startedAt
          })
        ).pipe(Effect.map((settled) => settled.usage))
        yield* fs.remove(scratch, { recursive: true }).pipe(Effect.ignore)

        const lastReading = yield* Ref.get(last)
        const firstReading = yield* Ref.get(first)
        const finished = Exit.isSuccess(exit) ? exit.value : Option.none()
        const report = Option.match(finished, { onNone: () => "", onSome: (result) => shorten(result.finalText) })
        const failure: TaskFailure | undefined = Exit.isFailure(exit)
          ? { reason: `its session didn't run: ${Cause.squash(exit.cause)}` }
          : Option.isNone(finished)
            ? { reason: `it didn't finish within ${Duration.format(taskTimeout)}` }
            : lastReading.limit !== undefined
              ? { reason: "their usage limit ran out before it finished" }
              : Option.match(yield* Ref.get(lastError), {
                  onNone: () => undefined,
                  onSome: (message) => ({ reason: `its session ended with an error: ${message}` })
                })
        const withReport = failure === undefined || report.length === 0 ? failure : { ...failure, report }
        yield* Effect.logInfo("Scheduled task finished", {
          wake: input.wakeId,
          outcome: failure === undefined ? "succeeded" : "failed",
          ...(failure === undefined ? {} : { reason: failure.reason })
        })
        return {
          outcome: failure === undefined ? "succeeded" : "failed",
          ...(withReport === undefined ? {} : { failure: withReport }),
          ...(report.length === 0 ? {} : { report }),
          startedAt,
          endedAt,
          ...Option.match(usage, { onNone: () => ({}), onSome: (usage) => ({ usage }) }),
          ...Option.match(firstReading, { onNone: () => ({}), onSome: (firstReading) => ({ firstReading }) }),
          ...(Object.keys(lastReading).length === 0 ? {} : { lastReading })
        } satisfies TaskRunResult
      })

      return Tasks.of({ run })
    })
  )

  /** For tests that schedule no tasks: every run fails at once. */
  static readonly layerNone = Layer.succeed(
    Tasks,
    Tasks.of({
      run: () =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          return { outcome: "failed", failure: { reason: "tasks don't run here" }, startedAt: now, endedAt: now }
        })
    })
  )

  /** Answers each run with `script(input)`, and records what it was asked to run. */
  static readonly layerTest = (options: {
    readonly script: (input: TaskRunInput) => Effect.Effect<Omit<TaskRunResult, "startedAt" | "endedAt">>
    readonly log: Ref.Ref<ReadonlyArray<TaskRunInput>>
  }) =>
    Layer.succeed(
      Tasks,
      Tasks.of({
        run: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(options.log, (all) => [...all, input])
            const startedAt = yield* DateTime.now
            const result = yield* options.script(input)
            return { ...result, startedAt, endedAt: yield* DateTime.now }
          })
      })
    )
}
