/**
 * Scheduled `--run` commands and `--task` tasks. When a `WakeDue` arrives with
 * a command, dreamd runs it in the project directory with the agent's
 * environment; with a task, it runs the task's session (`Tasks.ts`) and
 * reports the run. The agent only hears about either if it fails: the wake is
 * queued with the exit code and the end of the output, or with why the task
 * failed. Commands and tasks that were running when dreamd stopped run again
 * when it starts.
 */
import { Context, Duration, Effect, Fiber, FiberSet, FileSystem, Layer, Option, PubSub, Ref, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Api } from "./Api.ts"
import { DreamdConfig } from "./Config.ts"
import { commandEnv } from "./harness/HarnessEnv.ts"
import { Hold } from "./Hold.ts"
import { Inbox, type RunResult, type WakeDueEvent } from "./Inbox.ts"
import { Tasks } from "./Tasks.ts"
import * as Usage from "./Usage.ts"

/** The most of a command's output the agent sees. */
export const outputTailBytes = 4 * 1024
/** Longer than this and the command is stopped and reported as failed. */
export const commandTimeout = Duration.minutes(30)

export class Commands extends Context.Service<
  Commands,
  {
    /** Run every pending command as it arrives, forever. */
    readonly run: Effect.Effect<never>
    /** Whether a command or a task is running now. */
    readonly busy: Effect.Effect<boolean>
    /** Commands delivered and not finished yet, running or about to. */
    readonly pending: Effect.Effect<number>
    /** Emits each time a command finishes, once it no longer counts as running. */
    readonly finished: Stream.Stream<void>
  }
>()("@dream/dreamd/Commands") {
  static readonly layer = Layer.effect(
    Commands,
    Effect.gen(function* () {
      const config = yield* DreamdConfig
      const inbox = yield* Inbox
      const hold = yield* Hold
      const tasks = yield* Tasks
      const api = yield* Api
      const provider = config.harness === "claude-code" ? ("claude" as const) : ("chatgpt" as const)
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(config.workDir, { recursive: true }).pipe(Effect.orDie)
      const env = commandEnv(process.env, config)
      const running = yield* Ref.make<ReadonlySet<string>>(new Set())
      const fibers = yield* FiberSet.make()
      const done = yield* PubSub.unbounded<void>()

      const execute = Effect.fn("Commands.execute")(function* (command: string) {
        const tail = yield* Ref.make("")
        const exitCode = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, { shell: "/bin/bash", cwd: config.workDir, env })
            )
            const reader = yield* handle.all.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) => Ref.update(tail, (text) => (text + chunk).slice(-outputTailBytes))),
              Effect.forkScoped
            )
            const exitCode = yield* handle.exitCode
            // A background process it started may hold the output open; don't wait for that.
            yield* Fiber.join(reader).pipe(Effect.timeoutOption("1 second"), Effect.ignore)
            return exitCode
          })
        ).pipe(
          Effect.timeoutOption(commandTimeout),
          Effect.map(Option.getOrElse(() => 124)),
          Effect.catch((error) => Ref.update(tail, (text) => `${text}\n${error.message}`).pipe(Effect.as(127)))
        )
        const outputTail = yield* Ref.get(tail)
        return {
          exitCode,
          outputTail:
            exitCode === 124 && outputTail.length < outputTailBytes
              ? `${outputTail}\n(stopped after ${Duration.format(commandTimeout)})`
              : outputTail
        } satisfies RunResult
      })

      const runTask = (event: WakeDueEvent) =>
        Effect.gen(function* () {
          const task = event.task
          if (task === undefined) return
          const { timeZone } = yield* inbox.state
          const result = yield* tasks.run({ eventId: event.id, wakeId: event.wakeId, why: event.why, task, timeZone })
          // Their usage as the session last saw it, and a limit it hit, as a turn's would be.
          if (result.lastReading !== undefined) {
            yield* api.reportUsage(Usage.toSnapshot(provider, result.lastReading, result.endedAt))
          }
          yield* api.reportTask({
            wakeId: event.wakeId,
            startedAt: result.startedAt,
            endedAt: result.endedAt,
            outcome: result.outcome,
            ...(result.report === undefined
              ? result.failure === undefined
                ? {}
                : { summary: result.failure.reason }
              : { summary: result.report }),
            ...(result.usage === undefined ? {} : { usage: result.usage }),
            ...(result.firstReading === undefined
              ? {}
              : { before: Usage.toSnapshot(provider, result.firstReading, result.startedAt) }),
            ...(result.lastReading === undefined
              ? {}
              : { after: Usage.toSnapshot(provider, result.lastReading, result.endedAt) })
          })
          yield* inbox.taskFinished(event.id, result.failure)
        })

      const start = (event: WakeDueEvent) =>
        Effect.gen(function* () {
          if (event.run === undefined && event.task !== undefined) return yield* runTask(event)
          const command = event.run?.command
          if (command === undefined) return
          yield* Effect.logInfo("Running a scheduled command", { wake: event.wakeId, command })
          const result = yield* execute(command)
          yield* Effect.logInfo("Scheduled command finished", { wake: event.wakeId, exitCode: result.exitCode })
          yield* inbox.commandFinished(event.id, result)
        }).pipe(
          Effect.catch((error) =>
            Effect.logError("Couldn't record a scheduled command's or task's result", { error: error.message })
          ),
          Effect.ensuring(
            Ref.update(running, (ids) => new Set([...ids].filter((id) => id !== event.id))).pipe(
              Effect.andThen(PubSub.publish(done, undefined))
            )
          )
        )

      // While a usage limit they set holds the project, scheduled commands and tasks wait like turns do.
      const run = Stream.merge(inbox.changes, hold.changes).pipe(
        Stream.mapEffect(() => Effect.flatMap(hold.held, (held) => (held ? Effect.succeed([]) : inbox.commands))),
        Stream.runForEach((commands) =>
          Effect.forEach(commands, (event) =>
            Ref.modify(running, (ids) => (ids.has(event.id) ? [false, ids] : [true, new Set([...ids, event.id])])).pipe(
              Effect.flatMap((fresh) => (fresh ? FiberSet.run(fibers, start(event)) : Effect.void))
            )
          )
        ),
        Effect.andThen(Effect.never)
      )

      return Commands.of({
        run,
        busy: Effect.map(Ref.get(running), (ids) => ids.size > 0),
        pending: Effect.map(inbox.commands, (commands) => commands.length),
        finished: Stream.fromPubSub(done)
      })
    })
  )
}
