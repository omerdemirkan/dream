/**
 * The project's E2B sandbox and the agent's inbox: create the sandbox from
 * the template on first need (rules carrying the person's credentials,
 * DaemonEnv for dreamd, then start dreamd), deliver events to dreamd at least
 * once, keep egress rules current, and keep the sandbox awake while a turn
 * runs. Paused sandboxes resume on traffic, so delivery just sends.
 *
 * E2B pauses any sandbox that has run for `sandboxMaxRun` (1 hour on Hobby),
 * and a turn doesn't make traffic that would resume it. So while a turn runs,
 * the keepalive checks every few minutes: shortly before the cap it pauses and
 * resumes the sandbox itself (resuming restarts the clock), and if it finds
 * the sandbox paused anyway, it resumes it.
 */
import {
  type AgentEvent,
  DaemonEnv,
  DaemonEnvFile,
  DefaultDaemonPort,
  DefaultDaemonSocket,
  type EventId,
  type Harness,
  NotFound,
  type ProjectId,
  UpstreamFailure
} from "@dream/domain"
import { Cause, Clock, Context, DateTime, Duration, Effect, Layer, Option, Redacted, Schedule, Semaphore } from "effect"
import { Tokens } from "../auth/Tokens.ts"
import { ApiConfig } from "../Config.ts"
import { Projects } from "../db/Projects.ts"
import { Users } from "../db/Users.ts"
import { Daemon } from "../e2b/Daemon.ts"
import { E2B, type SandboxAccess } from "../e2b/E2B.ts"
import { Envd } from "../e2b/Envd.ts"
import { SandboxCredentials } from "../integrations/SandboxCredentials.ts"
import { toHex, utf8 } from "../lib/Bytes.ts"
import { randomToken } from "../lib/Ids.ts"
import { Alarm } from "./Alarm.ts"
import { Core } from "./Core.ts"
import type { GatewayTarget } from "./ProjectRpcs.ts"
import { type SandboxRecord, Singletons, Store } from "./Store.ts"

/** How long an idle sandbox stays up after a turn (it resumes on traffic in ~200 ms). */
export const IdleTimeout = Duration.minutes(5)
/** While a turn runs, the timeout is pushed out by this much (E2B clamps it to the run cap), every `KeepaliveEvery`. */
export const WorkingTimeout = Duration.minutes(15)
export const KeepaliveEvery = Duration.minutes(5)
/** The keepalive cycles the sandbox once less than this is left before the run cap: one tick, plus slack. */
const CycleWithin = Duration.sum(KeepaliveEvery, Duration.minutes(1))
const HealthWait = Duration.seconds(120)
/**
 * A dreamd too old to report `envHash` can't say which env file it read, so after a rewrite it's trusted once
 * this has passed: the old one notices the change within 5 s.
 */
const LegacyRestartWait = Duration.seconds(12)
const BatchSize = 50

/**
 * What dreamd's env file says, but for the project token (signed afresh on every write). The agent model only
 * goes to Claude Code: Codex would send a Claude model name to the ChatGPT backend.
 */
export const daemonSettings = (options: {
  readonly apiUrl: string
  readonly projectId: ProjectId
  readonly harness: Harness
  readonly daemonToken: string
  readonly agentModel: Option.Option<string>
}): Record<string, string> => ({
  [DaemonEnv.apiUrl]: options.apiUrl,
  [DaemonEnv.projectId]: options.projectId,
  [DaemonEnv.daemonToken]: options.daemonToken,
  [DaemonEnv.harness]: options.harness,
  [DaemonEnv.port]: String(DefaultDaemonPort),
  [DaemonEnv.socket]: DefaultDaemonSocket,
  ...(options.harness === "claude-code" && Option.isSome(options.agentModel)
    ? { [DaemonEnv.model]: options.agentModel.value }
    : {})
})

const hashSettings = (settings: Readonly<Record<string, string>>): Effect.Effect<string> =>
  Effect.promise(async () => {
    const canonical = JSON.stringify(
      Object.keys(settings)
        .sort()
        .map((key) => [key, settings[key]])
    )
    return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(canonical))))
  })

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
    /** Kills the sandbox for good (archiving the project). */
    readonly archive: Effect.Effect<void>
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
      const users = yield* Users
      const busy = yield* Semaphore.make(1)

      const update = (f: (record: SandboxRecord) => SandboxRecord) =>
        Effect.flatMap(core.sandbox, (r) => core.saveSandbox(f(r)))

      /**
       * Waits until dreamd answers. With `envHash` (after writing the env file), it waits for the dreamd that read
       * that file: the one answering first may be the old process, which hasn't noticed the change yet.
       */
      const waitForDaemon = (access: SandboxAccess, daemonToken: string, within: Duration.Duration, envHash?: string) =>
        Effect.gen(function* () {
          const since = yield* Clock.currentTimeMillis
          yield* daemon.health(access, daemonToken).pipe(
            Effect.flatMap((health) =>
              Effect.gen(function* () {
                if (envHash === undefined || health.envHash === envHash) return
                const waited = (yield* Clock.currentTimeMillis) - since
                if (health.envHash === undefined && waited >= Duration.toMillis(LegacyRestartWait)) return
                return yield* new UpstreamFailure({ service: "dreamd", message: "dreamd hasn't restarted yet" })
              })
            ),
            Effect.retry(Schedule.spaced("2 seconds")),
            Effect.timeoutOrElse({
              duration: within,
              orElse: () =>
                Effect.fail(new UpstreamFailure({ service: "dreamd", message: "dreamd didn't come up in the sandbox" }))
            })
          )
        })

      /** For a template without dreamd's supervisor: start it directly (a second copy just fails to bind its port). */
      const startDaemon = (access: SandboxAccess) =>
        envd.startBackground(access, { command: `${config.daemonCommand} >>/tmp/dreamd.log 2>&1` })

      /** dreamd's environment, as `DaemonEnvFile` (dotenv). dreamd waits for it and restarts when it changes. */
      const daemonEnv = (values: Readonly<Record<string, string>>) =>
        Object.entries(values)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join("\n") + "\n"

      const settingsFor = (daemonToken: string) =>
        Effect.map(core.project.pipe(Effect.orDie), (project) => ({
          project,
          settings: daemonSettings({
            apiUrl: config.apiUrl,
            projectId: project.id,
            harness: project.harness,
            daemonToken,
            agentModel: config.agentModel
          })
        }))

      /** Writes dreamd's env file and records what it said (`envHash`, which dreamd reports back). */
      const writeDaemonEnv = (access: SandboxAccess, daemonToken: string) =>
        Effect.gen(function* () {
          const { project, settings } = yield* settingsFor(daemonToken)
          const projectToken = yield* tokens.project(project.id, project.ownerId)
          const envHash = yield* hashSettings(settings)
          yield* envd.run(access, { command: `mkdir -p "$(dirname '${DaemonEnvFile}')"`, timeout: "20 seconds" })
          yield* envd.writeFile(
            access,
            DaemonEnvFile,
            daemonEnv({
              ...settings,
              [DaemonEnv.envHash]: envHash,
              [DaemonEnv.projectToken]: Redacted.value(projectToken)
            })
          )
          yield* update((r) => ({ ...r, envHash }))
          return envHash
        })

      /**
       * Writes dreamd's env file, then waits for the dreamd that read it; if the template didn't start one within
       * a while, starts it and waits again.
       */
      const restartDaemon = (access: SandboxAccess, daemonToken: string) =>
        Effect.gen(function* () {
          const envHash = yield* writeDaemonEnv(access, daemonToken)
          yield* waitForDaemon(access, daemonToken, Duration.seconds(45), envHash).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                yield* Effect.logWarning("dreamd didn't answer; starting it directly")
                yield* startDaemon(access)
                yield* waitForDaemon(access, daemonToken, HealthWait, envHash)
              })
            )
          )
        })

      /**
       * Between turns: if dreamd's settings changed since its env file was written (say, the agent model), write
       * it again, which restarts dreamd, and deliver only once the new one is up. Its inbox is on disk, so a
       * restart loses nothing.
       */
      const refreshDaemonEnv = (access: SandboxAccess, daemonToken: string) =>
        Effect.gen(function* () {
          const record = yield* core.sandbox
          if (record.working) return
          const { settings } = yield* settingsFor(daemonToken)
          if ((yield* hashSettings(settings)) === record.envHash) return
          const health = yield* daemon.health(access, daemonToken)
          if (health.turn === "running") return
          yield* Effect.logInfo("dreamd's settings changed; rewriting its env file", { sandboxId: access.sandboxId })
          yield* restartDaemon(access, daemonToken)
        }).pipe(Effect.catch((error) => Effect.logWarning("couldn't refresh dreamd's env file", error.message)))

      const create = Effect.gen(function* () {
        const project = yield* core.project.pipe(Effect.orDie)
        const daemonToken = randomToken(40)
        const setup = yield* credentials.setup(project.ownerId, project.harness)
        yield* update((r) => ({ ...r, status: "creating" }))
        const access = yield* e2b.create({
          template: config.sandboxTemplate,
          timeoutSeconds: Duration.toSeconds(IdleTimeout),
          autoPause: true,
          envVars: {},
          metadata: { projectId: project.id, userId: project.ownerId },
          rules: setup.rules
        })
        const ready = restartDaemon(access, daemonToken)
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
          const setup = yield* credentials.setup(project.ownerId, project.harness)
          if (setup.rulesHash === record.rulesHash && !record.rulesDirty) return
          if (resume) yield* e2b.connect(record.access.sandboxId, Duration.toSeconds(IdleTimeout)).pipe(Effect.ignore)
          const updated = yield* e2b.updateRules(record.access.sandboxId, setup.rules)
          yield* update((r) =>
            updated ? { ...r, rulesHash: setup.rulesHash, rulesDirty: false } : { ...r, rulesDirty: true }
          )
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

      /** After a resume: is dreamd answering? If not, restart it (which ends any turn it was running). */
      const revive = (access: SandboxAccess, daemonToken: string) =>
        waitForDaemon(access, daemonToken, Duration.seconds(20)).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              yield* Effect.logWarning("dreamd isn't answering; rewriting its env file to restart it")
              yield* restartDaemon(access, daemonToken)
            })
          )
        )

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
          yield* revive(resumed, daemonToken)
        }).pipe(Effect.catch((error) => Effect.logWarning("sandbox check failed", String(error))))

      const deliverOnce = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const pause = yield* core.usagePause
        if (Option.isSome(pause) && DateTime.toEpochMillis(pause.value.until) > now) {
          yield* store.setTimer("deliver", DateTime.toEpochMillis(pause.value.until))
          return yield* alarm.reschedule
        }
        yield* store.clearTimer("deliver")
        if (Option.isSome(yield* store.getSingleton(...Singletons.archived))) return
        const pending = yield* store.pendingEvents(BatchSize)
        if (pending.length === 0) return
        const project = yield* core.project.pipe(Effect.orDie)
        const { access, daemonToken } = yield* ensureReady
        const record = yield* core.sandbox
        if (record.rulesDirty) yield* pushRules(record, true)
        yield* refreshDaemonEnv(access, daemonToken)
        const timeZone = Option.flatMap(yield* users.find(project.ownerId), (user) =>
          Option.fromUndefinedOr(user.timeZone)
        )
        const events = pending as unknown as readonly [AgentEvent, ...Array<AgentEvent>]
        const accepted = yield* daemon.deliver(access, daemonToken, events, Option.getOrUndefined(timeZone)).pipe(
          // A restarting dreamd is fine; the retry finds the new one.
          Effect.tapError((error) => (error._tag === "DaemonRestarting" ? Effect.void : diagnose(access, daemonToken)))
        )
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
          // Any failure, expected or not, leaves the events queued and schedules another try.
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const record = yield* core.sandbox
              const failures = record.failures + 1
              const message = Cause.pretty(cause).split("\n")[0] ?? "delivery failed"
              yield* update((r) => ({ ...r, failures, lastError: message }))
              yield* Effect.logWarning("delivery failed", { failures, cause })
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

      /** Mid-turn: keeps the sandbox running, cycling it before E2B's run cap and resuming it if it was paused. */
      const stayAwake = (record: SandboxRecord, access: SandboxAccess, daemonToken: string) =>
        Effect.gen(function* () {
          const info = yield* e2b.info(access.sandboxId)
          // Gone: the next delivery creates a new one.
          if (Option.isNone(info) || info.value.state === "killed") return
          const { state, startedAt } = info.value
          if (state === "running") {
            const now = yield* DateTime.now
            const capAt = startedAt === undefined ? undefined : DateTime.addDuration(startedAt, config.sandboxMaxRun)
            const nearCap =
              capAt !== undefined && Duration.isLessThanOrEqualTo(DateTime.distance(now, capAt), CycleWithin)
            if (!nearCap) return yield* e2b.setTimeout(access.sandboxId, Duration.toSeconds(WorkingTimeout))
            // Pause now rather than at the cap, so the turn is frozen for seconds, not until the next tick.
            yield* Effect.logInfo("sandbox is near E2B's run cap; pausing and resuming it", {
              sandboxId: access.sandboxId
            })
            yield* e2b.pause(access.sandboxId)
          } else {
            yield* Effect.logWarning("sandbox was paused mid-turn; resuming it", { sandboxId: access.sandboxId, state })
          }
          yield* e2b.connect(access.sandboxId, Duration.toSeconds(WorkingTimeout))
          if (record.rulesDirty) yield* pushRules(record, false)
          yield* revive(access, daemonToken)
        })

      const keepalive = Effect.gen(function* () {
        const record = yield* core.sandbox
        if (!record.working || record.access === undefined) return yield* store.clearTimer("turn-keepalive")
        yield* store.setTimer("turn-keepalive", (yield* Clock.currentTimeMillis) + Duration.toMillis(KeepaliveEvery))
        yield* alarm.reschedule
        if (record.daemonToken !== undefined) {
          yield* stayAwake(record, record.access, record.daemonToken).pipe(
            Effect.catch((error) => Effect.logWarning("keepalive couldn't check the sandbox", String(error)))
          )
        }
      })

      // The agent should set a phase itself, but if its first turn starts while
      // the project is still "new", Home shouldn't keep saying so. Later turns
      // leave the phase to the agent.
      const advancePhase = (now: DateTime.Utc) =>
        Effect.gen(function* () {
          const status = yield* core.status
          if (status.phase !== "new") return
          yield* core.saveStatus({ ...status, phase: "exploring", phaseSince: now, updatedAt: now })
          const project = yield* core.project.pipe(Effect.orDie)
          yield* core.saveProject({ ...project, phase: "exploring", updatedAt: now })
        })

      const turnStarted = Effect.gen(function* () {
        const now = yield* DateTime.now
        if ((yield* core.sandbox).startedWork !== true) yield* advancePhase(now)
        yield* update((r) => ({
          ...r,
          working: true,
          startedWork: true,
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

      const archive = Effect.gen(function* () {
        const record = yield* core.sandbox
        if (record.access !== undefined) yield* e2b.kill(record.access.sandboxId).pipe(Effect.ignore)
        yield* update((r) => {
          const { access: _, daemonToken: _t, ...rest } = r
          return { ...rest, status: "none", working: false }
        })
      })

      return SandboxManager.of({
        deliver,
        ensureReady,
        refreshRules,
        gatewayTarget,
        turnStarted,
        turnFinished,
        keepalive: keepalive.pipe(Effect.catch(() => Effect.void)),
        archive
      })
    })
  )
}
