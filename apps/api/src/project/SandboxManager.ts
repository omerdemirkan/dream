/**
 * The project's E2B sandbox and the agent's inbox: create the sandbox from
 * the template on first need (rules carrying the person's credentials, the
 * project's file keys, DaemonEnv for dreamd, then start dreamd), deliver
 * events to dreamd at least once, keep egress rules and file keys current,
 * and keep the sandbox awake while a turn runs. Paused sandboxes resume on
 * traffic, so delivery just sends.
 *
 * E2B pauses any sandbox that has run for `sandboxMaxRun` (1 hour on Hobby),
 * and a turn doesn't make traffic that would resume it. So while a turn runs,
 * the keepalive checks every few minutes: shortly before the cap it pauses and
 * resumes the sandbox itself (resuming restarts the clock), and if it finds
 * the sandbox paused anyway, it resumes it.
 *
 * A sandbox keeps the Dream it was created with unless it's refreshed: when the
 * template has a newer build, the sandbox is brought up to it between turns
 * (`e2b/Refresh.ts`), before the next delivery and shortly after each turn.
 * Projects that sleep for weeks catch up the next time something wakes them.
 *
 * An archived project is held: nothing is delivered or refreshed, no keepalive runs, the gateway doesn't serve
 * it, and its sandbox is paused with everything in it (a running turn too). Restoring it lets delivery go on;
 * a turn that was paused is restarted (`resume`).
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
  ProjectEvent,
  type RelayForward,
  type RelayForwardResult,
  type RelayId,
  type ReasoningEffort,
  SandboxKeyDir,
  sandboxKeyPath,
  type TaskReport,
  type TaskRun,
  type TurnUsage,
  UpstreamFailure,
  type UsageSnapshot
} from "@dream/domain"
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Schedule,
  Semaphore
} from "effect"
import { Tokens } from "../auth/Tokens.ts"
import { ApiConfig } from "../Config.ts"
import { Connections } from "../db/Connections.ts"
import { Projects } from "../db/Projects.ts"
import { TurnUsageLog } from "../db/TurnUsage.ts"
import { Users } from "../db/Users.ts"
import { Daemon } from "../e2b/Daemon.ts"
import { E2B, type SandboxAccess, type TemplateBuild } from "../e2b/E2B.ts"
import { Envd } from "../e2b/Envd.ts"
import { RefreshResult, SandboxRefresh } from "../e2b/Refresh.ts"
import { KeyFiles } from "../integrations/KeyFiles.ts"
import { SandboxCredentials } from "../integrations/SandboxCredentials.ts"
import { toHex, utf8 } from "../lib/Bytes.ts"
import { randomToken } from "../lib/Ids.ts"
import { providerFor, UsageReport } from "../usage/ProjectUsage.ts"
import { Alarm } from "./Alarm.ts"
import { Core } from "./Core.ts"
import { LiveFeed } from "./Live.ts"
import type { GatewayTarget } from "./ProjectRpcs.ts"
import { type SandboxRecord, Singletons, Store } from "./Store.ts"

/**
 * The timeout a sandbox is created and resumed with. E2B gives every wake the creation timeout (and at least five
 * minutes), so this is also how long a wake lasts unless something shortens it: a turn ending (`TurnTail`), or dreamd
 * asking to sleep once the work it was woken for is done.
 */
export const IdleTimeout = Duration.minutes(5)
/**
 * How long an idle sandbox stays up after a turn. It resumes on traffic in under a second, so a reply that comes
 * later costs no noticeable wait; this covers the post-turn checks and the refresh `RefreshAfterTurn` starts.
 */
export const TurnTail = Duration.seconds(90)
/** `StayAwake` keeps the sandbox up this long from each ask. dreamd asks about once a minute while it has work. */
export const AwakeTail = Duration.minutes(2)
/** While a refresh runs, the sandbox is kept up this long, so a slow one (a rollback takes ~2.5 min) isn't paused. */
export const RefreshTimeout = Duration.minutes(5)
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
/** How long the template's newest build, once looked up, is trusted. */
export const LatestBuildTtl = Duration.minutes(10)
/**
 * dreamd asks to sleep when it last looked and saw nothing to do, but anything Dream handed it after that look (events,
 * or a relay's deliveries) it may not have seen. Within this margin of the look counts as after, for clock skew.
 */
export const SleepMargin = Duration.seconds(2)
/** After a turn ends, the sandbox is refreshed (if it's behind) this much later: well within `TurnTail`, and likely idle. */
export const RefreshAfterTurn = Duration.seconds(20)

/** After `failures` failed refreshes to the same build, wait this long before the next try: 1 h, doubling, up to a day. */
export const refreshBackoff = (failures: number): Duration.Duration =>
  Duration.hours(Math.min(24, 2 ** Math.max(0, failures - 1)))

/**
 * What dreamd's env file says, but for the project token (signed afresh on every write). Each harness gets only
 * its own model override: Codex would send a Claude model name to the ChatGPT backend, and the other way round.
 */
export const daemonSettings = (options: {
  readonly apiUrl: string
  readonly projectId: ProjectId
  readonly harness: Harness
  readonly daemonToken: string
  readonly agentModel: Option.Option<string>
  readonly codexAgentModel: Option.Option<string>
  readonly agentEffort: Option.Option<ReasoningEffort>
  readonly progressLine?: boolean
}): Record<string, string> => {
  const model = options.harness === "claude-code" ? options.agentModel : options.codexAgentModel
  return {
    [DaemonEnv.apiUrl]: options.apiUrl,
    [DaemonEnv.projectId]: options.projectId,
    [DaemonEnv.daemonToken]: options.daemonToken,
    [DaemonEnv.harness]: options.harness,
    [DaemonEnv.port]: String(DefaultDaemonPort),
    [DaemonEnv.socket]: DefaultDaemonSocket,
    ...Option.match(model, { onNone: () => ({}), onSome: (value) => ({ [DaemonEnv.model]: value }) }),
    ...Option.match(options.agentEffort, { onNone: () => ({}), onSome: (value) => ({ [DaemonEnv.effort]: value }) }),
    ...(options.progressLine === true ? { [DaemonEnv.progressLine]: "on" } : {})
  }
}

const hashSettings = (settings: Readonly<Record<string, string>>): Effect.Effect<string> =>
  Effect.promise(async () => {
    const canonical = JSON.stringify(
      Object.keys(settings)
        .sort()
        .map((key) => [key, settings[key]])
    )
    return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(canonical))))
  })

const latestRecord = (current: TemplateBuild, checkedAt: DateTime.Utc) => ({
  build: current.build,
  ...Option.match(current.release, { onNone: () => ({}), onSome: (release) => ({ release }) }),
  checkedAt
})

/** A turn's "before" this much older than the turn's start may hide use from outside Dream. */
export const StaleBefore = Duration.minutes(10)
/** How far into a turn a reading still says where the window stood when it began: about its first model call. */
export const EarlyReading = Duration.minutes(3)

/**
 * The "before" a running turn should use once dreamd reports `usage`, or undefined to keep the one it has.
 *
 * The turn starts with the latest stored reading, which dreamd took at the end of the previous turn: after a quiet
 * spell it can be hours old, and whatever they used elsewhere since then would be credited to this turn. dreamd
 * reports the first reading of each turn as soon as the harness gives one, a model call in, so when the stored one
 * is stale and this one came early enough, it takes over (it then misses that first call, a sliver of a percent).
 */
export const freshBefore = (record: SandboxRecord, usage: UsageSnapshot): UsageSnapshot | undefined => {
  if (!record.working || record.turnStartedAt === undefined) return undefined
  const started = DateTime.toEpochMillis(record.turnStartedAt)
  const observed = DateTime.toEpochMillis(usage.observedAt)
  if (observed < started || observed - started > Duration.toMillis(EarlyReading)) return undefined
  const before = record.turnUsageBefore
  const stale =
    before === undefined ||
    before.provider !== usage.provider ||
    started - DateTime.toEpochMillis(before.observedAt) > Duration.toMillis(StaleBefore)
  return stale ? usage : undefined
}

const withoutStarting = (record: SandboxRecord): SandboxRecord => {
  const { startingSince: _, ...rest } = record
  return rest
}

/** The `NotFound` entity `gatewayTarget` names for an archived project, so the gateway can say so. */
export const ArchivedEntity = "archived project"

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
    /** The project's file keys changed: they're rewritten before the next delivery, so before the agent hears. */
    readonly keyFilesChanged: Effect.Effect<void>
    readonly gatewayTarget: Effect.Effect<GatewayTarget, NotFound | UpstreamFailure>
    /** A turn started: the phone hears it's working, and the subscription's usage now is noted as its "before". */
    readonly turnStarted: Effect.Effect<void>
    /** What the running turn is doing (`SandboxRpcs.ReportProgress`); ignored between turns. */
    readonly reportProgress: (report: {
      readonly line?: string | undefined
      readonly activeAt: DateTime.Utc
      readonly waitingSince?: DateTime.Utc | undefined
    }) => Effect.Effect<void>
    /** A phone subscribed to the live feed, or left it: dreamd hears whether anyone is watching. */
    readonly watchersChanged: Effect.Effect<void>
    /** A turn finished, with the tokens it used (none from older dreamd builds): recorded, and the header updated. */
    readonly turnFinished: (usage?: TurnUsage | undefined) => Effect.Effect<void>
    /**
     * dreamd reported where the subscription stands. Early in a turn, a reading replaces the turn's "before" when
     * that one is stale (see `freshBefore`).
     */
    readonly usageReported: (usage: UsageSnapshot) => Effect.Effect<void>
    /** A scheduled task's session finished (`SandboxRpcs.ReportTask`): recorded like a turn, and on its wake. */
    readonly taskFinished: (report: TaskReport) => Effect.Effect<void>
    readonly keepalive: Effect.Effect<void>
    /**
     * dreamd is running a scheduled command, taking a relay's delivery or serving the published app: keep the sandbox
     * up a while longer.
     */
    readonly stayAwake: Effect.Effect<void>
    /**
     * dreamd has nothing left to do (`SandboxRpcs.Sleep`): pause the sandbox now, unless a turn runs, events are on
     * their way or were just handed over, a relay delivery is under way, or a turn ended in the last few minutes.
     */
    readonly sleep: (reason: "command" | "relay" | "app", checkedAt: DateTime.Utc) => Effect.Effect<void>
    /**
     * Hands a relay's events to dreamd, which posts them to the app on `port`, waking the sandbox (creating it, if
     * there's none). Failures come back in the result, for the relay to retry.
     */
    readonly forwardRelay: (request: {
      readonly relayId: RelayId
      readonly port: number
      readonly path: string
      readonly deliveries: readonly [RelayForward, ...Array<RelayForward>]
    }) => Effect.Effect<RelayForwardResult>
    /** Brings the sandbox up to the template's newest build, if it's behind and between turns. */
    readonly refresh: Effect.Effect<void>
    /** Kills the sandbox for good (retiring the project). */
    readonly destroy: Effect.Effect<void>
    /** They archived the project: stop the keepalive, refresh and delivery timers, and pause the sandbox where it is. */
    readonly pause: Effect.Effect<void>
    /** They restored it: deliver what's waiting, and restart dreamd if a turn was paused under it. */
    readonly restored: Effect.Effect<void>
    /** The `sandbox-resume` timer: brings back a turn the archive paused (dreamd restarts, and its events go again). */
    readonly resume: Effect.Effect<void>
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
      const keyFiles = yield* KeyFiles
      const projects = yield* Projects
      const users = yield* Users
      const refresher = yield* SandboxRefresh
      const connections = yield* Connections
      const turnLog = yield* TurnUsageLog
      const usageReport = yield* UsageReport
      const live = yield* LiveFeed
      const busy = yield* Semaphore.make(1)
      /**
       * Held while the timeout is set from what the record says (the keepalive, a turn ending, `stayAwake`), so a
       * turn starting under a `stayAwake` can't have its longer timeout replaced by a shorter one.
       */
      const timeouts = yield* Semaphore.make(1)
      /** Relay deliveries under way, and when dreamd was last handed anything. */
      const relaysInFlight = yield* Ref.make(0)
      const lastHandoffMs = yield* Ref.make<number | undefined>(undefined)
      const handedOff = Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(lastHandoffMs, now))

      const update = (f: (record: SandboxRecord) => SandboxRecord) =>
        Effect.flatMap(core.sandbox, (r) => core.saveSandbox(f(r)))

      const deleted = Effect.map(store.getSingleton(...Singletons.deleted), Option.isSome)

      /** Deleted, or archived until they restore it: either way, nothing runs. */
      const held = Effect.gen(function* () {
        if (yield* deleted) return true
        return Option.isSome(yield* store.getSingleton(...Singletons.archived))
      })

      const pauseSandbox = (sandboxId: string) =>
        e2b
          .pause(sandboxId)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                "couldn't pause the archived project's sandbox; it pauses on its timeout",
                error.message
              )
            )
          )

      /**
       * Waits until dreamd answers. With `envHash` (after writing the env file), it waits for the dreamd that read
       * that file: the one answering first may be the old process, which hasn't noticed the change yet.
       */
      const waitForDaemon = (access: SandboxAccess, daemonToken: string, within: Duration.Duration, envHash?: string) =>
        Effect.gen(function* () {
          const since = yield* Clock.currentTimeMillis
          return yield* daemon.health(access, daemonToken).pipe(
            Effect.flatMap((health) =>
              Effect.gen(function* () {
                if (envHash === undefined || health.envHash === envHash) return health
                const waited = (yield* Clock.currentTimeMillis) - since
                if (health.envHash === undefined && waited >= Duration.toMillis(LegacyRestartWait)) return health
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
            agentModel: config.agentModel,
            codexAgentModel: config.codexAgentModel,
            agentEffort: config.agentEffort,
            progressLine: config.progressLine
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
          return yield* waitForDaemon(access, daemonToken, Duration.seconds(45), envHash).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                yield* Effect.logWarning("dreamd didn't answer; starting it directly")
                yield* startDaemon(access)
                return yield* waitForDaemon(access, daemonToken, HealthWait, envHash)
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

      const runChecked = (access: SandboxAccess, what: string, command: string) =>
        Effect.flatMap(envd.run(access, { command, timeout: "20 seconds" }), (result) =>
          result.exitCode === 0
            ? Effect.void
            : Effect.fail(new UpstreamFailure({ service: "E2B", message: `${what} failed (exit ${result.exitCode})` }))
        )

      /**
       * Makes `SandboxKeyDir` hold exactly the project's file keys: the directory 0700, each file 0600, all owned
       * by the sandbox's user. A value goes only into a file body through envd, never into a command line or a
       * log; it's written beside its target and renamed, so a reader never sees a partial key. Names passed
       * `keyFileNameProblem`, so they need no quoting.
       */
      const writeKeyFiles = (access: SandboxAccess) =>
        Effect.gen(function* () {
          const project = yield* core.project.pipe(Effect.orDie)
          const files = yield* keyFiles.forProject(project.ownerId, project.id)
          const keep = files.map((file) => `! -name ${file.name}`).join(" ")
          yield* runChecked(
            access,
            "Preparing the key folder",
            `install -d -m 700 ${SandboxKeyDir} && find ${SandboxKeyDir} -mindepth 1 -maxdepth 1 ${keep} -exec rm -rf {} +`
          )
          for (const file of files) {
            const target = sandboxKeyPath(file.name)
            const partial = `${SandboxKeyDir}/.${file.name}.partial`
            yield* envd.writeFile(access, partial, file.value)
            yield* runChecked(access, `Writing ${target}`, `chmod 600 ${partial} && mv -f ${partial} ${target}`)
          }
        }).pipe(Effect.withSpan("SandboxManager.writeKeyFiles"))

      const create = Effect.gen(function* () {
        const project = yield* core.project.pipe(Effect.orDie)
        const daemonToken = randomToken(40)
        const setup = yield* credentials.setup(project.ownerId, project.harness)
        yield* update((r) => ({ ...r, status: "creating" }))
        // The build it's about to get (unknown if the lookup fails; then the first refresh check settles it).
        const build = yield* e2b
          .currentBuild(config.sandboxTemplate)
          .pipe(Effect.orElseSucceed(() => Option.none<TemplateBuild>()))
        const access = yield* e2b.create({
          template: config.sandboxTemplate,
          timeoutSeconds: Duration.toSeconds(IdleTimeout),
          autoPause: true,
          envVars: {},
          metadata: { projectId: project.id, userId: project.ownerId },
          rules: setup.rules
        })
        // The keys are in place before the agent's first turn.
        const ready = Effect.andThen(writeKeyFiles(access), restartDaemon(access, daemonToken))
        // Don't leak a sandbox that never became usable.
        const health = yield* ready.pipe(Effect.tapError(() => e2b.kill(access.sandboxId).pipe(Effect.ignore)))
        const now = yield* DateTime.now
        // What was known about an earlier sandbox's Dream doesn't carry over to this one.
        yield* update(({ templateBuild: _b, release: _r, latestBuild: _l, refreshFailure: _f, ...r }) => ({
          ...r,
          status: "ready",
          access,
          daemonToken,
          createdAt: now,
          rulesHash: setup.rulesHash,
          rulesDirty: false,
          keyFilesDirty: false,
          failures: 0,
          ...(health.release === undefined ? {} : { release: health.release }),
          ...Option.match(build, {
            onNone: () => ({}),
            onSome: (current) => ({ templateBuild: current.build, latestBuild: latestRecord(current, now) })
          })
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

      /** The template's current build, looked up at most every `LatestBuildTtl`. */
      const latestBuild = Effect.gen(function* () {
        const record = yield* core.sandbox
        const now = yield* DateTime.now
        const cached = record.latestBuild
        if (cached !== undefined && Duration.isLessThan(DateTime.distance(cached.checkedAt, now), LatestBuildTtl)) {
          return Option.some({ build: cached.build, release: Option.fromUndefinedOr(cached.release) })
        }
        const current = yield* e2b.currentBuild(config.sandboxTemplate)
        if (Option.isSome(current)) yield* update((r) => ({ ...r, latestBuild: latestRecord(current.value, now) }))
        return current
      })

      /**
       * Between turns, if the sandbox's Dream is behind the template's current build, refresh it. Behind means a
       * different release when the build's tag names one (so a rebuild of the same source isn't), else a different
       * build. A failure is logged and backed off per build; it never stands in the way of delivery (a failed refresh
       * rolls itself back).
       */
      const refreshIfDue = (access: SandboxAccess, daemonToken: string) =>
        Effect.gen(function* () {
          if (!config.sandboxRefresh) return
          const record = yield* core.sandbox
          if (record.working) return
          const found = yield* latestBuild
          if (Option.isNone(found)) return
          const latest = { build: found.value.build, release: Option.getOrUndefined(found.value.release) }
          if (
            latest.release !== undefined ? record.release === latest.release : record.templateBuild === latest.build
          ) {
            if (record.templateBuild !== latest.build) yield* settle(latest.build, latest.release)
            return
          }
          const now = yield* DateTime.now
          const failure = record.refreshFailure
          if (failure?.build === latest.build && DateTime.isLessThan(now, failure.retryAt)) return
          const project = yield* core.project.pipe(Effect.orDie)
          yield* Effect.logInfo("the sandbox is behind the template; refreshing it", {
            sandboxId: access.sandboxId,
            from: { build: record.templateBuild, release: record.release },
            to: latest
          })
          const result = yield* refresher
            .run({
              target: access,
              daemonToken,
              template: config.sandboxTemplate,
              metadata: { projectId: project.id, userId: project.ownerId }
            })
            .pipe(holdUpWhile(access.sandboxId), Effect.result)
          if (result._tag === "Failure") {
            const failures = failure?.build === latest.build ? failure.failures + 1 : 1
            yield* Effect.logError("couldn't refresh the sandbox", {
              sandboxId: access.sandboxId,
              step: result.failure.step,
              error: result.failure.message,
              rolledBack: result.failure.rolledBack,
              failures
            })
            yield* update((r) => ({
              ...r,
              refreshFailure: {
                build: latest.build,
                failures,
                retryAt: DateTime.addDuration(now, refreshBackoff(failures)),
                message: `${result.failure.step}: ${result.failure.message}`
              }
            }))
            return
          }
          yield* RefreshResult.$match(result.success, {
            Busy: () => Effect.void,
            // Built before refreshing existed: there's nothing newer to bring over, so don't look again for this build.
            Unsupported: () => update((r) => ({ ...r, templateBuild: latest.build })),
            Current: ({ release, build }) =>
              settle(
                Option.getOrElse(build, () => latest.build),
                release
              ),
            Refreshed: ({ release, build }) =>
              settle(
                Option.getOrElse(build, () => latest.build),
                release
              )
          })
        }).pipe(
          Effect.catch((error) => Effect.logWarning("couldn't check for a newer sandbox template", error.message)),
          Effect.withSpan("SandboxManager.refreshIfDue")
        )

      /**
       * Keeps the sandbox up for `RefreshTimeout` while `effect` runs (a turn's tail or a wake may be shorter than a
       * refresh), then gives it the post-turn tail again, unless a turn has started meanwhile.
       */
      const holdUpWhile =
        (sandboxId: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>) => {
          const setTo = (timeout: Duration.Duration) =>
            timeouts
              .withPermits(1)(e2b.setTimeout(sandboxId, Duration.toSeconds(timeout)))
              .pipe(Effect.catch((error) => Effect.logWarning("couldn't set the sandbox's timeout", String(error))))
          return setTo(RefreshTimeout).pipe(
            Effect.andThen(effect),
            Effect.ensuring(Effect.flatMap(core.sandbox, (record) => (record.working ? Effect.void : setTo(TurnTail))))
          )
        }

      const settle = (build: string, release: string | undefined) =>
        update((r) => {
          const { refreshFailure: _, ...rest } = r
          return { ...rest, templateBuild: build, ...(release === undefined ? {} : { release }) }
        })

      const refresh = busy
        .withPermits(1)(
          Effect.gen(function* () {
            yield* store.clearTimer("sandbox-refresh")
            const record = yield* core.sandbox
            if (record.status !== "ready" || record.access === undefined || record.daemonToken === undefined) return
            if (yield* held) return
            yield* refreshIfDue(record.access, record.daemonToken)
          })
        )
        .pipe(Effect.catchCause((cause) => Effect.logWarning("sandbox refresh check failed", { cause })))

      const deliverOnce = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        // Restoring an archived project sets the timer again.
        if (yield* held) return yield* store.clearTimer("deliver")
        const pause = yield* core.usagePause
        if (Option.isSome(pause) && DateTime.toEpochMillis(pause.value.until) > now) {
          yield* store.setTimer("deliver", DateTime.toEpochMillis(pause.value.until))
          return yield* alarm.reschedule
        }
        yield* store.clearTimer("deliver")
        const pending = yield* store.pendingEvents(BatchSize)
        if (pending.length === 0) return
        const project = yield* core.project.pipe(Effect.orDie)
        // Their messages have reached the agent's machine: they read "Seen" from here on.
        yield* core.markSeen(pending.map((event) => event.id))
        // Between turns, the phone says the agent is starting until a turn takes these (or delivery fails).
        const before = yield* core.sandbox
        if (!before.working && before.startingSince === undefined) {
          const since = yield* DateTime.now
          yield* update((r) => (r.working ? r : { ...r, startingSince: since }))
        }
        const { access, daemonToken } = yield* ensureReady
        const record = yield* core.sandbox
        if (record.rulesDirty) yield* pushRules(record, true)
        if (record.keyFilesDirty === true) {
          // Cleared first, so a change made while writing marks them again. A failure leaves the events queued.
          yield* update((r) => ({ ...r, keyFilesDirty: false }))
          const timeout = Duration.toSeconds(record.working ? WorkingTimeout : IdleTimeout)
          yield* e2b.connect(access.sandboxId, timeout).pipe(
            Effect.flatMap(writeKeyFiles),
            Effect.tapError((error) =>
              // A sandbox that's gone is created again, and creating one writes the keys.
              update((r) => ({
                ...r,
                keyFilesDirty: true,
                ...(error._tag === "SandboxGone" ? { status: "none" as const } : {})
              }))
            )
          )
        }
        // Archived while the sandbox was being created or resumed: leave the events for after the restore.
        if (yield* held) {
          // Deleted meanwhile: the sandbox it just created or resumed goes too.
          if (yield* deleted) {
            yield* e2b.kill(access.sandboxId).pipe(Effect.ignore)
            return yield* update((r) => ({ ...withoutStarting(r), status: "none" }))
          }
          yield* update(withoutStarting)
          return yield* pauseSandbox(access.sandboxId)
        }
        yield* refreshIfDue(access, daemonToken)
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
        yield* handedOff
        // A scheduled command or task that succeeds never reaches the agent, so it starts no turn: stop saying
        // "starting".
        const startsNoTurn = pending.every(
          (event) => event._tag === "WakeDue" && (event.run !== undefined || event.task !== undefined)
        )
        yield* update((r) => (startsNoTurn ? withoutStarting({ ...r, failures: 0 }) : { ...r, failures: 0 }))
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
              yield* update((r) => withoutStarting({ ...r, failures, lastError: message }))
              yield* Effect.logWarning("delivery failed", { failures, cause })
              yield* scheduleRetry(failures)
            })
          ),
          Effect.withSpan("SandboxManager.deliver")
        )

      /** If the sandbox is behind the template, the alarm refreshes it now (`refresh` checks, between turns). */
      const refreshSoon = Effect.gen(function* () {
        if (!config.sandboxRefresh || (yield* core.sandbox).working) return
        yield* store.setTimer("sandbox-refresh", yield* Clock.currentTimeMillis)
        yield* alarm.reschedule
      })

      /**
       * Where the gateway sends a visit to the published app. A visit is also when a sandbox that's behind the template
       * is brought up to date: a project woken only by its app (a podcast feed that apps poll, a page people open) gets
       * no delivery and no turn, so it would otherwise keep the dreamd it last ran a turn with, along with whatever that
       * one got wrong. The gateway asks, rather than dreamd, because an old dreamd may be the problem: one from before
       * API calls took a new connection hung on its first call after a sleep, and so never reported a visit. The
       * refresh restarts dreamd, which the app runs outside of.
       */
      const gatewayTarget = Effect.gen(function* () {
        const project = yield* core.project
        // Serving it would wake the sandbox, and with it a turn the archive paused.
        if (Option.isSome(yield* store.getSingleton(...Singletons.archived))) {
          return yield* new NotFound({ entity: ArchivedEntity, id: project.id })
        }
        if (project.publishedPort === undefined) {
          return yield* new NotFound({ entity: "published port", id: project.id })
        }
        const record = yield* core.sandbox
        if (record.access === undefined) return yield* new NotFound({ entity: "sandbox", id: project.id })
        if (record.rulesDirty) yield* pushRules(record, true)
        yield* refreshSoon
        return {
          origin: `https://${project.publishedPort}-${record.access.sandboxId}.${record.access.domain}`,
          trafficAccessToken: record.access.trafficAccessToken
        }
      })

      /** Mid-turn: keeps the sandbox running, cycling it before E2B's run cap and resuming it if it was paused. */
      const keepTurnRunning = (record: SandboxRecord, access: SandboxAccess, daemonToken: string) =>
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
        if (yield* held) {
          // A turn that started anyway (the sandbox was woken while archived) is paused again.
          yield* store.clearTimer("turn-keepalive")
          if (record.working && record.access !== undefined) yield* pause
          return
        }
        if (!record.working || record.access === undefined) return yield* store.clearTimer("turn-keepalive")
        yield* store.setTimer("turn-keepalive", (yield* Clock.currentTimeMillis) + Duration.toMillis(KeepaliveEvery))
        yield* alarm.reschedule
        if (record.daemonToken !== undefined) {
          yield* timeouts
            .withPermits(1)(keepTurnRunning(record, record.access, record.daemonToken))
            .pipe(Effect.catch((error) => Effect.logWarning("keepalive couldn't check the sandbox", String(error))))
        }
        // dreamd stops reporting progress if it isn't told again within a few keepalives.
        if ((yield* live.watchers) > 0) yield* tellWatching(true)
      })

      /**
       * dreamd has work between turns (`StayAwake`): the sandbox stays up until `AwakeTail` from now. A turn's
       * keepalive keeps it up longer, and E2B's own timeout may already be later, so neither is shortened.
       */
      const stayAwake = timeouts
        .withPermits(1)(
          Effect.gen(function* () {
            if (yield* held) return
            const record = yield* core.sandbox
            if (record.working || record.access === undefined) return
            const sandboxId = record.access.sandboxId
            const info = yield* e2b.info(sandboxId)
            if (Option.isNone(info) || info.value.state !== "running") return
            const until = DateTime.addDuration(yield* DateTime.now, AwakeTail)
            const endAt = Option.flatMap(Option.fromUndefinedOr(info.value.endAt), DateTime.make)
            if (Option.isSome(endAt) && DateTime.isGreaterThanOrEqualTo(endAt.value, until)) return
            yield* e2b.setTimeout(sandboxId, Duration.toSeconds(AwakeTail))
          })
        )
        .pipe(Effect.catch((error) => Effect.logWarning("couldn't keep the sandbox awake", String(error))))

      const sleep = (reason: "command" | "relay" | "app", checkedAt: DateTime.Utc) =>
        busy
          .withPermitsIfAvailable(1)(
            timeouts.withPermits(1)(
              Effect.gen(function* () {
                if (yield* held) return "held"
                const record = yield* core.sandbox
                if (record.status !== "ready" || record.access === undefined) return "no sandbox"
                if (record.working || record.startingSince !== undefined) return "a turn is starting or running"
                if ((yield* Ref.get(relaysInFlight)) > 0) return "a relay delivery is under way"
                const nowMs = yield* Clock.currentTimeMillis
                const last = yield* Ref.get(lastHandoffMs)
                if (last !== undefined && last >= DateTime.toEpochMillis(checkedAt) - Duration.toMillis(SleepMargin)) {
                  return "dreamd was handed something after it looked"
                }
                if (record.awakeUntil !== undefined && DateTime.toEpochMillis(record.awakeUntil) > nowMs) {
                  return "a turn ended a moment ago"
                }
                if ((yield* store.pendingEvents(1)).length > 0) return "events are on their way"
                const sandboxId = record.access.sandboxId
                const info = yield* e2b.info(sandboxId)
                if (Option.isNone(info) || info.value.state !== "running") return "it isn't running"
                yield* e2b.pause(sandboxId)
                return "paused"
              })
            )
          )
          .pipe(
            Effect.map(Option.getOrElse(() => "a delivery or refresh is under way")),
            Effect.tap((outcome) => Effect.logInfo("dreamd asked to sleep", { reason, outcome })),
            Effect.catch((error) => Effect.logWarning("couldn't put the sandbox to sleep", String(error))),
            Effect.asVoid
          )

      const forwardRelay: Context.Service.Shape<typeof SandboxManager>["forwardRelay"] = (request) =>
        Effect.gen(function* () {
          if (yield* held) return { delivered: 0, failure: { message: "The project is archived." } }
          const { access, daemonToken } = yield* ensureReady
          const record = yield* core.sandbox
          if (record.rulesDirty) yield* pushRules(record, true)
          return yield* daemon.forwardRelay(access, daemonToken, request)
        }).pipe(
          Effect.catchTags({
            DaemonRestarting: () => Effect.succeed({ delivered: 0, failure: { message: "dreamd is restarting." } }),
            UpstreamFailure: (error) => Effect.succeed({ delivered: 0, failure: { message: error.message } })
          }),
          Effect.ensuring(handedOff),
          (effect) =>
            Effect.acquireUseRelease(
              Ref.update(relaysInFlight, (n) => n + 1),
              () => effect,
              () => Ref.update(relaysInFlight, (n) => n - 1)
            )
        )

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

      /** The subscription's latest usage report, from any of their sandboxes. */
      const latestUsage = Effect.gen(function* () {
        const project = yield* core.project.pipe(Effect.orDie)
        const connection = yield* connections.connectedModel(project.ownerId, providerFor(project))
        return Option.match(connection, { onNone: () => undefined, onSome: (row) => row.usage_json ?? undefined })
      })

      const turnStarted = Effect.gen(function* () {
        const now = yield* DateTime.now
        if ((yield* core.sandbox).startedWork !== true) yield* advancePhase(now)
        const before = yield* latestUsage
        yield* update((r) => {
          // A repeated "started" for the running turn keeps the turn's start and its "before".
          const continuing = r.working && r.turnStartedAt !== undefined
          const { turnUsageBefore: _, progress: _p, ...rest } = withoutStarting(r)
          const kept = continuing ? r.turnUsageBefore : before
          return {
            ...rest,
            working: true,
            startedWork: true,
            turnStartedAt: continuing && r.turnStartedAt ? r.turnStartedAt : now,
            ...(kept === undefined ? {} : { turnUsageBefore: kept }),
            ...(continuing && r.progress !== undefined ? { progress: r.progress } : {})
          }
        })
        yield* keepalive
        // dreamd reports progress only while someone watches; it forgets between turns.
        if ((yield* live.watchers) > 0) yield* tellWatching(true)
      })

      const usageReported = (usage: UsageSnapshot) =>
        update((r) => {
          const before = freshBefore(r, usage)
          return before === undefined ? r : { ...r, turnUsageBefore: before }
        })

      /** Tells dreamd whether anyone is watching, while a turn runs. Best effort: a miss only delays a line. */
      const tellWatching = (watching: boolean) =>
        Effect.gen(function* () {
          const record = yield* core.sandbox
          if (!config.progressLine || !record.working || record.access === undefined) return
          if (record.daemonToken === undefined) return
          yield* daemon.setWatching(record.access, record.daemonToken, watching)
        }).pipe(Effect.catch((error) => Effect.logInfo("couldn't tell dreamd who's watching", error.message)))

      const watchersChanged = Effect.flatMap(live.watchers, (count) => tellWatching(count > 0))

      const reportProgress = (report: {
        readonly line?: string | undefined
        readonly activeAt: DateTime.Utc
        readonly waitingSince?: DateTime.Utc | undefined
      }) =>
        Effect.gen(function* () {
          const at = yield* DateTime.now
          yield* update((r) =>
            r.working
              ? {
                  ...r,
                  progress: {
                    ...(report.line === undefined ? {} : { line: report.line }),
                    activeAt: report.activeAt,
                    ...(report.waitingSince === undefined ? {} : { waitingSince: report.waitingSince }),
                    at
                  }
                }
              : r
          )
        })

      /**
       * Records the turn's model usage in the ledger, with the subscription's usage before (when it started) and
       * after (now: dreamd reports usage just before it reports the turn finished), then sends the phone the
       * header's new figures. Never fails the report: a ledger problem is logged.
       */
      const recordModelTurn = (record: SandboxRecord, ended: DateTime.Utc, usage: TurnUsage | undefined) =>
        Effect.gen(function* () {
          if (record.turnStartedAt === undefined) return
          const project = yield* core.project.pipe(Effect.orDie)
          yield* turnLog.record({
            id: `trn_${randomToken(22)}`,
            userId: project.ownerId,
            projectId: project.id,
            provider: providerFor(project),
            startedAt: record.turnStartedAt,
            endedAt: ended,
            usage,
            before: record.turnUsageBefore,
            after: yield* latestUsage
          })
          yield* live.publish(ProjectEvent.cases.Usage.make({ usage: yield* usageReport.glance(project) }))
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't record the turn's usage", { cause })))

      const taskFinished = (report: TaskReport) =>
        Effect.gen(function* () {
          const project = yield* core.project.pipe(Effect.orDie)
          yield* turnLog.record({
            id: `trn_${randomToken(22)}`,
            userId: project.ownerId,
            projectId: project.id,
            provider: providerFor(project),
            startedAt: report.startedAt,
            endedAt: report.endedAt,
            usage: report.usage,
            before: report.before,
            after: report.after ?? (yield* latestUsage),
            wakeId: report.wakeId
          })
          const wake = yield* store.wake(report.wakeId)
          if (Option.isSome(wake)) {
            const lastRun: TaskRun = {
              startedAt: report.startedAt,
              endedAt: report.endedAt,
              outcome: report.outcome,
              ...(report.summary === undefined ? {} : { summary: report.summary }),
              ...(report.usage === undefined ? {} : { usage: report.usage })
            }
            const { nextAt } = wake.value
            yield* store.putWake(
              { ...wake.value, lastRun },
              nextAt === undefined ? undefined : DateTime.toEpochMillis(nextAt)
            )
            yield* core.wakesChanged
          }
          yield* live.publish(ProjectEvent.cases.Usage.make({ usage: yield* usageReport.glance(project) }))
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't record the task's run", { cause })))

      const turnFinished = (usage?: TurnUsage | undefined) =>
        Effect.gen(function* () {
          const record = yield* core.sandbox
          const now = yield* DateTime.now
          yield* update((r) => {
            const { turnStartedAt: _, turnUsageBefore: _b, progress: _p, ...rest } = withoutStarting(r)
            return { ...rest, working: false, turnEndedAt: now, awakeUntil: DateTime.addDuration(now, TurnTail) }
          })
          yield* store.clearTimer("turn-keepalive")
          if (config.sandboxRefresh) {
            yield* store.setTimer(
              "sandbox-refresh",
              (yield* Clock.currentTimeMillis) + Duration.toMillis(RefreshAfterTurn)
            )
          }
          yield* alarm.reschedule
          if (record.access !== undefined) {
            yield* timeouts
              .withPermits(1)(e2b.setTimeout(record.access.sandboxId, Duration.toSeconds(TurnTail)))
              .pipe(Effect.ignore)
          }
          // Machine time for this turn, plus the idle tail before E2B pauses it.
          yield* recordTurnUsage(record, DateTime.addDuration(now, TurnTail))
          yield* recordModelTurn(record, now, usage)
        })

      const recordTurnUsage = (record: SandboxRecord, ended: DateTime.Utc) =>
        Effect.gen(function* () {
          if (record.turnStartedAt === undefined) return
          const project = yield* core.project.pipe(Effect.orDie)
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
        })

      const pause = Effect.gen(function* () {
        for (const timer of ["deliver", "turn-keepalive", "sandbox-refresh", "sandbox-resume"] as const) {
          yield* store.clearTimer(timer)
        }
        yield* alarm.reschedule
        const record = yield* core.sandbox
        const now = yield* DateTime.now
        if (record.working) {
          yield* recordTurnUsage(record, now)
          // The turn stops here: its tokens are never reported, but the window moved while it ran.
          yield* recordModelTurn(record, now, undefined)
        }
        // Paused, the sandbox is asleep: the phone shows no turn, and the paused one is noted for the restore.
        yield* update((r) => {
          const { turnStartedAt: _, turnUsageBefore: _b, awakeUntil: _a, progress: _p, ...rest } = withoutStarting(r)
          return r.working ? { ...rest, working: false, turnEndedAt: now, interruptedTurn: true } : rest
        })
        if (record.access !== undefined) yield* pauseSandbox(record.access.sandboxId)
      })

      const restored = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if ((yield* core.sandbox).interruptedTurn === true) yield* store.setTimer("sandbox-resume", now)
        if ((yield* store.pendingEvents(1)).length > 0) yield* store.setTimer("deliver", now)
        yield* alarm.reschedule
      })

      const resume = busy
        .withPermits(1)(
          Effect.gen(function* () {
            yield* store.clearTimer("sandbox-resume")
            if (yield* held) return
            const record = yield* core.sandbox
            if (record.interruptedTurn !== true) return
            const clear = update(({ interruptedTurn: _, ...r }) => r)
            if (record.status !== "ready" || record.access === undefined || record.daemonToken === undefined) {
              return yield* clear
            }
            const daemonToken = record.daemonToken
            yield* e2b.connect(record.access.sandboxId, Duration.toSeconds(IdleTimeout)).pipe(
              Effect.tap(() => (record.rulesDirty ? pushRules(record, false) : Effect.void)),
              // dreamd puts the paused turn's events back in its inbox and starts a fresh turn with them.
              Effect.flatMap((access) => restartDaemon(access, daemonToken)),
              Effect.andThen(update(({ interruptedTurn: _, ...r }) => ({ ...r, failures: 0 }))),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  if (error._tag === "SandboxGone") {
                    // Its inbox went with it; the next delivery creates a new sandbox.
                    yield* Effect.logError("the restored project's sandbox no longer exists", {
                      sandboxId: error.sandboxId
                    })
                    return yield* update(({ interruptedTurn: _, ...r }) => ({
                      ...r,
                      status: "none",
                      rulesDirty: false
                    }))
                  }
                  const failures = record.failures + 1
                  yield* Effect.logWarning("couldn't restart the turn the archive paused", { failures, error })
                  yield* update((r) => ({ ...r, failures, lastError: error.message }))
                  yield* store.setTimer("sandbox-resume", (yield* Clock.currentTimeMillis) + backoffMs(failures))
                  yield* alarm.reschedule
                })
              )
            )
          })
        )
        .pipe(Effect.catchCause((cause) => Effect.logWarning("resuming the restored project failed", { cause })))

      const destroy = Effect.gen(function* () {
        const record = yield* core.sandbox
        if (record.access !== undefined) yield* e2b.kill(record.access.sandboxId).pipe(Effect.ignore)
        yield* update((r) => {
          const { access: _, daemonToken: _t, awakeUntil: _a, ...rest } = withoutStarting(r)
          return { ...rest, status: "none", working: false }
        })
      })

      const keyFilesChanged = update((r) => ({ ...r, keyFilesDirty: true }))

      return SandboxManager.of({
        deliver,
        ensureReady,
        refreshRules,
        keyFilesChanged,
        gatewayTarget,
        turnStarted,
        turnFinished,
        usageReported,
        taskFinished,
        reportProgress,
        watchersChanged,
        keepalive: keepalive.pipe(Effect.catch(() => Effect.void)),
        stayAwake,
        sleep,
        forwardRelay,
        refresh,
        destroy,
        pause,
        restored,
        resume
      })
    })
  )
}
