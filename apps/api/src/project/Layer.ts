/**
 * A ProjectDO's own services, over its SQLite storage and native alarm.
 * Kept apart from ProjectDO.ts (which needs workerd) so tests can build it.
 */
import type { DurableObjectStorage } from "@cloudflare/workers-types"
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient"
import { Layer } from "effect"
import { SandboxMove } from "../e2b/Move.ts"
import { SandboxRefresh } from "../e2b/Refresh.ts"
import { Alarm, NativeAlarm } from "./Alarm.ts"
import { AppNotifications } from "./AppNotifications.ts"
import { Core } from "./Core.ts"
import { LiveFeed } from "./Live.ts"
import { Machines } from "./Machines.ts"
import { Notifier } from "./Notifier.ts"
import { ProjectLog } from "./ProjectLog.ts"
import { Relays } from "./Relays.ts"
import { SandboxManager } from "./SandboxManager.ts"
import { Scheduler } from "./Scheduler.ts"
import { migrate, Store } from "./Store.ts"
import { UsageLimiter } from "./UsageLimits.ts"

export const projectLayer = (
  storage: DurableObjectStorage,
  nativeAlarm: Layer.Layer<NativeAlarm> = NativeAlarm.fromStorage(storage)
) => {
  const sql = SqliteClient.layer({ storage })
  const store = Layer.mergeAll(Store.layer, Layer.effectDiscard(migrate)).pipe(Layer.provide(sql))
  const alarm = Alarm.layer.pipe(Layer.provide(nativeAlarm))
  const core = ProjectLog.layer.pipe(
    Layer.provideMerge(Core.layer.pipe(Layer.provideMerge(Layer.mergeAll(LiveFeed.layer, alarm))))
  )
  const sandbox = SandboxManager.layer.pipe(Layer.provide([SandboxRefresh.layer, SandboxMove.layer]))
  const domain = Layer.mergeAll(Notifier.layer, sandbox, Machines.layer).pipe(Layer.provideMerge(core))
  const limits = UsageLimiter.layer.pipe(Layer.provideMerge(domain))
  return Layer.mergeAll(Scheduler.layer, Relays.layer, AppNotifications.layer).pipe(
    Layer.provideMerge(limits),
    Layer.provideMerge(store)
  )
}
