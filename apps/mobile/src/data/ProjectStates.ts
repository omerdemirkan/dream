/**
 * Open projects, each folded from its live stream into a `ProjectState`.
 *
 * A project's subscription starts when a screen first needs it and lingers for
 * a short while after the last one lets go, so moving between Home, Status,
 * Chat and the expanded view doesn't reconnect.
 */
import type { Message, ProjectId } from "@dream/domain"
import { Context, Effect, FiberHandle, Layer, Option, RcMap, Stream, SubscriptionRef } from "effect"
import { AppClient } from "./AppClient.ts"
import { LiveProjects } from "./LiveProjects.ts"
import { addEarlier, applyEvent, type ProjectState, replaceMessage } from "./projectState.ts"

export class ProjectStates extends Context.Service<
  ProjectStates,
  {
    /** The project's state as it changes; `None` until the first snapshot arrives. */
    readonly state: (projectId: ProjectId) => Stream.Stream<Option.Option<ProjectState>>
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

      const entries = yield* RcMap.make({
        lookup: (projectId: ProjectId) =>
          Effect.gen(function* () {
            const ref = yield* SubscriptionRef.make<Option.Option<ProjectState>>(Option.none())
            const handle = yield* FiberHandle.make()
            const restart = FiberHandle.run(
              handle,
              live
                .subscribe(projectId)
                .pipe(
                  Stream.runForEach((event) =>
                    SubscriptionRef.update(ref, (state) =>
                      Option.fromUndefinedOr(applyEvent(Option.getOrUndefined(state), event))
                    )
                  )
                )
            ).pipe(Effect.asVoid)
            yield* restart
            return { ref, restart }
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
              yield* SubscriptionRef.update(
                ref,
                Option.map((state) => addEarlier(state, page))
              )
            }).pipe(Effect.ignore)
          )
        }),
        receive: (message) =>
          RcMap.has(entries, message.projectId).pipe(
            Effect.flatMap((open) =>
              open
                ? withState(message.projectId, (ref) =>
                    SubscriptionRef.update(
                      ref,
                      Option.map((state) => replaceMessage(state, message))
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
