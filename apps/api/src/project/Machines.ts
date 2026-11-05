/**
 * Machines the agent rents beyond its sandbox: Browserbase sessions and a
 * Namespace Mac. The DO tracks them for `dream browser|mac`, stops idle Macs,
 * and records their minutes in the usage ledger.
 */
import {
  type BrowserSession,
  type BrowserSessionId,
  InvalidRequest,
  type MacSshAccess,
  type MacStatus,
  NotFound,
  UpstreamFailure
} from "@dream/domain"
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Redacted } from "effect"
import { Browserbase } from "../brokers/Browserbase.ts"
import { Namespace } from "../brokers/Namespace.ts"
import { type UsageKind, Projects } from "../db/Projects.ts"
import { newBrowserSessionId } from "../lib/Ids.ts"
import { Alarm } from "./Alarm.ts"
import { Core } from "./Core.ts"
import { type MacRecord, Singletons, Store } from "./Store.ts"

export const MacIdleTimeout = Duration.minutes(20)
/** Each Mac is created with this deadline and extended while used. */
const MacLifetime = Duration.minutes(90)
const BrowserSweepEvery = Duration.minutes(10)

/** Billed minutes: Browserbase and Namespace both bill a minimum of one minute. */
const minutesBetween = (start: DateTime.Utc, end: DateTime.Utc) =>
  Math.max(1, Math.ceil((DateTime.toEpochMillis(end) - DateTime.toEpochMillis(start)) / 60_000))

export class Machines extends Context.Service<
  Machines,
  {
    readonly startBrowser: Effect.Effect<BrowserSession, UpstreamFailure>
    readonly stopBrowser: (id: BrowserSessionId) => Effect.Effect<void, NotFound | UpstreamFailure>
    readonly browserRecording: (
      id: BrowserSessionId
    ) => Effect.Effect<
      { readonly url: string; readonly contentType: string },
      NotFound | InvalidRequest | UpstreamFailure
    >
    /** Records minutes for sessions that ended on their own (the CDP connection closed). */
    readonly sweepBrowsers: Effect.Effect<void>

    readonly startMac: Effect.Effect<MacStatus, UpstreamFailure>
    readonly mac: Effect.Effect<MacStatus>
    readonly macSsh: Effect.Effect<MacSshAccess, InvalidRequest | UpstreamFailure>
    readonly stopMac: Effect.Effect<void, UpstreamFailure>
    /** Stops the Mac if nothing used it for `MacIdleTimeout`. */
    readonly macIdleCheck: Effect.Effect<void>
  }
>()("@dream/api/project/Machines") {
  static readonly layer = Layer.effect(
    Machines,
    Effect.gen(function* () {
      const core = yield* Core
      const store = yield* Store
      const alarm = yield* Alarm
      const projects = yield* Projects
      const browserbase = yield* Browserbase
      const namespace = yield* Namespace

      const recordUsage = (kind: UsageKind, ref: string, startedAt: DateTime.Utc, endedAt: DateTime.Utc) =>
        Effect.gen(function* () {
          const project = yield* core.project.pipe(Effect.orDie)
          yield* projects.recordUsage({
            id: `use_${kind}_${ref}`.slice(0, 120),
            projectId: project.id,
            userId: project.ownerId,
            kind,
            ref,
            startedAt,
            endedAt,
            minutes: minutesBetween(startedAt, endedAt)
          })
        })

      const setTimerIn = (name: "mac-idle" | "browser-sweep", after: Duration.Input) =>
        Effect.gen(function* () {
          yield* store.setTimer(
            name,
            (yield* Clock.currentTimeMillis) + Duration.toMillis(Duration.fromInputUnsafe(after))
          )
          yield* alarm.reschedule
        })

      // Browser -------------------------------------------------------------------

      const startBrowser = Effect.gen(function* () {
        const project = yield* core.project.pipe(Effect.orDie)
        const created = yield* browserbase.create({ dreamProject: project.id })
        const id = yield* newBrowserSessionId()
        const startedAt = yield* DateTime.now
        yield* store.putBrowser({ id, providerId: created.session.id, startedAt })
        yield* setTimerIn("browser-sweep", BrowserSweepEvery)
        return { id, cdpUrl: created.connectUrl, liveViewUrl: created.liveViewUrl, startedAt }
      }).pipe(Effect.withSpan("Machines.startBrowser"))

      const findBrowser = (id: BrowserSessionId) =>
        Effect.flatMap(store.browser(id), (found) =>
          Option.match(found, {
            onNone: () => Effect.fail(new NotFound({ entity: "browser session", id })),
            onSome: Effect.succeed
          })
        )

      const markEnded = (
        id: string,
        providerId: string,
        startedAt: DateTime.Utc,
        endedAtIso: string | null | undefined
      ) =>
        Effect.gen(function* () {
          const endedAt = endedAtIso ? DateTime.makeUnsafe(endedAtIso) : yield* DateTime.now
          yield* store.putBrowser({ id, providerId, startedAt, endedAt })
          yield* recordUsage("browser", providerId, startedAt, endedAt)
        })

      const stopBrowser = Effect.fn("Machines.stopBrowser")(function* (id: BrowserSessionId) {
        const record = yield* findBrowser(id)
        if (record.endedAt !== undefined) return
        const released = yield* browserbase.release(record.providerId)
        yield* markEnded(record.id, record.providerId, record.startedAt, released.endedAt)
      })

      const browserRecording = Effect.fn("Machines.browserRecording")(function* (id: BrowserSessionId) {
        const record = yield* findBrowser(id)
        if (record.endedAt === undefined) {
          const session = yield* browserbase.get(record.providerId)
          if (session.status === "RUNNING" || session.status === "PENDING") {
            return yield* new InvalidRequest({
              message: `The browser session is still running. Stop it first with \`dream browser stop ${id}\`.`
            })
          }
          yield* markEnded(record.id, record.providerId, record.startedAt, session.endedAt)
        }
        const result = yield* browserbase.recording(record.providerId)
        if (result._tag === "Ready") return { url: result.url, contentType: "video/mp4" }
        if (result._tag === "Failed") {
          return yield* new UpstreamFailure({ service: "Browserbase", message: "the recording couldn't be exported" })
        }
        return yield* new InvalidRequest({ message: "The recording is still being prepared. Try again in a minute." })
      })

      const sweepBrowsers = Effect.gen(function* () {
        const open = yield* store.openBrowsers
        for (const record of open) {
          const session = yield* browserbase.get(record.providerId).pipe(Effect.option)
          if (Option.isSome(session) && session.value.status !== "RUNNING" && session.value.status !== "PENDING") {
            yield* markEnded(record.id, record.providerId, record.startedAt, session.value.endedAt)
          }
        }
        const still = yield* store.openBrowsers
        if (still.length > 0) yield* setTimerIn("browser-sweep", BrowserSweepEvery)
        else yield* store.clearTimer("browser-sweep")
      }).pipe(Effect.catch(() => Effect.void))

      // Mac ---------------------------------------------------------------------------

      const macRecord = Effect.map(
        store.getSingleton(...Singletons.mac),
        Option.getOrElse((): MacRecord => ({ state: "stopped" }))
      )
      const saveMac = (record: MacRecord) => store.putSingleton(...Singletons.mac, record)

      const toStatus = (record: MacRecord): MacStatus => ({
        state: record.state,
        idleTimeoutMinutes: Duration.toMinutes(MacIdleTimeout),
        ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt })
      })

      const touch = (record: MacRecord) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          yield* saveMac({ ...record, lastUsedAt: now })
          yield* setTimerIn("mac-idle", MacIdleTimeout)
        })

      const startMac = Effect.gen(function* () {
        const current = yield* macRecord
        if (current.state === "running" && current.instanceId !== undefined) {
          yield* touch(current)
          return toStatus(current)
        }
        const project = yield* core.project.pipe(Effect.orDie)
        yield* saveMac({ state: "starting" })
        const deadline = DateTime.add(yield* DateTime.now, { minutes: Duration.toMinutes(MacLifetime) })
        const instance = yield* namespace
          .start({ "dream.project": project.id }, deadline)
          .pipe(Effect.tapError(() => saveMac({ state: "stopped" })))
        const now = yield* DateTime.now
        const record: MacRecord = {
          state: "running",
          instanceId: instance.instanceId,
          startedAt: now,
          lastUsedAt: now,
          ...(instance.deadline === undefined ? {} : { deadline: instance.deadline })
        }
        yield* saveMac(record)
        yield* setTimerIn("mac-idle", MacIdleTimeout)
        return toStatus(record)
      }).pipe(Effect.withSpan("Machines.startMac"))

      const mac = Effect.gen(function* () {
        const record = yield* macRecord
        // Asking about a running Mac counts as using it (`dream mac` from a long ssh session keeps it alive).
        if (record.state === "running") yield* touch(record)
        return toStatus(record)
      })

      const macSsh = Effect.gen(function* () {
        const record = yield* macRecord
        if (record.state !== "running" || record.instanceId === undefined) {
          return yield* new InvalidRequest({ message: "No Mac is running. Start one with `dream mac start`." })
        }
        yield* touch(record)
        yield* namespace.extend(record.instanceId, 30 * 60).pipe(Effect.ignore)
        const ssh = yield* namespace.ssh(record.instanceId)
        const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 30 })
        return {
          host: ssh.host,
          port: ssh.port,
          user: ssh.user,
          privateKey: Redacted.make(ssh.privateKey),
          ...(ssh.hostKey === undefined ? {} : { hostKey: ssh.hostKey }),
          expiresAt
        }
      }).pipe(Effect.withSpan("Machines.macSsh"))

      const stopMac = Effect.gen(function* () {
        const record = yield* macRecord
        if (record.instanceId !== undefined && record.state !== "stopped") {
          yield* namespace.destroy(record.instanceId)
          if (record.startedAt !== undefined) {
            yield* recordUsage("mac", record.instanceId, record.startedAt, yield* DateTime.now)
          }
        }
        yield* saveMac({ state: "stopped" })
        yield* store.clearTimer("mac-idle")
        yield* alarm.reschedule
      }).pipe(Effect.withSpan("Machines.stopMac"))

      const macIdleCheck = Effect.gen(function* () {
        const record = yield* macRecord
        if (record.state !== "running") return yield* store.clearTimer("mac-idle")
        const now = yield* Clock.currentTimeMillis
        const idleSince = record.lastUsedAt === undefined ? 0 : DateTime.toEpochMillis(record.lastUsedAt)
        const idleFor = now - idleSince
        if (idleFor >= Duration.toMillis(MacIdleTimeout)) {
          yield* Effect.logInfo("stopping the idle Mac", { instanceId: record.instanceId })
          return yield* stopMac
        }
        yield* store.setTimer("mac-idle", idleSince + Duration.toMillis(MacIdleTimeout))
        yield* alarm.reschedule
      }).pipe(Effect.catch((error) => Effect.logWarning("Mac idle check failed", String(error))))

      return Machines.of({
        startBrowser,
        stopBrowser,
        browserRecording,
        sweepBrowsers,
        startMac,
        mac,
        macSsh,
        stopMac,
        macIdleCheck
      })
    })
  )
}
