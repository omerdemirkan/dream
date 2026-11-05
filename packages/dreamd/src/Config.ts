/**
 * dreamd's configuration. The ProjectDO writes `DaemonConfig` to
 * `DaemonEnvFile`; dreamd waits for that file, reads it over its own
 * environment, and exits when it changes so its supervisor restarts it with
 * the new values. Where dreamd keeps its state, and where the agent works,
 * are properties of the sandbox template and come from the environment.
 */
import { DaemonConfig, DaemonEnv, DaemonEnvFile } from "@dream/domain"
import { Config, ConfigProvider, Context, Duration, Effect, FileSystem, Layer, Option, Schedule } from "effect"

export interface DreamdConfigShape extends Config.Success<typeof DaemonConfig> {
  /** dreamd's own files: the inbox, the harness session, logs. */
  readonly stateDir: string
  /** Where the agent works and keeps the project's code. */
  readonly workDir: string
  readonly home: string
  /** The env file this config was read from, watched for changes. */
  readonly envFile: string
  /** A model to ask the harness for instead of its default. */
  readonly model: Option.Option<string>
  /** For testing: where Codex sends model requests instead of the ChatGPT backend. */
  readonly codexBaseUrl: Option.Option<string>
}

const LocalConfig = Config.all({
  home: Config.NonEmptyString("HOME"),
  stateDir: Config.option(Config.NonEmptyString("DREAM_STATE_DIR")),
  workDir: Config.option(Config.NonEmptyString("DREAM_WORKDIR")),
  model: Config.option(Config.NonEmptyString(DaemonEnv.model)),
  codexBaseUrl: Config.option(Config.NonEmptyString("DREAM_CODEX_BASE_URL"))
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

  /** For tests: everything from one record. */
  static readonly layerFromRecord = (env: Record<string, string>) =>
    Layer.effect(DreamdConfig, load(ConfigProvider.fromEnvRecord(env), "(test)"))
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
      codexBaseUrl: local.codexBaseUrl
    })
  })
