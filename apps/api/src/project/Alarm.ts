/**
 * The DO's single native alarm. The project's timers and wakes live in its
 * SQLite; `reschedule` points the alarm at the earliest of them.
 */
import { Context, Effect, Layer, Option } from "effect"
import { Singletons, Store } from "./Store.ts"

export class NativeAlarm extends Context.Service<
  NativeAlarm,
  {
    readonly set: (atMs: number) => Effect.Effect<void>
    readonly clear: Effect.Effect<void>
  }
>()("@dream/api/project/NativeAlarm") {
  static readonly fromStorage = (storage: {
    setAlarm(scheduledTime: number): Promise<void>
    deleteAlarm(): Promise<void>
  }) =>
    Layer.succeed(
      NativeAlarm,
      NativeAlarm.of({
        set: (atMs) => Effect.promise(() => storage.setAlarm(atMs)),
        clear: Effect.promise(() => storage.deleteAlarm())
      })
    )

  static readonly layerTest = (calls: Array<number | null>) =>
    Layer.succeed(
      NativeAlarm,
      NativeAlarm.of({
        set: (atMs) => Effect.sync(() => void calls.push(atMs)),
        clear: Effect.sync(() => void calls.push(null))
      })
    )
}

export class Alarm extends Context.Service<Alarm, { readonly reschedule: Effect.Effect<void> }>()(
  "@dream/api/project/Alarm"
) {
  static readonly layer = Layer.effect(
    Alarm,
    Effect.gen(function* () {
      const store = yield* Store
      const native = yield* NativeAlarm
      const reschedule = Effect.gen(function* () {
        const timers = yield* store.nextTimerMs
        // An archived project's wakes wait: the ones that come due fire once it's restored.
        const archived = Option.isSome(yield* store.getSingleton(...Singletons.archived))
        const wakes = archived ? Option.none<number>() : yield* store.nextWakeMs
        const next = [timers, wakes].flatMap((value) => (Option.isSome(value) ? [value.value] : []))
        if (next.length === 0) return yield* native.clear
        yield* native.set(Math.min(...next))
      })
      return Alarm.of({ reschedule })
    })
  )
}
