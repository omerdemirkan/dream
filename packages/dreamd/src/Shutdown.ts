/**
 * How dreamd stops: when its env file changes (the supervisor starts it again
 * with the new settings) or on SIGTERM/SIGINT. Once shutdown begins, `Deliver`
 * is refused with `DaemonRestarting`, the running turn gets `grace` to stop,
 * and the process exits within `forceAfter` whatever happens. That last part
 * is a plain timer outside the Effect runtime, so a finalizer that never
 * returns (a harness bridge that won't stop, a socket that won't close) can't
 * keep a dead dreamd alive. Processes the harness spawned are killed on exit
 * (see `LocalSandbox.ts`).
 */
import { Context, Duration, Effect, Layer } from "effect"

export class Shutdown extends Context.Service<
  Shutdown,
  {
    /** Whether shutdown has begun. */
    readonly pending: Effect.Effect<boolean>
    /** Start shutting down: refuse deliveries from now on, and arm the forced exit. */
    readonly begin: (reason: string) => Effect.Effect<void>
    /** How long the running work gets to stop before dreamd exits without waiting for it. */
    readonly grace: Duration.Duration
  }
>()("@dream/dreamd/Shutdown") {
  /** Exits the process `forceAfter` after shutdown begins, and begins it on SIGTERM and SIGINT. */
  static readonly layer = Layer.effect(
    Shutdown,
    Effect.gen(function* () {
      const forceAfter = Duration.seconds(15)
      const state = { pending: false }
      const begin = (reason: string) => {
        if (state.pending) return
        state.pending = true
        setTimeout(() => {
          process.stderr.write(
            `${new Date().toISOString()} dreamd: still running ${Duration.format(forceAfter)} after shutdown began (${reason}); exiting\n`
          )
          process.exit(1)
        }, Duration.toMillis(forceAfter)).unref()
      }
      const onSignal = (signal: NodeJS.Signals) => begin(signal)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.on("SIGTERM", onSignal)
          process.on("SIGINT", onSignal)
        }),
        () =>
          Effect.sync(() => {
            process.off("SIGTERM", onSignal)
            process.off("SIGINT", onSignal)
          })
      )
      return Shutdown.of({
        pending: Effect.sync(() => state.pending),
        begin: (reason) =>
          Effect.sync(() => begin(reason)).pipe(Effect.andThen(Effect.logInfo("Shutting down", { reason }))),
        grace: Duration.seconds(10)
      })
    })
  )

  /** No timers or signals: shutdown is just a flag. */
  static readonly layerTest = (options: { readonly grace?: Duration.Input } = {}) =>
    Layer.sync(Shutdown, () => {
      const state = { pending: false }
      return Shutdown.of({
        pending: Effect.sync(() => state.pending),
        begin: () =>
          Effect.sync(() => {
            state.pending = true
          }),
        grace: Duration.fromInputUnsafe(options.grace ?? Duration.seconds(10))
      })
    })
}
