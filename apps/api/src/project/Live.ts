/**
 * Fan-out of `ProjectEvent`s to the phones subscribed over the DO's
 * WebSocket. Subscriptions live in this DO instance's memory; when the DO is
 * evicted, the runtime closes their sockets and the phone subscribes again,
 * starting from a fresh `Snapshot`.
 */
import { ProjectEvent } from "@dream/domain"
import { Context, Effect, Layer, PubSub, Ref, Stream } from "effect"

export class LiveFeed extends Context.Service<
  LiveFeed,
  {
    readonly publish: (event: ProjectEvent) => Effect.Effect<void>
    /**
     * The snapshot first, then every change published after it was taken. `watchersChanged` runs once the count of
     * subscribed phones has gone up for this one, and again once it has gone down.
     */
    readonly subscribe: (
      snapshot: Effect.Effect<ProjectEvent>,
      watchersChanged?: Effect.Effect<void>
    ) => Stream.Stream<ProjectEvent>
    /** Phones subscribed right now. */
    readonly watchers: Effect.Effect<number>
  }
>()("@dream/api/project/LiveFeed") {
  static readonly layer = Layer.effect(
    LiveFeed,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<ProjectEvent>()
      const watchers = yield* Ref.make(0)
      return LiveFeed.of({
        watchers: Ref.get(watchers),
        publish: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
        subscribe: (snapshot, watchersChanged = Effect.void) =>
          Stream.unwrap(
            Effect.gen(function* () {
              // Subscribe before taking the snapshot, so nothing published in between is lost.
              const subscription = yield* PubSub.subscribe(pubsub)
              const first = yield* snapshot
              return Stream.concat(Stream.make(first), Stream.fromSubscription(subscription))
            })
          ).pipe(
            Stream.onStart(
              Effect.andThen(
                Ref.update(watchers, (n) => n + 1),
                watchersChanged
              )
            ),
            Stream.ensuring(
              Effect.andThen(
                Ref.update(watchers, (n) => Math.max(0, n - 1)),
                watchersChanged
              )
            )
          )
      })
    })
  )
}
