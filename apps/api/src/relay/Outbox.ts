/**
 * The events a relay has received and the app hasn't taken yet. Each is wrapped in a `RelayDelivery`, stored (so a
 * restart loses nothing), and handed to the project in order, a few at a time. When the app doesn't take one, the
 * rest wait, and the batch goes again after a backoff that grows to ten minutes: the sandbox may be waking, the app
 * restarting, or the route not written yet. Limits keep a stuck relay from growing without bound: events over
 * `RelayEventMaxBytes` are dropped, the queue keeps the newest `RelayQueueLimit`, and nothing waits more than
 * `RelayEventMaxAgeHours`. After an hour of failures the agent hears about it, once, until a delivery goes through.
 */
import {
  RelayDelivery,
  RelayEventMaxAgeHours,
  RelayEventMaxBytes,
  RelayQueueLimit,
  type RelayForward,
  type RelayForwardResult
} from "@dream/domain"
import { Clock, DateTime, Duration, Effect, Option, Queue } from "effect"
import { encodeJson } from "../db/Sql.ts"
import { RelayGone, RelayHost } from "./RelayHost.ts"
import type { RelayConfig } from "./RelayRpcs.ts"
import { RelayStore } from "./RelayStore.ts"
import type { Received } from "./Session.ts"
import { describeRelay, noteProblem } from "./Status.ts"

/** Events handed over per call. */
export const BatchSize = 10
/** While a usage limit holds the project, how often to look again. */
const HeldRecheckMs = 5 * 60_000
/** Failing this long, the agent hears about it. */
export const AlertAfter = Duration.hours(1)

export const deliveryBackoff = (failures: number): Duration.Duration =>
  Duration.millis(Math.min(10 * 60_000, 5_000 * 3 ** Math.max(0, failures - 1)))

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength

export const makeOutbox = Effect.gen(function* () {
  const store = yield* RelayStore
  const host = yield* RelayHost
  /** Wakes the drain when something's added. */
  const signal = yield* Queue.sliding<void>(1)

  const add = (config: RelayConfig, event: Received) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const body = encodeJson(RelayDelivery, {
        id: event.id,
        relay: config.relayId,
        source: config.source._tag === "Discord" ? "discord" : "websocket",
        ...(event.type === undefined ? {} : { type: event.type }),
        at: now,
        data: event.data,
        ...(event.binary === true ? { binary: true } : {})
      })
      const size = byteLength(body)
      if (size > RelayEventMaxBytes) {
        yield* store.updateRuntime((runtime) =>
          noteProblem(
            { ...runtime, dropped: runtime.dropped + 1, lastEventAt: now },
            now,
            `Dropped an event of ${Math.round(size / 1024)} KB; the most a relay delivers is ${RelayEventMaxBytes / 1024} KB.`
          )
        )
        return
      }
      const added = yield* store.enqueue({ id: event.id, atMs: DateTime.toEpochMillis(now), body })
      if (!added) return
      const trimmed = yield* store.trim(RelayQueueLimit)
      yield* store.updateRuntime((runtime) => {
        const next = { ...runtime, lastEventAt: now, dropped: runtime.dropped + trimmed }
        return trimmed === 0
          ? next
          : noteProblem(next, now, `${RelayQueueLimit} events were waiting, so the oldest were dropped.`)
      })
      yield* Queue.offer(signal, undefined)
    })

  /** One pass: hand over the oldest batch. `Some(wait)` when it should wait before the next pass. */
  const deliverOnce = (config: RelayConfig, failures: number) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis
      const expired = yield* store.expire(nowMs - RelayEventMaxAgeHours * 3600_000)
      if (expired > 0) {
        const now = yield* DateTime.now
        yield* store.updateRuntime((runtime) =>
          noteProblem(
            { ...runtime, dropped: runtime.dropped + expired },
            now,
            `Dropped ${expired} event${expired === 1 ? "" : "s"} the app didn't take within ${RelayEventMaxAgeHours} hours.`
          )
        )
      }
      const batch = yield* store.oldest(BatchSize)
      const [first, ...rest] = batch
      if (first === undefined) return { failures: 0, idle: true }
      const deliveries: readonly [RelayForward, ...Array<RelayForward>] = [first, ...rest].map(({ id, body }) => ({
        id,
        body
      })) as unknown as readonly [RelayForward, ...Array<RelayForward>]
      const result = yield* host.deliver(config.projectId, config.relayId, deliveries).pipe(
        Effect.catchDefect((defect) =>
          Effect.succeed<RelayForwardResult>({
            delivered: 0,
            failure: { message: `Couldn't reach the project: ${String((defect as Error)?.message ?? defect)}` }
          })
        )
      )
      // A usage limit they set holds the project: wait without counting it a failure, and look again now and then
      // in case they raised it.
      if (result.heldUntil !== undefined) {
        const left = DateTime.toEpochMillis(result.heldUntil) - nowMs
        return { failures, idle: false, wait: Duration.millis(Math.max(1_000, Math.min(left, HeldRecheckMs))) }
      }
      const delivered = Math.max(0, Math.min(result.delivered, batch.length))
      yield* store.remove(batch.slice(0, delivered).map((event) => event.id))
      const now = yield* DateTime.now
      if (result.failure === undefined) {
        yield* store.updateRuntime(({ deliveryFailingSince: _s, deliveryAlerted: _a, ...runtime }) => ({
          ...runtime,
          delivered: runtime.delivered + delivered,
          ...(delivered > 0 ? { lastDeliveredAt: now } : {})
        }))
        return { failures: 0, idle: false }
      }
      const failure = result.failure
      const runtime = yield* store.updateRuntime((current) =>
        noteProblem(
          {
            ...current,
            delivered: current.delivered + delivered,
            ...(delivered > 0 ? { lastDeliveredAt: now } : {}),
            deliveryFailingSince: current.deliveryFailingSince ?? now
          },
          now,
          failure.message
        )
      )
      const failingFor = DateTime.distance(runtime.deliveryFailingSince ?? now, now)
      if (runtime.deliveryAlerted !== true && Duration.isGreaterThanOrEqualTo(failingFor, AlertAfter)) {
        const waiting = yield* store.waiting
        yield* host.alert(
          config.projectId,
          config.relayId,
          `${describeRelay(config)} hasn't been able to deliver to ${config.target.path} for over an hour: ${failure.message} ${waiting} event${waiting === 1 ? " is" : "s are"} waiting; it keeps trying, and drops events a day old.`
        )
        yield* store.updateRuntime((current) => ({ ...current, deliveryAlerted: true }))
      }
      return { failures: failures + 1, idle: false, wait: deliveryBackoff(failures + 1) }
    })

  /** Delivers forever, while the relay exists. Ends when the project says it's gone. */
  const drain: Effect.Effect<void, RelayGone> = Effect.gen(function* () {
    let failures = 0
    while (true) {
      const config = yield* store.config
      if (Option.isNone(config)) return
      const pass = yield* deliverOnce(config.value, failures)
      failures = pass.failures
      if (pass.wait !== undefined) yield* Effect.sleep(pass.wait)
      else if (pass.idle) yield* Queue.take(signal).pipe(Effect.timeoutOption("1 minute"))
    }
  })

  return { add, drain, wake: Queue.offer(signal, undefined) }
})

export type Outbox = Effect.Success<typeof makeOutbox>
