/**
 * dreamd's configuration. The ProjectDO writes `DaemonConfig` to
 * `DaemonEnvFile`; dreamd waits for that file, reads it over its own
 * environment, and exits when it changes so its supervisor restarts it with
 * the new values. Where dreamd keeps its state, and where the agent works,
 * are properties of the sandbox template and come from the environment.
 */
import { DaemonConfig, DaemonEnv, DaemonEnvFile, ReasoningEffort } from "@dream/domain"
import { Config, ConfigProvider, Context, Duration, Effect, FileSystem, Layer, Option, Schedule } from "effect"

export interface DreamdConfigShape extends Config.Success<typeof DaemonConfig> {
  /** dreamd's own files: the inbox, the harness session, logs. */
  readonly stateDir: string
  /** Where the agent works and keeps the project's code. */
  readonly workDir: string
  readonly home: string
  /** The env file this config was read from, watched for changes. */
  readonly envFile: string
  /** The top-level agent's model, when not the fleet's: the operator's override or the project's choice (see `harness/Fleet.ts`). */
  readonly model: Option.Option<string>
  /** The top-level agent's reasoning effort, when not the fleet's. */
  readonly effort: Option.Option<ReasoningEffort>
  /** What the ProjectDO called the env file's settings; `Health` reports it. */
  readonly envHash: Option.Option<string>
  /** For testing: where Codex sends model requests instead of the ChatGPT backend. */
  readonly codexBaseUrl: Option.Option<string>
  /** Dream's AI gateway for the agent's apps, while it's on (`DaemonEnv.openaiBaseUrl`; see `harness/HarnessEnv.ts`). */
  readonly openaiBaseUrl: Option.Option<string>
  /** The key relay deliveries are signed with (`RelayKeyPath` in a sandbox); dreamd makes it if it's missing. */
  readonly relayKeyPath: string
  /** Whether dreamd reports what turns are doing (`DaemonEnv.progressLine`; see `progress/Progress.ts`). */
  readonly progressLine: boolean
  /** Whether a small model writes the line ("on"), or only the model-free one does ("model-free"). */
  readonly progressModel: boolean
  /** For checks: shorter limits on background work holding a turn (see `harness/Background.ts`). */
  readonly backgroundQuiet: Option.Option<Duration.Duration>
  readonly backgroundLong: Option.Option<Duration.Duration>
}

const LocalConfig = Config.all({
  home: Config.NonEmptyString("HOME"),
  stateDir: Config.option(Config.NonEmptyString("DREAM_STATE_DIR")),
  workDir: Config.option(Config.NonEmptyString("DREAM_WORKDIR")),
  model: Config.option(Config.NonEmptyString(DaemonEnv.model)),
  effort: Config.option(Config.schema(ReasoningEffort, DaemonEnv.effort)),
  envHash: Config.option(Config.NonEmptyString(DaemonEnv.envHash)),
  codexBaseUrl: Config.option(Config.NonEmptyString("DREAM_CODEX_BASE_URL")),
  openaiBaseUrl: Config.option(Config.NonEmptyString(DaemonEnv.openaiBaseUrl)),
  progressLine: Config.String(DaemonEnv.progressLine).pipe(Config.withDefault("off")),
  backgroundQuiet: Config.option(Config.Duration("DREAM_BACKGROUND_QUIET")),
  backgroundLong: Config.option(Config.Duration("DREAM_BACKGROUND_LONG"))
})

export class DreamdConfig extends Context.Service<DreamdConfig, DreamdConfigShape>()("@dream/dreamd/DreamdConfig") {
  /** Reads `DREAM_ENV_FILE` (default `DaemonEnvFile`), waiting for it to exist, over the process environment. */
  static readonly layer = Layer.effect(
    DreamdConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const envFile = yield* Config.NonEmptyString("DREAM_ENV_FILE").pipe(Config.withDefault(DaemonEnvFile))
      if (!(yield* fs.exists(envFile))) {
        yield* Effect.logInfo(`Waiting for ${envFile}`)
        yield* fs
          .exists(envFile)
          .pipe(Effect.repeat({ schedule: Schedule.spaced(Duration.seconds(1)), until: (exists) => exists }))
      }
      const fromFile = yield* ConfigProvider.fromDotEnv({ path: envFile })
      const provider = ConfigProvider.orElse(fromFile, ConfigProvider.fromEnv())
      return yield* load(provider, envFile)
    })
  )

  /** For tests: everything from one record, as if read from `envFile`. */
  static readonly layerFromRecord = (env: Record<string, string>, envFile = "(test)") =>
    Layer.effect(DreamdConfig, load(ConfigProvider.fromEnvRecord(env), envFile))
}

const load = (provider: ConfigProvider.ConfigProvider, envFile: string) =>
  Effect.gen(function* () {
    const daemon = yield* DaemonConfig.parse(provider)
    const local = yield* LocalConfig.parse(provider)
    return DreamdConfig.of({
      ...daemon,
      home: local.home,
      stateDir: Option.getOrElse(local.stateDir, () => `${local.home}/.dream/state`),
      workDir: Option.getOrElse(local.workDir, () => `${local.home}/project`),
      envFile,
      model: local.model,
      effort: local.effort,
      envHash: local.envHash,
      codexBaseUrl: local.codexBaseUrl,
      openaiBaseUrl: local.openaiBaseUrl,
      relayKeyPath: `${local.home}/.dream/relay.key`,
      progressLine: ["on", "model-free"].includes(local.progressLine.trim().toLowerCase()),
      progressModel: local.progressLine.trim().toLowerCase() === "on",
      backgroundQuiet: local.backgroundQuiet,
      backgroundLong: local.backgroundLong
    })
  })
