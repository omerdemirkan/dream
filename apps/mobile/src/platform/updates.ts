/**
 * Over-the-air updates through stock expo-updates (config in app.config.ts, server in apps/api's
 * http/Updates.ts). expo-updates checks on every launch by itself and runs what it downloaded from the next
 * launch on; this adds only the moments Dream applies or looks for one in between, through its public API.
 */
import { Data, Effect } from "effect"
import * as Updates from "expo-updates"

export class UpdatesError extends Data.TaggedError("UpdatesError")<{
  readonly step: string
  readonly cause: unknown
}> {}

/** False in development builds (JavaScript from Metro) and builds without a signing certificate. */
export const updatesEnabled = Updates.isEnabled

/** Downloads a newer update if the server has one; it runs after the next reload. */
export const fetchNewerUpdate = Effect.gen(function* () {
  const check = yield* Effect.tryPromise({
    try: () => Updates.checkForUpdateAsync(),
    catch: (cause) => new UpdatesError({ step: "check", cause })
  })
  if (!check.isAvailable) return false
  const fetched = yield* Effect.tryPromise({
    try: () => Updates.fetchUpdateAsync(),
    catch: (cause) => new UpdatesError({ step: "fetch", cause })
  })
  return fetched.isNew
})

/** Restarts the JavaScript on the downloaded update. */
export const applyUpdate = Effect.tryPromise({
  try: () => Updates.reloadAsync(),
  catch: (cause) => new UpdatesError({ step: "reload", cause })
})

/** What's running, for Settings: the update's id and date, or nothing for the bundle the build shipped with. */
export const runningUpdate = (): { readonly id: string; readonly createdAt: Date } | undefined =>
  Updates.isEnabled && !Updates.isEmbeddedLaunch && Updates.updateId !== null && Updates.createdAt !== null
    ? { id: Updates.updateId, createdAt: Updates.createdAt }
    : undefined
