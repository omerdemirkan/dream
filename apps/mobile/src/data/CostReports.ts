/**
 * What Dream pays to run their projects (`AppRpcs.GetProjectCosts`, `AppRpcs.GetAccountCosts`), for the usage
 * sheet's section and Settings. Not their plan's usage, which is `ProjectUsages` and `AccountUsages`.
 */
import type { AccountCosts, ProjectCosts, ProjectId } from "@dream/domain"
import { Context, Effect, Exit, Layer } from "effect"
import { AppClient } from "./AppClient.ts"

export class CostReports extends Context.Service<
  CostReports,
  {
    /**
     * Fetched fresh. `undefined` when the API can't say (one from before the cost RPCs answers with a defect, not a
     * typed error) or the fetch failed: the app then shows no costs rather than an error, since they're extra.
     */
    readonly project: (projectId: ProjectId) => Effect.Effect<ProjectCosts | undefined>
    readonly account: () => Effect.Effect<AccountCosts | undefined>
  }
>()("@dream/mobile/CostReports") {
  static readonly layer = Layer.effect(
    CostReports,
    Effect.gen(function* () {
      const app = yield* AppClient
      const orUndefined = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.exit(effect).pipe(
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? Effect.succeed<A | undefined>(exit.value)
              : Effect.as(Effect.logDebug("No costs", exit.cause), undefined)
          )
        )
      const project = Effect.fn("CostReports.project")(function* (projectId: ProjectId) {
        return yield* orUndefined(app.GetProjectCosts({ projectId }))
      })
      const account = Effect.fn("CostReports.account")(function* () {
        return yield* orUndefined(app.GetAccountCosts())
      })
      return CostReports.of({ project, account })
    })
  )
}
