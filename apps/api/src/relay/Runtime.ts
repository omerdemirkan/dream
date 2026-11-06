/**
 * What a RelayDO does: hold one relay. `Start` stores it and runs two loops in the object, the line (`Line.ts`) and
 * the outbox's drain (`Outbox.ts`). The object's alarm fires every minute while either has work, and starts them again
 * after the object restarts (a deploy, or Cloudflare moving it), and every ten minutes it asks the project whether the
 * relay is still wanted. A relay the project no longer holds forgets everything and lets its object go idle; so does
 * a failed relay once nothing waits for the app.
 */
import { NotFound } from "@dream/domain"
import { Clock, Context, DateTime, Duration, Effect, FiberHandle, Layer, Option } from "effect"
import type { HttpClient } from "effect/http"
import { NativeAlarm } from "../project/Alarm.ts"
import type { Dialer } from "./Dialer.ts"
import type { DiscordEndpoints } from "./Discord.ts"
import { runLine } from "./Line.ts"
import { makeOutbox } from "./Outbox.ts"
import { type RelayGone, RelayHost } from "./RelayHost.ts"
import type { RelayConfig, RelayStatus } from "./RelayRpcs.ts"
import { initialRuntime, RelayStore } from "./RelayStore.ts"
import { toStatus } from "./Status.ts"

export const AlarmEvery = Duration.minutes(1)
/** How often a relay asks whether it's still wanted. */
export const CheckEvery = Duration.minutes(10)

export class RelayRuntime extends Context.Service<
  RelayRuntime,
  {
    readonly start: (config: RelayConfig) => Effect.Effect<RelayStatus>
    readonly stop: Effect.Effect<void>
    readonly restart: Effect.Effect<RelayStatus, NotFound>
    readonly status: Effect.Effect<RelayStatus, NotFound>
    /** The alarm: start whatever should run and isn't, check in with the project now and then, and set the next. */
    readonly alarm: Effect.Effect<void>
  }
>()("@dream/api/relay/RelayRuntime") {
  static readonly layer: Layer.Layer<
    RelayRuntime,
    never,
    RelayStore | RelayHost | NativeAlarm | Dialer | DiscordEndpoints | HttpClient.HttpClient
  > = Layer.effect(
    RelayRuntime,
    Effect.gen(function* () {
      const store = yield* RelayStore
      const host = yield* RelayHost
      const native = yield* NativeAlarm
      const outbox = yield* makeOutbox
      const line = yield* FiberHandle.make<void>()
      const drain = yield* FiberHandle.make<void>()
      const services = yield* Effect.context<
        RelayStore | RelayHost | Dialer | DiscordEndpoints | HttpClient.HttpClient
      >()

      const status = Effect.gen(function* () {
        if (Option.isNone(yield* store.config)) return yield* new NotFound({ entity: "relay", id: "this object" })
        return toStatus(yield* store.runtime, yield* store.waiting)
      })

      const reschedule = Effect.gen(function* () {
        const config = yield* store.config
        const runtime = yield* store.runtime
        const waiting = yield* store.waiting
        if (Option.isNone(config) || (runtime.state === "failed" && waiting === 0)) return yield* native.clear
        yield* native.set((yield* Clock.currentTimeMillis) + Duration.toMillis(AlarmEvery))
      })

      /** The project no longer holds this relay: close the line, drop everything, and let the object go idle. */
      const forget = Effect.gen(function* () {
        yield* store.wipe
        yield* native.clear
        yield* Effect.logInfo("the relay is no longer wanted; forgot it")
        // Interrupted from outside either loop, since this may run inside one of them.
        yield* Effect.forkDetach(Effect.andThen(FiberHandle.clear(line), FiberHandle.clear(drain)))
      })

      const loop = (
        name: string,
        effect: Effect.Effect<
          void,
          RelayGone,
          RelayStore | RelayHost | Dialer | DiscordEndpoints | HttpClient.HttpClient
        >
      ): Effect.Effect<void> =>
        effect.pipe(
          Effect.catchTag("RelayGone", () => forget),
          Effect.catchCause((cause) => Effect.logError(`the relay's ${name} stopped`, cause)),
          Effect.provideContext(services)
        )

      /** Starts the loops that should run and aren't. */
      const ensure = Effect.gen(function* () {
        const config = yield* store.config
        if (Option.isNone(config)) return
        const runtime = yield* store.runtime
        if (runtime.state !== "failed") {
          yield* FiberHandle.run(line, loop("line", runLine(outbox)), { onlyIfMissing: true })
        }
        yield* FiberHandle.run(drain, loop("outbox", outbox.drain), { onlyIfMissing: true })
      })

      const checkIn = Effect.gen(function* () {
        const config = yield* store.config
        if (Option.isNone(config)) return
        const runtime = yield* store.runtime
        const now = yield* DateTime.now
        if (
          runtime.checkedAt !== undefined &&
          Duration.isLessThan(DateTime.distance(runtime.checkedAt, now), CheckEvery)
        ) {
          return
        }
        const active = yield* host
          .active(config.value.projectId, config.value.relayId)
          .pipe(Effect.catchDefect(() => Effect.succeed(true)))
        if (!active) return yield* forget
        yield* store.updateRuntime((current) => ({ ...current, checkedAt: now }))
      })

      const openAfresh = Effect.gen(function* () {
        yield* FiberHandle.clear(line)
        const now = yield* DateTime.now
        yield* store.updateRuntime(({ discord: _, ...runtime }) => ({ ...runtime, state: "connecting", since: now }))
        yield* ensure
        yield* reschedule
      })

      return RelayRuntime.of({
        start: (config) =>
          Effect.gen(function* () {
            const existing = yield* store.config
            yield* store.saveConfig(config)
            if (Option.isNone(existing)) {
              const now = yield* DateTime.now
              yield* store.updateRuntime(() => ({ ...initialRuntime, since: now, checkedAt: now }))
            }
            yield* openAfresh
            yield* outbox.wake
            return yield* status.pipe(Effect.orDie)
          }),
        stop: Effect.gen(function* () {
          yield* FiberHandle.clear(line)
          yield* FiberHandle.clear(drain)
          yield* store.wipe
          yield* native.clear
        }),
        restart: Effect.gen(function* () {
          yield* status
          yield* openAfresh
          yield* outbox.wake
          return yield* status
        }),
        status,
        alarm: Effect.gen(function* () {
          yield* checkIn
          yield* ensure
          yield* reschedule
        }).pipe(Effect.catchCause((cause) => Effect.logError("the relay's alarm failed", cause)))
      })
    })
  )
}
