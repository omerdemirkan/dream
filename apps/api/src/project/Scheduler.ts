/**
 * The ProjectDO's alarm: fires due wakes (as `WakeDue` events), delivers the
 * inbox, ends usage pauses, keeps a working sandbox awake, stops an idle Mac,
 * and settles finished browser sessions. Then points the alarm at the next
 * due thing.
 */
import { AgentEvent } from "@dream/domain"
import { Clock, Context, DateTime, Effect, Layer, Option } from "effect"
import { Users } from "../db/Users.ts"
import { newEventId } from "../lib/Ids.ts"
import { Alarm } from "./Alarm.ts"
import { Core } from "./Core.ts"
import { nextWakeAt } from "./Handlers.ts"
import { Machines } from "./Machines.ts"
import { SandboxManager } from "./SandboxManager.ts"
import { Store } from "./Store.ts"

export class Scheduler extends Context.Service<Scheduler, { readonly run: Effect.Effect<void> }>()(
  "@dream/api/project/Scheduler"
) {
  static readonly layer = Layer.effect(
    Scheduler,
    Effect.gen(function* () {
      const store = yield* Store
      const core = yield* Core
      const alarm = yield* Alarm
      const sandbox = yield* SandboxManager
      const machines = yield* Machines
      const users = yield* Users

      const fireWakes = (nowMs: number) =>
        Effect.gen(function* () {
          const due = yield* store.dueWakes(nowMs)
          if (due.length === 0) return
          const project = yield* core.project.pipe(Effect.orDie)
          const user = yield* users.find(project.ownerId)
          const timeZone = Option.match(user, { onNone: () => "UTC", onSome: (u) => u.timeZone ?? "UTC" })
          for (const wake of due) {
            yield* core.enqueue(
              AgentEvent.cases.WakeDue.make({
                id: yield* newEventId(),
                at: yield* DateTime.now,
                wakeId: wake.id,
                why: wake.why,
                ...(wake.run === undefined ? {} : { run: { command: wake.run } })
              })
            )
            const next = nextWakeAt(wake.when, timeZone, nowMs + 1000)
            if (Option.isSome(next)) {
              yield* store.putWake({ ...wake, nextAt: DateTime.makeUnsafe(next.value) }, next.value)
            } else {
              const { nextAt: _, ...fired } = wake
              yield* store.putWake(fired, undefined)
            }
          }
        })

      const usageReset = Effect.gen(function* () {
        yield* store.clearTimer("usage-reset")
        const pause = yield* core.usagePause
        if (Option.isNone(pause)) return
        yield* core.saveUsagePause(Option.none())
        if (pause.value.wakeOnReset) {
          yield* core.enqueue(
            AgentEvent.cases.UsageReset.make({
              id: yield* newEventId(),
              at: yield* DateTime.now,
              window: pause.value.window
            })
          )
        } else {
          // Deliver whatever arrived while paused.
          yield* store.setTimer("deliver", yield* Clock.currentTimeMillis)
        }
      })

      const run = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* fireWakes(now)
        for (const timer of yield* store.dueTimers(now)) {
          switch (timer) {
            case "usage-reset":
              yield* usageReset
              break
            case "turn-keepalive":
              yield* sandbox.keepalive
              break
            case "mac-idle":
              yield* machines.macIdleCheck
              break
            case "browser-sweep":
              yield* machines.sweepBrowsers
              break
            case "deliver":
            case "sandbox-retry":
              break
          }
        }
        // Deliver last, so events from wakes and resets above go out in this run.
        const due = yield* store.dueTimers(yield* Clock.currentTimeMillis)
        if (due.includes("deliver")) yield* sandbox.deliver
        yield* alarm.reschedule
      }).pipe(Effect.withSpan("Scheduler.run"))

      return Scheduler.of({ run })
    })
  )
}
