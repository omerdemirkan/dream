/**
 * Machines the agent rents beyond its sandbox: Browserbase sessions and a
 * Namespace Mac. The DO tracks them for `dream browser|mac`, stops idle Macs,
 * and meters each one once it has ended (`browser_session`, `mac_session`).
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
import { Browserbase, type BrowserbaseSession } from "../brokers/Browserbase.ts"
import { MacShape, Namespace } from "../brokers/Namespace.ts"
import { Meter } from "../metering/Meter.ts"
import { newBrowserSessionId } from "../lib/Ids.ts"
import { Alarm } from "./Alarm.ts"
import { Core } from "./Core.ts"
import { type MacRecord, Singletons, Store } from "./Store.ts"

export const MacIdleTimeout = Duration.minutes(20)
/** Each Mac is created with this deadline and extended while used. */
const MacLifetime = Duration.minutes(90)
const BrowserSweepEvery = Duration.minutes(10)

/** How long Namespace extends a Mac's deadline each time the agent asks for ssh. */
const MacExtension = Duration.minutes(30)

const msBetween = (start: DateTime.Utc, end: DateTime.Utc) =>
  Math.max(0, DateTime.toEpochMillis(end) - DateTime.toEpochMillis(start))

const parsed = (iso: string | null | undefined) =>
  iso ? Option.map(DateTime.make(iso), DateTime.toUtc) : Option.none<DateTime.Utc>()

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
      const meter = yield* Meter
      const browserbase = yield* Browserbase
      const namespace = yield* Namespace

      /** Meters what Dream paid for a browser or a Mac, to the project and its owner. */
      const meterMachine = (
        meterName: "browser_session" | "mac_session",
        id: string,
        at: DateTime.Utc,
        quantities: Readonly<Record<string, number>>,
        dimensions: Readonly<Record<string, string>>
      ) =>
        Effect.gen(function* () {
          const project = yield* core.project.pipe(Effect.orDie)
          yield* meter.record([
            {
              id,
              owner: project.ownerId,
              meter: meterName,
              at,
              quantities,
              dimensions: { project: project.id, payer: "dream", ...dimensions }
            }
          ])
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

      /** Ends the record and meters the session, from Browserbase's own times and proxy bytes when it has them. */
      const markEnded = (id: string, providerId: string, startedAt: DateTime.Utc, session: BrowserbaseSession) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now
          const endedAt = Option.getOrElse(parsed(session.endedAt), () => now)
          yield* store.putBrowser({ id, providerId, startedAt, endedAt })
          const started = Option.getOrElse(parsed(session.startedAt), () => startedAt)
          yield* meterMachine(
            "browser_session",
            `browserbase:${providerId}`,
            endedAt,
            { ms: msBetween(started, endedAt), proxy_bytes: Math.max(0, session.proxyBytes ?? 0) },
            { provider: "browserbase", session: providerId }
          )
        })

      const stopBrowser = Effect.fn("Machines.stopBrowser")(function* (id: BrowserSessionId) {
        const record = yield* findBrowser(id)
        if (record.endedAt !== undefined) return
        const released = yield* browserbase.release(record.providerId)
        // The ended session has the final proxy bytes; the release's answer is what's known if it can't be read.
        const ended = yield* browserbase.get(record.providerId).pipe(Effect.option)
        const session = Option.isSome(ended) && ended.value.endedAt ? ended.value : released
        yield* markEnded(record.id, record.providerId, record.startedAt, session)
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
          yield* markEnded(record.id, record.providerId, record.startedAt, session)
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
            yield* markEnded(record.id, record.providerId, record.startedAt, session.value)
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
        const extended = yield* namespace.extend(record.instanceId, Duration.toSeconds(MacExtension)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false)
        )
        // Namespace keeps the later of the two deadlines; metering caps the Mac's minutes at it.
        const until = DateTime.addDuration(yield* DateTime.now, MacExtension)
        if (extended && (record.deadline === undefined || DateTime.isLessThan(record.deadline, until))) {
          yield* saveMac({ ...(yield* macRecord), deadline: until })
        }
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
          const now = yield* DateTime.now
          // Past its deadline, Namespace destroyed it already: billed until then, and nothing left to stop.
          const expired = record.deadline !== undefined && DateTime.isLessThanOrEqualTo(record.deadline, now)
          yield* namespace.destroy(record.instanceId).pipe(expired ? Effect.ignore : (destroy) => destroy)
          if (record.startedAt !== undefined) {
            const endedAt = expired && record.deadline !== undefined ? record.deadline : now
            yield* meterMachine(
              "mac_session",
              `namespace:${record.instanceId}`,
              endedAt,
              {
                ms: msBetween(record.startedAt, endedAt),
                vcpus: MacShape.virtualCpu,
                memory_mb: MacShape.memoryMegabytes
              },
              { provider: "namespace", instance: record.instanceId }
            )
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
