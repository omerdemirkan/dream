/**
 * When a downloaded over-the-air update takes over. Never under someone's hands: it runs from the next launch,
 * or when the app comes back after a long while in the background, which is a fresh start in all but name
 * (answers held for Undo were sent when it left). Coming back sooner only looks for one. Nothing is shown;
 * Settings says what's running and offers a restart once an update is ready.
 */
import { Effect } from "effect"
import * as Updates from "expo-updates"
import { useEffect, useRef } from "react"
import { AppState } from "react-native"
import { applyUpdate, fetchNewerUpdate, updatesEnabled } from "../platform/updates.ts"

/** Away this long, the app restarts on a downloaded update when it comes back. */
const longAwayMs = 15 * 60_000
/** Away this long, it asks the server again when it comes back. */
const checkAfterMs = 60_000

export function UpdatesHost() {
  const { isUpdatePending } = Updates.useUpdates()
  const pending = useRef(isUpdatePending)
  pending.current = isUpdatePending

  useEffect(() => {
    if (!updatesEnabled) return
    let leftAt: number | undefined
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        leftAt = Date.now()
        return
      }
      if (state !== "active" || leftAt === undefined) return
      const away = Date.now() - leftAt
      leftAt = undefined
      if (pending.current && away >= longAwayMs) void Effect.runPromise(applyUpdate.pipe(Effect.ignore))
      else if (away >= checkAfterMs) void Effect.runPromise(fetchNewerUpdate.pipe(Effect.ignore))
    })
    return () => subscription.remove()
  }, [])

  return null
}
