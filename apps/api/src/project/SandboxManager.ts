/**
 * The project's E2B sandbox and the agent's inbox: create the sandbox from
 * the template on first need (rules carrying the person's credentials,
 * DaemonEnv for dreamd, then start dreamd), deliver events to dreamd at least
 * once, keep egress rules current, and keep the sandbox awake while a turn
 * runs. Paused sandboxes resume on traffic, so delivery just sends.
 */
import {
  type AgentEvent,
  DaemonEnv,
  DefaultDaemonPort,
  DefaultDaemonSocket,
  type EventId,
  NotFound,
  UpstreamFailure
} from "@dream/domain"
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Redacted, Schedule, Semaphore } from "effect"
import { Tokens } from "../auth/Tokens.ts"
import { ApiConfig } from "../Config.ts"
import { Projects } from "../db/Projects.ts"
import { Daemon } from "../e2b/Daemon.ts"
import { E2B, type SandboxAccess } from "../e2b/E2B.ts"
import { Envd } from "../e2b/Envd.ts"
import { SandboxCredentials } from "../integrations/SandboxCredentials.ts"
import { randomToken } from "../lib/Ids.ts"
import { Alarm } from "./Alarm.ts"
import { Core } from "./Core.ts"
import type { GatewayTarget } from "./ProjectRpcs.ts"
import { type SandboxRecord, Store } from "./Store.ts"

/** How long an idle sandbox stays up after a turn (it resumes on traffic in ~200 ms). */
export const IdleTimeout = Duration.minutes(5)
/** While a turn runs, the timeout is pushed out by this much, every `KeepaliveEvery`. */
export const WorkingTimeout = Duration.minutes(60)
export const KeepaliveEvery = Duration.minutes(25)
const HealthWait = Duration.seconds(120)
const BatchSize = 50

export const backoffMs = (failures: number): number => Math.min(15 * 60_000, 5_000 * 3 ** Math.max(0, failures - 1))

export class SandboxManager extends Context.Service<
  SandboxManager,
  {
    /** Delivers pending events (creating the sandbox first if needed); reschedules itself on failure. */
    readonly deliver: Effect.Effect<void>
    readonly ensureReady: Effect.Effect<
      { readonly access: SandboxAccess; readonly daemonToken: string },
      UpstreamFailure
    >
    /** Recomputes the egress rules and pushes them if they changed (or marks them for the next resume). */
    readonly refreshRules: Effect.Effect<void>
    readonly gatewayTarget: Effect.Effect<GatewayTarget, NotFound | UpstreamFailure>
    readonly turnStarted: Effect.Effect<void>
    readonly turnFinished: Effect.Effect<void>
    readonly keepalive: Effect.Effect<void>
  }
>()("@dream/api/project/SandboxManager") {
  static readonly layer = Layer.effect(
    SandboxManager,
    Effect.gen(function* () {
      const config = yield* ApiConfig
      const core = yield* Core
      const store = yield* Store
      const alarm = yield* Alarm
      const e2b = yield* E2B
      const envd = yield* Envd
      const daemon = yield* Daemon
      const tokens = yield* Tokens
      const credentials = yield* SandboxCredentials
      const projects = yield* Projects
      const busy = yield* Semaphore.make(1)

      const update = (f: (record: SandboxRecord) => SandboxRecord) =>
        Effect.flatMap(core.sandbox, (r) => core.saveSandbox(f(r)))

      const waitForDaemon = (access: SandboxAccess, daemonToken: string) =>
        daemon.health(access, daemonToken).pipe(
          Effect.retry(Schedule.spaced("2 seconds")),
          Effect.timeoutOrElse({
            duration: HealthWait,
            orElse: () =>
              Effect.fail(new UpstreamFailure({ service: "dreamd", message: "dreamd didn't come up in the sandbox" }))
          })
        )

      const startDaemon = (access: SandboxAccess) =>
        envd.startBackground(access, { command: `${config.daemonCommand} >>/tmp/dreamd.log 2>&1` })

      const create = Effect.gen(function* () {
        const project = yield* core.project.pipe(Effect.orDie)
        const daemonToken = randomToken(40)
        const projectToken = yield* tokens.project(project.id, project.ownerId)
        const setup = yield* credentials.setup(project.ownerId, project.id, project.harness)
        yield* update((r) => ({ ...r, status: "creating" }))
        const access = yield* e2b.create({
          template: config.sandboxTemplate,
          timeoutSeconds: Duration.toSeconds(IdleTimeout),
          autoPause: true,
          envVars: {
            ...setup.envVars,
            [DaemonEnv.apiUrl]: config.apiUrl,
            [DaemonEnv.projectId]: project.id,
            [DaemonEnv.projectToken]: Redacted.value(projectToken),
            [DaemonEnv.daemonToken]: daemonToken,
            [DaemonEnv.harness]: project.harness,
            [DaemonEnv.port]: String(DefaultDaemonPort),
            [DaemonEnv.socket]: DefaultDaemonSocket
          },
          metadata: { projectId: project.id, userId: project.ownerId },
          rules: setup.rules
        })
        const ready = Effect.gen(function* () {
          for (const file of setup.files) {
            yield* envd.run(access, { command: `mkdir -p "$(dirname '${file.path}')"`, timeout: "20 seconds" })
            yield* envd.writeFile(access, file.path, file.content)
          }
          yield* startDaemon(access)
          yield* waitForDaemon(access, daemonToken)
        })
        // Don't leak a sandbox that never became usable.
        yield* ready.pipe(Effect.tapError(() => e2b.kill(access.sandboxId).pipe(Effect.ignore)))
        const now = yield* DateTime.now
        yield* update((r) => ({
          ...r,
          status: "ready",
          access,
          daemonToken,
          createdAt: now,
          rulesHash: setup.rulesHash,
          rulesDirty: false,
          failures: 0
        }))
        yield* Effect.logInfo("sandbox ready", { sandboxId: access.sandboxId })
        return { access, daemonToken }
      }).pipe(
        Effect.tapError((error) => update((r) => ({ ...r, status: "failed", lastError: error.message }))),
        Effect.withSpan("SandboxManager.create")
      )

      const ensureReady = Effect.gen(function* () {
        const record = yield* core.sandbox
        if (record.status === "ready" && record.access !== undefined && record.daemonToken !== undefined) {
          return { access: record.access, daemonToken: record.daemonToken }
        }
        return yield* create
      })

      const pushRules = (record: SandboxRecord, resume: boolean) =>
        Effect.gen(function* () {
          if (record.access === undefined) return
          const project = yield* core.project.pipe(Effect.orDie)
          const setup = yield* credentials.setup(project.ownerId, project.id, project.harness)
          if (setup.rulesHash === record.rulesHash && !record.rulesDirty) return
          if (resume) yield* e2b.connect(record.access.sandboxId, Duration.toSeconds(IdleTimeout)).pipe(Effect.ignore)
          const updated = yield* e2b.updateRules(record.access.sandboxId, setup.rules)
          yield* update((r) =>
            updated ? { ...r, rulesHash: setup.rulesHash, rulesDirty: false } : { ...r, rulesDirty: true }
          )
          if (updated) {
            for (const file of setup.files)
              yield* envd.writeFile(record.access, file.path, file.content).pipe(Effect.ignore)
          }
        })

      const refreshRules = Effect.flatMap(core.sandbox, (record) => pushRules(record, false)).pipe(
        Effect.catch((error) => Effect.logWarning("couldn't push egress rules", error.message)),
        Effect.withSpan("SandboxManager.refreshRules")
      )

      const scheduleRetry = (failures: number) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* store.setTimer("deliver", now + backoffMs(failures))
          yield* alarm.reschedule
        })

      /** After a failed delivery: is the sandbox gone, paused, or is dreamd down? Repair what can be repaired. */
      const diagnose = (access: SandboxAccess, daemonToken: string) =>
        Effect.gen(function* () {
          const info = yield* e2b.info(access.sandboxId)
          if (Option.isNone(info) || info.value.state === "killed") {
            yield* Effect.logError("the project's sandbox no longer exists; a new one will be created", {
              sandboxId: access.sandboxId
            })
            yield* update((r) => ({ ...r, status: "none", rulesDirty: false }))
            return
          }
          const resumed = yield* e2b.connect(access.sandboxId, Duration.toSeconds(IdleTimeout))
          const healthy = yield* daemon.health(resumed, daemonToken).pipe(Effect.option)
          if (Option.isNone(healthy)) {
            yield* Effect.logWarning("dreamd isn't answering; restarting it")
            yield* startDaemon(resumed)
            yield* waitForDaemon(resumed, daemonToken)
          }
        }).pipe(Effect.catch((error) => Effect.logWarning("sandbox check failed", String(error))))

      const deliverOnce = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const pause = yield* core.usagePause
        if (Option.isSome(pause) && DateTime.toEpochMillis(pause.value.until) > now) {
          yield* store.setTimer("deliver", DateTime.toEpochMillis(pause.value.until))
          return yield* alarm.reschedule
        }
        yield* store.clearTimer("deliver")
        const pending = yield* store.pendingEvents(BatchSize)
        if (pending.length === 0) return
        const { access, daemonToken } = yield* ensureReady
        const record = yield* core.sandbox
        if (record.rulesDirty) yield* pushRules(record, true)
        const accepted = yield* daemon
          .deliver(access, daemonToken, pending as unknown as readonly [AgentEvent, ...Array<AgentEvent>])
          .pipe(Effect.tapError(() => diagnose(access, daemonToken)))
        yield* store.markDelivered(accepted as ReadonlyArray<EventId>, DateTime.formatIso(yield* DateTime.now))
        yield* update((r) => ({ ...r, failures: 0 }))
        const rest = yield* store.pendingEvents(1)
        if (rest.length > 0) {
          // More than a batch, or dreamd didn't take everything: go again soon.
          yield* store.setTimer("deliver", now + (accepted.length === pending.length ? 0 : 30_000))
          yield* alarm.reschedule
        }
      })

      const deliver = busy
        .withPermits(1)(deliverOnce)
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const record = yield* core.sandbox
              const failures = record.failures + 1
              yield* update((r) => ({ ...r, failures, lastError: error.message }))
              yield* Effect.logWarning("delivery failed", { failures, error: error.message })
              yield* scheduleRetry(failures)
            })
          ),
          Effect.withSpan("SandboxManager.deliver")
        )

      const gatewayTarget = Effect.gen(function* () {
        const project = yield* core.project
        if (project.publishedPort === undefined) {
          return yield* new NotFound({ entity: "published port", id: project.id })
        }
        const record = yield* core.sandbox
        if (record.access === undefined) return yield* new NotFound({ entity: "sandbox", id: project.id })
        if (record.rulesDirty) yield* pushRules(record, true)
        return {
          origin: `https://${project.publishedPort}-${record.access.sandboxId}.${record.access.domain}`,
          trafficAccessToken: record.access.trafficAccessToken
        }
      })

      const keepalive = Effect.gen(function* () {
        const record = yield* core.sandbox
        if (!record.working || record.access === undefined) return yield* store.clearTimer("turn-keepalive")
        yield* e2b.setTimeout(record.access.sandboxId, Duration.toSeconds(WorkingTimeout)).pipe(Effect.ignore)
        yield* store.setTimer("turn-keepalive", (yield* Clock.currentTimeMillis) + Duration.toMillis(KeepaliveEvery))
        yield* alarm.reschedule
      })

      const turnStarted = Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* update((r) => ({
          ...r,
          working: true,
          turnStartedAt: r.working && r.turnStartedAt ? r.turnStartedAt : now
        }))
        yield* keepalive
      })

      const turnFinished = Effect.gen(function* () {
        const record = yield* core.sandbox
        yield* update((r) => {
          const { turnStartedAt: _, ...rest } = r
          return { ...rest, working: false }
        })
        yield* store.clearTimer("turn-keepalive")
        yield* alarm.reschedule
        if (record.access !== undefined) {
          yield* e2b.setTimeout(record.access.sandboxId, Duration.toSeconds(IdleTimeout)).pipe(Effect.ignore)
        }
        // Machine time for this turn, plus the idle tail before E2B pauses it.
        if (record.turnStartedAt !== undefined) {
          const project = yield* core.project.pipe(Effect.orDie)
          const ended = DateTime.add(yield* DateTime.now, { minutes: Duration.toMinutes(IdleTimeout) })
          const minutes = (DateTime.toEpochMillis(ended) - DateTime.toEpochMillis(record.turnStartedAt)) / 60_000
          yield* projects.recordUsage({
            id: `use_${randomToken(22)}`,
            projectId: project.id,
            userId: project.ownerId,
            kind: "sandbox",
            ref: record.access?.sandboxId,
            startedAt: record.turnStartedAt,
            endedAt: ended,
            minutes: Math.round(minutes * 100) / 100
          })
        }
      })

      return SandboxManager.of({
        deliver,
        ensureReady,
        refreshRules,
        gatewayTarget,
        turnStarted,
        turnFinished,
        keepalive: keepalive.pipe(Effect.catch(() => Effect.void))
      })
    })
  )
}
