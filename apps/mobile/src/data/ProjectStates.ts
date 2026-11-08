/**
 * Open projects, each folded from its live stream into a `ProjectState`.
 *
 * A project's subscription starts when a screen first needs it and lingers for
 * a short while after the last one lets go, so moving between Home, Status,
 * Chat and the expanded view doesn't reconnect.
 *
 * What each project last showed is kept for the session, so opening it again
 * shows that at once, until its new snapshot replaces it. Next to the state,
 * `connection` says whether that snapshot is on its way, slow, or not getting
 * through.
 */
import type { Message, ProjectId } from "@dream/domain"
import { Context, Duration, Effect, FiberHandle, Layer, Option, RcMap, Stream, SubscriptionRef } from "effect"
import { AppClient } from "./AppClient.ts"
import { LiveProjects } from "./LiveProjects.ts"
import { addEarlier, applyEvent, type ProjectState, replaceMessage } from "./projectState.ts"

/**
 * A project's live connection: `live` once this connection's snapshot arrived; `connecting` until then, `slow` after
 * a couple of seconds, and `failing` when it has dropped several times in a row or taken far too long.
 */
export type Connection = "live" | "connecting" | "slow" | "failing"

/** Waiting this long for a snapshot is slow. */
export const slowAfter = Duration.seconds(2)
/** Waiting this long, or this many drops in a row, is failing. */
export const failingAfter = Duration.seconds(20)
export const failingDrops = 3

export class ProjectStates extends Context.Service<
  ProjectStates,
  {
    /** The project's state as it changes: what it showed last this session, else `None` until the first snapshot. */
    readonly state: (projectId: ProjectId) => Stream.Stream<Option.Option<ProjectState>>
    /** How the project's live connection is doing. */
    readonly connection: (projectId: ProjectId) => Stream.Stream<Connection>
    /** Loads the page of Chat history before the oldest message held. */
    readonly loadEarlier: (projectId: ProjectId) => Effect.Effect<void>
    /** Folds in a message returned by an RPC, ahead of the live stream's copy. */
    readonly receive: (message: Message) => Effect.Effect<void>
    /** Drops every open subscription so each starts again from a fresh snapshot (after the app was in the background). */
    readonly reconnect: Effect.Effect<void>
  }
>()("@dream/mobile/ProjectStates") {
  static readonly layer = Layer.effect(
    ProjectStates,
    Effect.gen(function* () {
      const app = yield* AppClient
      const live = yield* LiveProjects

      // What each project showed last, kept after its subscription closes.
      const last = new Map<ProjectId, ProjectState>()

      const remember = (projectId: ProjectId, state: Option.Option<ProjectState>) => {
        if (Option.isSome(state)) last.set(projectId, state.value)
        return state
      }

      const entries = yield* RcMap.make({
        lookup: (projectId: ProjectId) =>
          Effect.gen(function* () {
            const ref = yield* SubscriptionRef.make(Option.fromUndefinedOr(last.get(projectId)))
            const connection = yield* SubscriptionRef.make<Connection>("connecting")
            const handle = yield* FiberHandle.make()
            const timer = yield* FiberHandle.make()
            let drops = 0
            // Started when a wait for a snapshot begins; a drop while waiting leaves it running.
            const wait = FiberHandle.run(
              timer,
              Effect.sleep(slowAfter).pipe(
                Effect.andThen(SubscriptionRef.update(connection, (c) => (c === "connecting" ? "slow" : c))),
                Effect.andThen(Effect.sleep(Duration.subtract(failingAfter, slowAfter))),
                Effect.andThen(SubscriptionRef.set(connection, "failing"))
              ),
              { onlyIfMissing: true }
            )
            const restart = Effect.gen(function* () {
              drops = 0
              yield* FiberHandle.clear(timer)
              yield* SubscriptionRef.set(connection, "connecting")
              yield* wait
              yield* FiberHandle.run(
                handle,
                live.subscribe(projectId).pipe(
                  Stream.runForEach((signal) => {
                    if (signal._tag === "Dropped") {
                      drops += 1
                      return SubscriptionRef.update(connection, (c) =>
                        drops >= failingDrops ? "failing" : c === "live" ? "connecting" : c
                      ).pipe(Effect.andThen(wait))
                    }
                    return SubscriptionRef.update(ref, (state) =>
                      remember(projectId, Option.fromUndefinedOr(applyEvent(Option.getOrUndefined(state), signal)))
                    ).pipe(
                      Effect.andThen(
                        signal._tag === "Snapshot"
                          ? Effect.gen(function* () {
                              drops = 0
                              yield* FiberHandle.clear(timer)
                              yield* SubscriptionRef.set(connection, "live")
                            })
                          : Effect.void
                      )
                    )
                  })
                )
              )
            })
            yield* restart
            return { ref, connection, restart }
          }),
        idleTimeToLive: "30 seconds"
      })

      type Ref = SubscriptionRef.SubscriptionRef<Option.Option<ProjectState>>
      const withState = <A>(projectId: ProjectId, f: (ref: Ref) => Effect.Effect<A>) =>
        RcMap.get(entries, projectId).pipe(
          Effect.flatMap(({ ref }) => f(ref)),
          Effect.scoped
        )

      return ProjectStates.of({
        state: (projectId) =>
          Stream.unwrap(Effect.map(RcMap.get(entries, projectId), ({ ref }) => SubscriptionRef.changes(ref))),
        connection: (projectId) =>
          Stream.unwrap(
            Effect.map(RcMap.get(entries, projectId), ({ connection }) => SubscriptionRef.changes(connection))
          ),
        loadEarlier: Effect.fn("ProjectStates.loadEarlier")(function* (projectId: ProjectId) {
          yield* withState(projectId, (ref) =>
            Effect.gen(function* () {
              const current = yield* SubscriptionRef.get(ref)
              if (Option.isNone(current) || !current.value.hasEarlierMessages) return
              const oldest = current.value.messages[0]
              const page = yield* app.ListMessages({
                projectId,
                limit: 50,
                ...(oldest ? { before: oldest.id } : {})
              })
              yield* SubscriptionRef.update(ref, (state) =>
                remember(
                  projectId,
                  Option.map(state, (s) => addEarlier(s, page))
                )
              )
            }).pipe(Effect.ignore)
          )
        }),
        receive: (message) =>
          RcMap.has(entries, message.projectId).pipe(
            Effect.flatMap((open) =>
              open
                ? withState(message.projectId, (ref) =>
                    SubscriptionRef.update(ref, (state) =>
                      remember(
                        message.projectId,
                        Option.map(state, (s) => replaceMessage(s, message))
                      )
                    )
                  )
                : Effect.void
            )
          ),
        reconnect: Effect.gen(function* () {
          for (const projectId of yield* RcMap.keys(entries)) {
            yield* RcMap.get(entries, projectId).pipe(
              Effect.flatMap(({ restart }) => restart),
              Effect.scoped
            )
          }
        })
      })
    })
  )
}
