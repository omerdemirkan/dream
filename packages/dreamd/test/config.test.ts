import { assert, describe, it } from "@effect/vitest"
import { DaemonConfig, DaemonEnv, DefaultDaemonPort } from "@dream/domain"
import { ConfigProvider, Effect, Redacted } from "effect"

describe("DaemonConfig", () => {
  it.effect("reads the environment the ProjectDO sets", () =>
    Effect.gen(function* () {
      const provider = ConfigProvider.fromEnvRecord({
        [DaemonEnv.apiUrl]: "https://api.dream.example",
        [DaemonEnv.projectId]: "prj_liftlog",
        [DaemonEnv.projectToken]: "project-token",
        [DaemonEnv.daemonToken]: "daemon-token",
        [DaemonEnv.harness]: "codex"
      })
      const config = yield* DaemonConfig.parse(provider)
      assert.strictEqual(config.harness, "codex")
      assert.strictEqual(config.port, DefaultDaemonPort)
      assert.strictEqual(Redacted.value(config.projectToken), "project-token")
    })
  )

  it.effect("rejects an unknown harness", () =>
    Effect.gen(function* () {
      const provider = ConfigProvider.fromEnvRecord({
        [DaemonEnv.apiUrl]: "https://api.dream.example",
        [DaemonEnv.projectId]: "prj_liftlog",
        [DaemonEnv.projectToken]: "t",
        [DaemonEnv.daemonToken]: "t",
        [DaemonEnv.harness]: "gemini"
      })
      const error = yield* Effect.flip(DaemonConfig.parse(provider))
      assert.strictEqual(error._tag, "ConfigError")
    })
  )
})
