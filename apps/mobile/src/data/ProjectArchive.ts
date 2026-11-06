/**
 * Archiving, restoring and deleting projects.
 *
 * A project they archive or delete leaves Home at once: it's hidden on the
 * phone while the API catches up, and comes back if the call fails. Archive
 * and restore go out one at a time, in the order they were asked for, so
 * Undo right after Archive can't overtake it and leave the project archived.
 */
import type { ArchivedProject, NotFound, ProjectId, ProjectSummary, Unauthorized } from "@dream/domain"
import { Context, Effect, Layer, Semaphore, SubscriptionRef } from "effect"
import { Reactivity } from "effect/reactivity"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import { AppClient } from "./AppClient.ts"
import { type RequestTimedOut, withWriteTimeout } from "./errors.ts"

/** Reactivity keys refreshed after a project is archived, restored or deleted. */
export const projectsChanged = ["projects", "archived", "integrations"] as const

type Failure = NotFound | Unauthorized | RpcClientError | RequestTimedOut

export class ProjectArchive extends Context.Service<
  ProjectArchive,
  {
    /** Projects archived or deleted from this phone, which Home leaves out whatever its last list says. */
    readonly hidden: SubscriptionRef.SubscriptionRef<ReadonlySet<ProjectId>>
    readonly archive: (projectId: ProjectId) => Effect.Effect<ArchivedProject, Failure>
    readonly restore: (projectId: ProjectId) => Effect.Effect<ProjectSummary, Failure>
    /** Deleting one that's already gone succeeds. */
    readonly remove: (projectId: ProjectId) => Effect.Effect<void, Exclude<Failure, NotFound>>
  }
>()("@dream/mobile/ProjectArchive") {
  static readonly layer = Layer.effect(
    ProjectArchive,
    Effect.gen(function* () {
      const app = yield* AppClient
      const reactivity = yield* Reactivity.Reactivity
      const hidden = yield* SubscriptionRef.make<ReadonlySet<ProjectId>>(new Set())
      const inOrder = yield* Semaphore.make(1)

      const hide = (projectId: ProjectId) => SubscriptionRef.update(hidden, (set) => new Set(set).add(projectId))
      const show = (projectId: ProjectId) =>
        SubscriptionRef.update(hidden, (set) => {
          const next = new Set(set)
          next.delete(projectId)
          return next
        })
      const changed = reactivity.invalidate(projectsChanged)

      const archive = Effect.fn("ProjectArchive.archive")(function* (projectId: ProjectId) {
        yield* hide(projectId)
        return yield* inOrder
          .withPermits(1)(app.ArchiveProject({ projectId }).pipe(withWriteTimeout))
          .pipe(
            Effect.tapError(() => show(projectId)),
            Effect.ensuring(changed)
          )
      })

      const restore = Effect.fn("ProjectArchive.restore")(function* (projectId: ProjectId) {
        const summary = yield* inOrder
          .withPermits(1)(app.RestoreProject({ projectId }).pipe(withWriteTimeout))
          .pipe(Effect.ensuring(changed))
        yield* show(projectId)
        return summary
      })

      const remove = Effect.fn("ProjectArchive.remove")(function* (projectId: ProjectId) {
        yield* hide(projectId)
        yield* app.DeleteProject({ projectId }).pipe(
          withWriteTimeout,
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.tapError(() => show(projectId)),
          Effect.ensuring(changed)
        )
      })

      return ProjectArchive.of({ hidden, archive, restore, remove })
    })
  )
}
