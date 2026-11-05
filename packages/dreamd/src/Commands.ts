/**
 * Scheduled `--run` commands. When a `WakeDue` arrives with a command, dreamd
 * runs it in the project directory with the agent's environment. The agent
 * only hears about it if it fails: the wake is queued with the exit code and
 * the end of the output. Commands that were running when dreamd stopped run
 * again when it starts.
 */
import { Context, Duration, Effect, FiberSet, Layer, Option, Ref, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { DreamdConfig } from "./Config.ts"
import { harnessEnv } from "./harness/HarnessEnv.ts"
import { Inbox, type RunResult, type WakeDueEvent } from "./Inbox.ts"

/** The most of a command's output the agent sees. */
export const outputTailBytes = 4 * 1024
/** Longer than this and the command is stopped and reported as failed. */
export const commandTimeout = Duration.minutes(30)

export class Commands extends Context.Service<
  Commands,
  {
    /** Run every pending command as it arrives, forever. */
    readonly run: Effect.Effect<never>
  }
>()("@dream/dreamd/Commands") {
  static readonly layer = Layer.effect(
    Commands,
    Effect.gen(function* () {
      const config = yield* DreamdConfig
      const inbox = yield* Inbox
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const env = harnessEnv(process.env, { HOME: config.home })
      const running = yield* Ref.make<ReadonlySet<string>>(new Set())
      const fibers = yield* FiberSet.make()

      const execute = Effect.fn("Commands.execute")(function* (command: string) {
        const tail = yield* Ref.make("")
        const exitCode = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, { shell: "/bin/bash", cwd: config.workDir, env })
            )
            yield* handle.all.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) => Ref.update(tail, (text) => (text + chunk).slice(-outputTailBytes))),
              Effect.forkScoped
            )
            return yield* handle.exitCode
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

      const start = (event: WakeDueEvent) =>
        Effect.gen(function* () {
          const command = event.run?.command
          if (command === undefined) return
          yield* Effect.logInfo("Running a scheduled command", { wake: event.wakeId, command })
          const result = yield* execute(command)
          yield* Effect.logInfo("Scheduled command finished", { wake: event.wakeId, exitCode: result.exitCode })
          yield* inbox.commandFinished(event.id, result)
        }).pipe(
          Effect.catch((error) =>
            Effect.logError("Couldn't record a scheduled command's result", { error: error.message })
          ),
          Effect.ensuring(Ref.update(running, (ids) => new Set([...ids].filter((id) => id !== event.id))))
        )

      const run = inbox.changes.pipe(
        Stream.mapEffect(() => inbox.commands),
        Stream.runForEach((commands) =>
          Effect.forEach(commands, (event) =>
            Ref.modify(running, (ids) => (ids.has(event.id) ? [false, ids] : [true, new Set([...ids, event.id])])).pipe(
              Effect.flatMap((fresh) => (fresh ? FiberSet.run(fibers, start(event)) : Effect.void))
            )
          )
        ),
        Effect.andThen(Effect.never)
      )

      return Commands.of({ run })
    })
  )
}
