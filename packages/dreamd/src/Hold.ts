/**
 * Whether a usage limit they set holds the project (`DaemonRpcs.HoldTurns`). While it does, no turn starts and no
 * scheduled command or task runs, even for events dreamd already has; a turn under way finishes. It lives only in
 * memory: after a restart the DO's own hold on deliveries covers it, and it says so again when it next delivers.
 */
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"

export class Hold extends Context.Service<
  Hold,
  {
    readonly set: (held: boolean) => Effect.Effect<void>
    readonly held: Effect.Effect<boolean>
    /** Emits the current value, then each change. */
    readonly changes: Stream.Stream<boolean>
    /** Returns at once when nothing holds the project, else once the hold is over. */
    readonly released: Effect.Effect<void>
  }
>()("@dream/dreamd/Hold") {
  static readonly layer = Layer.effect(
    Hold,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make(false)
      const changes = SubscriptionRef.changes(ref)
      return Hold.of({
        set: (held) =>
          Effect.gen(function* () {
            if ((yield* SubscriptionRef.get(ref)) === held) return
            yield* SubscriptionRef.set(ref, held)
            yield* Effect.logInfo(
              held ? "A usage limit holds the project" : "The usage limit no longer holds the project"
            )
          }),
        held: SubscriptionRef.get(ref),
        changes,
        released: changes.pipe(
          Stream.filter((held) => !held),
          Stream.take(1),
          Stream.runDrain
        )
      })
    })
  )
}
