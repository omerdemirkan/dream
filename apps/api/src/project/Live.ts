/**
 * Fan-out of `ProjectEvent`s to the phones subscribed over the DO's
 * WebSocket. Subscriptions live in this DO instance's memory; when the DO is
 * evicted, the runtime closes their sockets and the phone subscribes again,
 * starting from a fresh `Snapshot`.
 */
import { ProjectEvent } from "@dream/domain"
import { Context, Effect, Layer, PubSub, Stream } from "effect"

export class LiveFeed extends Context.Service<
  LiveFeed,
  {
    readonly publish: (event: ProjectEvent) => Effect.Effect<void>
    /** The snapshot first, then every change published after it was taken. */
    readonly subscribe: (snapshot: Effect.Effect<ProjectEvent>) => Stream.Stream<ProjectEvent>
  }
>()("@dream/api/project/LiveFeed") {
  static readonly layer = Layer.effect(
    LiveFeed,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<ProjectEvent>()
      return LiveFeed.of({
        publish: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
        subscribe: (snapshot) =>
          Stream.unwrap(
            Effect.gen(function* () {
              // Subscribe before taking the snapshot, so nothing published in between is lost.
              const subscription = yield* PubSub.subscribe(pubsub)
              const first = yield* snapshot
              return Stream.concat(Stream.make(first), Stream.fromSubscription(subscription))
            })
          )
      })
    })
  )
}
