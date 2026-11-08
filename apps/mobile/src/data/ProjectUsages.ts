/**
 * A project's use of the subscription: the usage sheet (`AppRpcs.GetProjectUsage`), and the header's figures,
 * which start from that fetch when the project opens and then follow `ProjectEvent.Usage` on the live stream.
 */
import type { ProjectId, ProjectUsage, ProjectUsageGlance, UsageLimits } from "@dream/domain"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { AppClient, type AppRpcClient } from "./AppClient.ts"
import { ProjectStates } from "./ProjectStates.ts"
import { latestGlance } from "./usage.ts"

type UsageError = Effect.Error<ReturnType<AppRpcClient["GetProjectUsage"]>>
type LimitsError = Effect.Error<ReturnType<AppRpcClient["SetUsageLimits"]>>

export class ProjectUsages extends Context.Service<
  ProjectUsages,
  {
    /** The usage sheet, fetched fresh. */
    readonly sheet: (projectId: ProjectId) => Effect.Effect<ProjectUsage, UsageError>
    /** Sets both limits (an absent one is cleared), and returns the sheet as it is now. */
    readonly setLimits: (projectId: ProjectId, limits: UsageLimits) => Effect.Effect<ProjectUsage, LimitsError>
    /**
     * The header's figures as they change: the newest of the fetched usage and the live stream's, by when each
     * was observed. `undefined` until either arrives, or if neither does (the header then shows nothing).
     */
    readonly glance: (projectId: ProjectId) => Stream.Stream<ProjectUsageGlance | undefined>
  }
>()("@dream/mobile/ProjectUsages") {
  static readonly layer = Layer.effect(
    ProjectUsages,
    Effect.gen(function* () {
      const app = yield* AppClient
      const states = yield* ProjectStates
      const sheet = Effect.fn("ProjectUsages.sheet")(function* (projectId: ProjectId) {
        return yield* app.GetProjectUsage({ projectId })
      })
      const setLimits = Effect.fn("ProjectUsages.setLimits")(function* (projectId: ProjectId, limits: UsageLimits) {
        return yield* app.SetUsageLimits({ projectId, limits })
      })
      return ProjectUsages.of({
        sheet,
        setLimits,
        glance: (projectId) =>
          Stream.merge(
            // An API that predates GetProjectUsage, or a failed fetch, leaves the live stream to say.
            Stream.fromEffect(sheet(projectId).pipe(Effect.option, Effect.map(Option.getOrUndefined))),
            states.state(projectId).pipe(Stream.map((state) => Option.getOrUndefined(state)?.usage))
          ).pipe(
            Stream.scan((): ProjectUsageGlance | undefined => undefined, latestGlance),
            Stream.changesWith((a, b) => a === b)
          )
      })
    })
  )
}
