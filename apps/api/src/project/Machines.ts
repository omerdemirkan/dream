/**
 * Machines the agent rents beyond its sandbox: Browserbase sessions and a
 * Namespace Mac. The DO tracks them for `dream browser|mac`, looks at what runs
 * on a Mac and stops it once nothing does, logs each Mac's activity
 * (`db/MacActivity.ts`), and meters each one once it has ended
 * (`browser_session`, `mac_session`).
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
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Redacted, Result } from "effect"
import { Browserbase, type BrowserbaseSession } from "../brokers/Browserbase.ts"
import { macProbeCommand, parseMacProbe } from "../brokers/MacProbe.ts"
import { MacShape, Namespace } from "../brokers/Namespace.ts"
import { MacActivity, MacActivityLog, type MacStopReason } from "../db/MacActivity.ts"
import { Meter } from "../metering/Meter.ts"
import { newBrowserSessionId } from "../lib/Ids.ts"
import { Alarm } from "./Alarm.ts"
import { Core } from "./Core.ts"
import { type MacRecord, Singletons, Store } from "./Store.ts"

/**
 * A Mac stops after this long without use: no ssh session started, and nothing the agent runs at work at a check.
 * Checks see long builds and sessions, so this only has to outlast the agent's thinking between commands; a fresh
 * Mac boots in seconds but rebuilds caches for minutes, and at $0.06 a minute 15 idle minutes cost about as much.
 */
export const MacIdleTimeout = Duration.minutes(15)
/** How often a running Mac is looked at (Namespace's command service, about half a second). */
export const MacCheckEvery = Duration.minutes(5)
/** With the turn over, nothing running on the Mac and nothing due, it stops this long after its last use. */
export const MacTurnEndGrace = Duration.minutes(3)
/**
 * When the agent left something running that's quiet now (a build script between two builds, a wait loop), or the
 * probe couldn't tell, the Mac waits this long after its last use instead: stopping one mid-build costs more.
 */
export const MacHeldTimeout = Duration.minutes(60)
/** Each Mac is created with this deadline and extended while used (Namespace's policy caps its lifetime). */
const MacLifetime = Duration.minutes(90)
const BrowserSweepEvery = Duration.minutes(10)

/** How far ahead Namespace's deadline is kept while the Mac is in use. */
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
    readonly stopMac: (reason: MacStopReason) => Effect.Effect<void, UpstreamFailure>
    /** Looks at the running Mac and stops it once nothing uses it (see `macCheck` below). */
    readonly macCheck: Effect.Effect<void>
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
      const macLog = yield* MacActivityLog

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

      const logMac = (instanceId: string, activity: MacActivity) =>
        Effect.gen(function* () {
          const project = yield* core.projectOption
          if (Option.isNone(project)) return
          yield* macLog.record({ projectId: project.value.id, instanceId, at: yield* DateTime.now, activity })
        })

      const toStatus = (record: MacRecord): MacStatus => ({
        state: record.state,
        idleTimeoutMinutes: Duration.toMinutes(MacIdleTimeout),
        ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
        ...(record.deadline === undefined || record.state === "stopped" ? {} : { deadline: record.deadline })
      })

      const checkMacIn = (after: Duration.Duration) => setTimerIn("mac-idle", after)

      const pastDeadline = (record: MacRecord, now: DateTime.Utc) =>
        record.deadline !== undefined && DateTime.isLessThanOrEqualTo(record.deadline, now)

      /**
       * Ends the record and meters the Mac from Namespace's creation to its destruction when Namespace says (else to
       * now, or the deadline once that passed). Past its deadline Namespace destroyed it already: nothing to stop.
       */
      const finishMac = (record: MacRecord, asked: MacStopReason) =>
        Effect.gen(function* () {
          const instanceId = record.instanceId
          if (instanceId !== undefined && record.state !== "stopped") {
            const now = yield* DateTime.now
            const expired = pastDeadline(record, now)
            if (!expired && asked !== "provider-gone") yield* namespace.destroy(instanceId)
            const described = yield* namespace.describe(instanceId).pipe(Effect.option)
            const destroyedAt = Option.flatMapNullishOr(described, (d) => d.destroyedAt)
            // Namespace's own times say whether it had ended the Mac before Dream got to it, and why.
            const endedEarlier = Option.exists(destroyedAt, (at) => msBetween(at, now) > 30_000)
            const atDeadline = Option.exists(destroyedAt, (at) =>
              Option.exists(
                Option.flatMapNullishOr(described, (d) => d.deadline),
                (deadline) => DateTime.isGreaterThanOrEqualTo(at, DateTime.subtract(deadline, { seconds: 5 }))
              )
            )
            const reason: MacStopReason =
              expired || (endedEarlier && atDeadline) ? "deadline" : endedEarlier ? "provider-gone" : asked
            const endedAt = Option.getOrElse(destroyedAt, () =>
              expired && record.deadline !== undefined ? record.deadline : now
            )
            const createdAt = Option.getOrElse(
              Option.flatMapNullishOr(described, (d) => d.createdAt),
              () => record.createdAt ?? record.startedAt ?? endedAt
            )
            const ms = msBetween(createdAt, endedAt)
            const idleMs = msBetween(record.lastUsedAt ?? createdAt, endedAt)
            const endedBy = Option.isSome(destroyedAt) ? "namespace" : "dream"
            yield* meterMachine(
              "mac_session",
              `namespace:${instanceId}`,
              endedAt,
              {
                ms,
                vcpus: MacShape.virtualCpu,
                memory_mb: MacShape.memoryMegabytes,
                idle_ms: idleMs,
                ssh_sessions: record.sshCount ?? 0
              },
              { provider: "namespace", instance: instanceId, stop_reason: reason, ended_by: endedBy }
            )
            yield* logMac(instanceId, MacActivity.cases.Stop.make({ reason, endedAt, endedBy, ms, idleMs }))
            yield* Effect.logInfo("stopped the Mac", { instanceId, reason, minutes: Math.round(ms / 60_000) })
          }
          yield* saveMac({ state: "stopped" })
          yield* store.clearTimer("mac-idle")
          yield* alarm.reschedule
        })

      /** Moves Namespace's deadline to at least `MacExtension` from now, and keeps what it answered. */
      const extendMac = (instanceId: string, trigger: "ssh" | "busy") =>
        namespace.extend(instanceId, Duration.toSeconds(MacExtension)).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              logMac(instanceId, MacActivity.cases.Extend.make({ trigger, failure: error.message })),
            onSuccess: (deadline) =>
              Effect.gen(function* () {
                const current = yield* macRecord
                if (deadline !== undefined && current.instanceId === instanceId) {
                  yield* saveMac({ ...current, deadline })
                }
                if (
                  deadline === undefined ||
                  current.deadline === undefined ||
                  !DateTime.Equivalence(deadline, current.deadline)
                ) {
                  yield* logMac(
                    instanceId,
                    MacActivity.cases.Extend.make({ trigger, ...(deadline === undefined ? {} : { deadline }) })
                  )
                }
              })
          })
        )

      const startMac = Effect.gen(function* () {
        const current = yield* macRecord
        if (current.state === "running" && current.instanceId !== undefined) {
          if (!pastDeadline(current, yield* DateTime.now)) {
            const used = { ...current, lastUsedAt: yield* DateTime.now }
            yield* saveMac(used)
            return toStatus(used)
          }
          yield* finishMac(current, "deadline")
        }
        const project = yield* core.project.pipe(Effect.orDie)
        yield* saveMac({ state: "starting" })
        const asked = yield* DateTime.now
        const instance = yield* namespace
          .start({ "dream.project": project.id }, DateTime.addDuration(asked, MacLifetime))
          .pipe(Effect.tapError(() => saveMac({ state: "stopped" })))
        const now = yield* DateTime.now
        const record: MacRecord = {
          state: "running",
          instanceId: instance.instanceId,
          startedAt: now,
          lastUsedAt: now,
          sshCount: 0,
          ...(instance.createdAt === undefined ? {} : { createdAt: instance.createdAt }),
          ...(instance.deadline === undefined ? {} : { deadline: instance.deadline })
        }
        yield* saveMac(record)
        yield* logMac(
          instance.instanceId,
          MacActivity.cases.Start.make({
            bootMs: msBetween(asked, now),
            ...(instance.deadline === undefined ? {} : { deadline: instance.deadline })
          })
        )
        yield* checkMacIn(MacCheckEvery)
        return toStatus(record)
      }).pipe(Effect.withSpan("Machines.startMac"))

      const mac = Effect.gen(function* () {
        const record = yield* macRecord
        if (record.state !== "running" || record.instanceId === undefined) return toStatus(record)
        // Asking isn't using: a Mac the agent only asks about still idles out.
        yield* logMac(record.instanceId, MacActivity.cases.Status.make({}))
        if (pastDeadline(record, yield* DateTime.now)) {
          yield* finishMac(record, "deadline").pipe(Effect.ignore)
          return toStatus(yield* macRecord)
        }
        return toStatus(record)
      })

      const macSsh = Effect.gen(function* () {
        const record = yield* macRecord
        if (record.state !== "running" || record.instanceId === undefined) {
          return yield* new InvalidRequest({ message: "No Mac is running. Start one with `dream mac start`." })
        }
        const instanceId = record.instanceId
        if (pastDeadline(record, yield* DateTime.now)) {
          yield* finishMac(record, "deadline")
          return yield* new InvalidRequest({
            message:
              "Namespace destroyed the Mac at its deadline (it limits how long one Mac lives), and nothing on it was kept. Start a new one with `dream mac start`."
          })
        }
        const sshCount = (record.sshCount ?? 0) + 1
        yield* saveMac({ ...record, lastUsedAt: yield* DateTime.now, sshCount })
        yield* logMac(instanceId, MacActivity.cases.Ssh.make({ count: sshCount }))
        yield* extendMac(instanceId, "ssh")
        const ssh = yield* namespace.ssh(instanceId)
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

      const stopMac = (reason: MacStopReason) =>
        Effect.flatMap(macRecord, (record) => finishMac(record, reason)).pipe(
          Effect.withSpan("Machines.stopMac", { attributes: { reason } })
        )

      /** Nobody will use the Mac soon: no turn is running or starting, dreamd has no work, nothing is queued or due. */
      const agentIdle = (nowMs: number) =>
        Effect.gen(function* () {
          const sandbox = yield* core.sandbox
          if (sandbox.working || sandbox.startingSince !== undefined) return false
          if (sandbox.awakeUntil !== undefined && DateTime.toEpochMillis(sandbox.awakeUntil) > nowMs) return false
          if ((yield* store.pendingEvents(1)).length > 0) return false
          const nextWake = yield* store.nextWakeMs
          return Option.isNone(nextWake) || nextWake.value > nowMs + Duration.toMillis(MacIdleTimeout)
        })

      /**
       * Looks at the running Mac: whether Namespace still has it, and what runs on it (`MacProbe`). Something the
       * agent runs at work counts as use and keeps the deadline ahead. It stops after `MacIdleTimeout` without use,
       * or sooner once the turn is over and nothing runs on it.
       */
      const macCheck = Effect.gen(function* () {
        const record = yield* macRecord
        if (record.state !== "running" || record.instanceId === undefined) return yield* store.clearTimer("mac-idle")
        const instanceId = record.instanceId
        const now = yield* DateTime.now
        if (pastDeadline(record, now)) return yield* finishMac(record, "deadline")

        const probeStart = yield* Clock.currentTimeMillis
        const probed = yield* namespace.run(instanceId, macProbeCommand).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(parseMacProbe(result.stdout))
              : Effect.fail(`the probe exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`)
          ),
          Effect.mapError((error) => (typeof error === "string" ? error : error.message)),
          Effect.result
        )
        const probeMs = (yield* Clock.currentTimeMillis) - probeStart
        if (Result.isFailure(probed)) {
          const described = yield* namespace.describe(instanceId).pipe(Effect.option)
          // Namespace says DESTROYING, then DESTROYED, and has `destroyedAt` from the start.
          if (
            Option.isSome(described) &&
            (described.value.destroyedAt !== undefined || described.value.status.startsWith("DESTROY"))
          ) {
            return yield* finishMac(record, "provider-gone")
          }
          yield* logMac(instanceId, MacActivity.cases.Probe.make({ failure: probed.failure, ms: probeMs }))
        } else {
          yield* logMac(instanceId, MacActivity.cases.Probe.make({ probe: probed.success, ms: probeMs }))
          if (probed.success.busy) {
            yield* saveMac({ ...(yield* macRecord), lastUsedAt: now })
            if (record.deadline === undefined || msBetween(now, record.deadline) < Duration.toMillis(MacExtension)) {
              yield* extendMac(instanceId, "busy")
            }
          }
        }

        const current = yield* macRecord
        const nowMs = DateTime.toEpochMillis(now)
        const lastUsedMs = current.lastUsedAt === undefined ? 0 : DateTime.toEpochMillis(current.lastUsedAt)
        const idleMs = nowMs - lastUsedMs
        const held = Result.isFailure(probed) || probed.success.lingering
        const timeout = held ? MacHeldTimeout : MacIdleTimeout
        if (idleMs >= Duration.toMillis(timeout)) return yield* finishMac(current, "idle")
        const quiet = Result.isSuccess(probed) && !probed.success.busy && !probed.success.lingering
        if (quiet && idleMs >= Duration.toMillis(MacTurnEndGrace) && (yield* agentIdle(nowMs))) {
          return yield* finishMac(current, "turn-ended")
        }
        const untilIdle = lastUsedMs + Duration.toMillis(timeout) - nowMs
        yield* checkMacIn(Duration.millis(Math.min(Duration.toMillis(MacCheckEvery), untilIdle)))
      }).pipe(
        Effect.withSpan("Machines.macCheck"),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("Mac check failed", error.message)
            // Try again later rather than leave a running Mac unwatched.
            if ((yield* macRecord).state === "running") yield* checkMacIn(MacCheckEvery)
          })
        )
      )

      return Machines.of({
        startBrowser,
        stopBrowser,
        browserRecording,
        sweepBrowsers,
        startMac,
        mac,
        macSsh,
        stopMac,
        macCheck
      })
    })
  )
}
