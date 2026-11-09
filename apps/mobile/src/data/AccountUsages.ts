/**
 * Settings' plan page: one subscription's windows split between their projects and the rest, and each project's
 * share of the week (`AppRpcs.GetAccountUsage`).
 */
import type { AccountUsage, ModelProvider } from "@dream/domain"
import { Context, Effect, Exit, Layer } from "effect"
import { AppClient } from "./AppClient.ts"

export class AccountUsages extends Context.Service<
  AccountUsages,
  {
    /**
     * Fetched fresh. `undefined` when the API can't say: an API from before `GetAccountUsage` (which answers with
     * an unknown-request defect, not a typed error), a subscription that isn't connected, or a failed fetch. The
     * card then shows the connection's own usage without project shares.
     */
    readonly plan: (provider: ModelProvider) => Effect.Effect<AccountUsage | undefined>
  }
>()("@dream/mobile/AccountUsages") {
  static readonly layer = Layer.effect(
    AccountUsages,
    Effect.gen(function* () {
      const app = yield* AppClient
      const plan = Effect.fn("AccountUsages.plan")(function* (provider: ModelProvider) {
        const exit = yield* Effect.exit(app.GetAccountUsage({ provider }))
        if (Exit.isSuccess(exit)) return exit.value
        yield* Effect.logDebug("No account usage", exit.cause)
        return undefined
      })
      return AccountUsages.of({ plan })
    })
  )
}
