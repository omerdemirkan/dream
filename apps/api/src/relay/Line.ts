/**
 * Keeping a relay's line up: run its session, and when it ends, run another, backing off from a second to five
 * minutes (back to a second once a line has held for a minute). Each session gets the relay's key afresh, so a key
 * they replaced takes effect at the next reconnect. A session that ends `Fatal` fails the relay: the agent hears why,
 * and nothing runs until `Restart`.
 */
import { DateTime, Duration, Effect, Option, Ref } from "effect"
import { DiscordEndpoints, discordSession } from "./Discord.ts"
import type { Dialer } from "./Dialer.ts"
import { feedSession } from "./Feed.ts"
import type { Outbox } from "./Outbox.ts"
import { RelayGone, RelayHost } from "./RelayHost.ts"
import type { RelayConfig } from "./RelayRpcs.ts"
import { RelayStore } from "./RelayStore.ts"
import { SessionEnd, type SessionContext } from "./Session.ts"
import { describeRelay, enterState, noteProblem } from "./Status.ts"
import type { HttpClient } from "effect/http"

/** A line that held this long counts as healthy: the next reconnect starts the backoff again. */
export const HealthyAfter = Duration.minutes(1)

export const lineBackoff = (attempt: number): Duration.Duration =>
  Duration.millis(Math.min(5 * 60_000, 1000 * 2 ** Math.max(0, attempt - 1)))

const needsKey = (config: RelayConfig) => config.source._tag === "Discord" || config.source.integrationId !== undefined

/**
 * Runs the relay's line until it fails or the relay is gone. Fails with `RelayGone` when the project no longer holds
 * the relay.
 */
export const runLine = (
  outbox: Outbox
): Effect.Effect<void, RelayGone, RelayStore | RelayHost | Dialer | DiscordEndpoints | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const store = yield* RelayStore
    const host = yield* RelayHost
    let attempt = 0
    while (true) {
      const found = yield* store.config
      if (Option.isNone(found)) return
      const config = found.value
      const startedAt = yield* DateTime.now
      yield* store.updateRuntime((runtime) => enterState(runtime, "connecting", startedAt))

      const credential = needsKey(config)
        ? yield* host.credential(config.projectId, config.relayId).pipe(
            Effect.map((value) => ({ _tag: "Key" as const, value })),
            Effect.catchTag("InvalidRequest", (error) =>
              Effect.succeed({ _tag: "Refused" as const, reason: error.message })
            ),
            Effect.catchDefect((defect) =>
              Effect.succeed({
                _tag: "Unreachable" as const,
                reason: `Couldn't get the relay's key: ${String((defect as Error)?.message ?? defect)}`
              })
            )
          )
        : undefined

      let end: SessionEnd
      const openedAt = yield* Ref.make<DateTime.Utc | undefined>(undefined)
      if (credential?._tag === "Refused") {
        end = SessionEnd.Fatal({ reason: credential.reason })
      } else if (credential?._tag === "Unreachable") {
        end = SessionEnd.Retry({ reason: credential.reason })
      } else {
        const ctx: SessionContext = {
          config,
          credential: credential?._tag === "Key" ? Option.some(credential.value) : Option.none(),
          emit: (event) => outbox.add(config, event),
          connected: (account) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now
              yield* Ref.set(openedAt, now)
              yield* store.updateRuntime((runtime) => ({
                ...enterState(runtime, "connected", now),
                ...(account === undefined ? {} : { account })
              }))
            }),
          discord: {
            get: Effect.map(store.runtime, (runtime) => Option.fromUndefinedOr(runtime.discord)),
            set: (session) =>
              store
                .updateRuntime(({ discord: _, ...runtime }) =>
                  Option.match(session, { onNone: () => runtime, onSome: (discord) => ({ ...runtime, discord }) })
                )
                .pipe(Effect.asVoid)
          }
        }
        end = yield* Effect.scoped(config.source._tag === "Discord" ? discordSession(ctx) : feedSession(ctx))
      }

      const now = yield* DateTime.now
      if (end._tag === "Fatal") {
        const reason = end.reason
        yield* store.updateRuntime((runtime) => noteProblem(enterState(runtime, "failed", now), now, `${reason}.`))
        yield* host
          .alert(
            config.projectId,
            config.relayId,
            `${describeRelay(config)} stopped: ${reason}. \`dream relay restart ${config.relayId}\` once that's fixed.`
          )
          .pipe(Effect.catchDefect((defect) => Effect.logWarning("couldn't tell the agent the relay failed", defect)))
        return
      }
      const opened = yield* Ref.get(openedAt)
      const held = opened !== undefined && Duration.isGreaterThanOrEqualTo(DateTime.distance(opened, now), HealthyAfter)
      attempt = held ? 1 : attempt + 1
      const retry = end
      yield* store.updateRuntime((runtime) => {
        const waiting = enterState(runtime, "retrying", now)
        return retry.quiet === true ? waiting : noteProblem(waiting, now, `${retry.reason}.`)
      })
      yield* Effect.sleep(retry.wait ?? lineBackoff(attempt))
    }
  })
