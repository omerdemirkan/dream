/**
 * Counts what reached the person: `dream` calls that put something in front
 * of them (see `reachesPerson`), through the CLI socket or from dreamd itself.
 * The event loop compares the count before and after a turn to tell whether
 * the agent said anything.
 */
import { Context, Effect, Layer, Ref } from "effect"
import { reachesPerson } from "./harness/PersonChannel.ts"

export class Outreach extends Context.Service<
  Outreach,
  {
    /** Note the RPCs that just succeeded; only those that reach the person count. */
    readonly record: (tags: ReadonlyArray<string>) => Effect.Effect<void>
    /** How many have reached them since dreamd started. */
    readonly count: Effect.Effect<number>
  }
>()("@dream/dreamd/Outreach") {
  static readonly layer = Layer.effect(
    Outreach,
    Effect.gen(function* () {
      const count = yield* Ref.make(0)
      return Outreach.of({
        record: (tags) => Ref.update(count, (n) => n + tags.filter((tag) => reachesPerson.has(tag)).length),
        count: Ref.get(count)
      })
    })
  )
}
