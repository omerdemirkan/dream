/**
 * Brings a running sandbox's Dream up to date with the template's newest build: dreamd, the `dream` CLI, the
 * prompt and skill, the supervisor, and the harness bridges with their Claude Code and Codex CLIs. E2B can't change
 * a sandbox's template, so the bits come from a donor: a fresh sandbox of the template, which has exactly what a new
 * project would get. The donor packs `/opt/dream` and `~/.ai-sdk-harness/.harness-bootstrap` into a tar, and the
 * project's sandbox downloads it straight from the donor's envd (sandbox to sandbox, ~800 MB in seconds) into
 * `<dir>.next`. The new copy's `refresh.sh` then checks it runs, stops dreamd, swaps the copies and starts the new
 * supervisor; once the new dreamd answers with the donor's release, the old copies are dropped. If anything fails
 * after the swap, the old copies go back and the old dreamd starts again.
 *
 * Only Dream's own files change. The project, dreamd's inbox and harness session (`~/.dream`), the harnesses'
 * conversations (`~/.claude`, `~/.codex`, `~/.ai-sdk-harness/.agent-runs`) and the apps the agent runs stay as they
 * are; dreamd restarts as it does when its env file changes, and resumes the conversation on its next turn.
 *
 * The caller decides when (never during a turn); this only does it.
 */
import { UpstreamFailure } from "@dream/domain"
import { Clock, Context, Data, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { Daemon } from "./Daemon.ts"
import { E2B, type SandboxAccess, type TemplateBuild } from "./E2B.ts"
import { Envd } from "./Envd.ts"

/** What a template build stamps into `/opt/dream/release.json` (see packages/sandbox-template). */
const ReleaseFile = Schema.fromJsonString(Schema.Struct({ release: Schema.String }))

export const ReleasePath = "/opt/dream/release.json"
const Tarball = "/tmp/dream-release.tar"
const DonorTimeout = Duration.minutes(10)
const NewDaemonWait = Duration.seconds(90)

/** What the donor's tar holds, relative to `/`. */
const packed = ["opt/dream", "home/user/.ai-sdk-harness/.harness-bootstrap"] as const

/** In the project's sandbox, as root: download the donor's tar and unpack it beside the live copies, as `.next`. */
export const stageCommand = [
  "set -euo pipefail",
  "rm -rf /opt/dream.next /home/user/.ai-sdk-harness/.harness-bootstrap.next",
  "mkdir -p /home/user/.ai-sdk-harness",
  `curl -fsS --retry 3 -H "x-access-token: $DONOR_TOKEN" "$DONOR_URL" | tar -x -C / ${packed
    .map((path) => `--transform='s,^${path.replaceAll(".", "\\.")},${path}.next,'`)
    .join(" ")}`,
  "test -f /opt/dream.next/sandbox/refresh.sh"
].join("\n")

export const refreshScript = (tree: string) => `bash ${tree}/sandbox/refresh.sh`

export type RefreshResult = Data.TaggedEnum<{
  /** The sandbox now runs `release`, from template build `build`. */
  Refreshed: { readonly release: string; readonly build: Option.Option<string> }
  /** It already ran the donor's release. */
  Current: { readonly release: string; readonly build: Option.Option<string> }
  /** The template's newest build predates refreshing (no release file): nothing to refresh to. */
  Unsupported: { readonly build: Option.Option<string> }
  /** A turn is running; try again later. */
  Busy: {}
}>
export const RefreshResult = Data.taggedEnum<RefreshResult>()

/** The refresh failed; `rolledBack` says whether the sandbox is back on its old dreamd (it is unless that failed too). */
export class RefreshFailed extends Data.TaggedError("RefreshFailed")<{
  readonly step: string
  readonly message: string
  readonly rolledBack: boolean
}> {}

export interface RefreshOptions {
  readonly target: SandboxAccess
  readonly daemonToken: string
  readonly template: string
  /** Recorded on the donor, to find it if it outlives the refresh. */
  readonly metadata: Readonly<Record<string, string>>
}

export class SandboxRefresh extends Context.Service<
  SandboxRefresh,
  { readonly run: (options: RefreshOptions) => Effect.Effect<RefreshResult, RefreshFailed> }
>()("@dream/api/SandboxRefresh") {
  static readonly layer = Layer.effect(
    SandboxRefresh,
    Effect.gen(function* () {
      const e2b = yield* E2B
      const envd = yield* Envd
      const daemon = yield* Daemon

      const failed =
        (step: string, rolledBack = true) =>
        (error: { readonly message: string }) =>
          new RefreshFailed({ step, message: error.message, rolledBack })

      /** Runs a command as root; a nonzero exit is a failure carrying its output's tail. */
      const root = (sandbox: SandboxAccess, command: string, timeout: Duration.Input, envs?: Record<string, string>) =>
        envd.run(sandbox, { command, user: "root", timeout, envs }).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result.output)
              : Effect.fail(
                  new UpstreamFailure({
                    service: "sandbox",
                    message: `exit ${result.exitCode}: ${result.output.trim().split("\n").slice(-5).join(" | ")}`
                  })
                )
          )
        )

      const readRelease = (sandbox: SandboxAccess) =>
        envd
          .readFile(sandbox, ReleasePath, "root")
          .pipe(
            Effect.map(Option.flatMap((text) => Schema.decodeUnknownOption(ReleaseFile)(text))),
            Effect.map(Option.map((file) => file.release))
          )

      /** Waits for dreamd to answer, and with `release`, for the dreamd that runs it. */
      const waitForDaemon = (options: RefreshOptions, release?: string) =>
        Effect.gen(function* () {
          const health = yield* daemon.health(options.target, options.daemonToken)
          if (release !== undefined && health.release !== release) {
            return yield* new UpstreamFailure({
              service: "dreamd",
              message: `still on ${health.release ?? "an older release"}`
            })
          }
        }).pipe(
          Effect.retry(Schedule.spaced("2 seconds")),
          Effect.timeoutOrElse({
            duration: NewDaemonWait,
            orElse: () => Effect.fail(new UpstreamFailure({ service: "dreamd", message: "dreamd didn't come up" }))
          })
        )

      const rollback = (options: RefreshOptions, step: string, error: { readonly message: string }) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("sandbox refresh failed; rolling back", { step, error: error.message })
          const restored = yield* root(options.target, `${refreshScript("/opt/dream")} rollback`, "2 minutes").pipe(
            Effect.andThen(waitForDaemon(options)),
            Effect.as(true),
            Effect.catch((rollbackError) =>
              Effect.logError("rolling back the sandbox refresh failed", { error: rollbackError.message }).pipe(
                Effect.as(false)
              )
            )
          )
          return yield* new RefreshFailed({ step, message: error.message, rolledBack: restored })
        })

      const run = Effect.fn("SandboxRefresh.run")(function* (options: RefreshOptions) {
        const health = yield* daemon.health(options.target, options.daemonToken).pipe(Effect.mapError(failed("health")))
        if (health.turn === "running") return RefreshResult.Busy()
        const current = yield* e2b
          .currentBuild(options.template)
          .pipe(Effect.orElseSucceed(() => Option.none<TemplateBuild>()))
        const build = Option.map(current, (current) => current.build)
        // The build's tag names its release: no donor needed to see that the sandbox already runs it.
        const tagged = Option.flatMap(current, (current) => current.release)
        if (Option.isSome(tagged) && health.release === tagged.value) {
          return RefreshResult.Current({ release: tagged.value, build })
        }
        const started = yield* Clock.currentTimeMillis

        const donor = yield* Effect.acquireRelease(
          e2b
            .create({
              template: options.template,
              timeoutSeconds: Duration.toSeconds(DonorTimeout),
              autoPause: false,
              envVars: {},
              metadata: { ...options.metadata, purpose: "refresh-donor" },
              rules: {}
            })
            .pipe(Effect.mapError(failed("donor"))),
          (donor) => e2b.kill(donor.sandboxId).pipe(Effect.ignore)
        )
        const release = yield* readRelease(donor).pipe(Effect.mapError(failed("donor")))
        if (Option.isNone(release)) return RefreshResult.Unsupported({ build })
        if (health.release === release.value) return RefreshResult.Current({ release: release.value, build })

        yield* root(donor, `tar -C / -cf ${Tarball} ${packed.join(" ")}`, "3 minutes").pipe(
          Effect.mapError(failed("pack"))
        )
        const unstage = root(
          options.target,
          `rm -rf ${packed.map((path) => `/${path}.next`).join(" ")}`,
          "1 minute"
        ).pipe(Effect.ignore)
        yield* root(options.target, stageCommand, "5 minutes", {
          DONOR_URL: `https://49983-${donor.sandboxId}.${donor.domain}/files?path=${encodeURIComponent(Tarball)}&username=root`,
          DONOR_TOKEN: donor.envdAccessToken
        }).pipe(
          // Nothing has changed yet, but don't leave the staged copy taking up disk.
          Effect.tapError(() => unstage),
          Effect.mapError(failed("stage"))
        )
        // A turn may have started while the copy downloaded (dreamd runs scheduled commands on its own).
        const again = yield* daemon.health(options.target, options.daemonToken).pipe(Effect.mapError(failed("health")))
        if (again.turn === "running") {
          yield* unstage
          return RefreshResult.Busy()
        }
        yield* root(options.target, `${refreshScript("/opt/dream.next")} activate`, "3 minutes").pipe(
          Effect.catch((error) => rollback(options, "activate", error))
        )
        yield* waitForDaemon(options, release.value).pipe(Effect.catch((error) => rollback(options, "restart", error)))
        yield* root(options.target, `${refreshScript("/opt/dream")} commit`, "2 minutes").pipe(
          Effect.catch((error) =>
            Effect.logWarning("couldn't drop the old copies after a refresh", { error: error.message })
          )
        )
        const seconds = Math.round(((yield* Clock.currentTimeMillis) - started) / 1000)
        yield* Effect.logInfo("sandbox refreshed", {
          sandboxId: options.target.sandboxId,
          from: health.release,
          to: release.value,
          build: Option.getOrUndefined(build),
          seconds
        })
        return RefreshResult.Refreshed({ release: release.value, build })
      }, Effect.scoped)

      return SandboxRefresh.of({ run })
    })
  )
}
