import { assert, describe, it } from "@effect/vitest"
import { DaemonConfig, DaemonEnv, DefaultDaemonPort } from "@dream/domain"
import { ConfigProvider, Effect, Redacted } from "effect"
import { DreamdConfig } from "../src/Config.ts"
import { topLevel } from "../src/harness/Fleet.ts"

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

describe("the top-level agent", () => {
  const env = {
    HOME: "/home/user",
    [DaemonEnv.apiUrl]: "https://api.dream.example",
    [DaemonEnv.projectId]: "prj_liftlog",
    [DaemonEnv.projectToken]: "t",
    [DaemonEnv.daemonToken]: "t",
    [DaemonEnv.harness]: "claude-code"
  }
  const read = (extra: Record<string, string>) =>
    Effect.provide(
      Effect.gen(function* () {
        return yield* DreamdConfig
      }),
      DreamdConfig.layerFromRecord({ ...env, ...extra })
    )

  it.effect("is each provider's flagship at high effort", () =>
    Effect.gen(function* () {
      const config = yield* read({})
      assert.deepStrictEqual(topLevel("claude-code", config), { model: "opus", effort: "high" })
      assert.deepStrictEqual(topLevel("codex", config), { model: "gpt-6.1-sol", effort: "high" })
    })
  )

  it.effect("takes the operator's model and effort overrides", () =>
    Effect.gen(function* () {
      const config = yield* read({ [DaemonEnv.model]: "haiku", [DaemonEnv.effort]: "low" })
      assert.deepStrictEqual(topLevel("claude-code", config), { model: "haiku", effort: "low" })
    })
  )

  it.effect("rejects an effort neither harness takes", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(read({ [DaemonEnv.effort]: "ultra" }))
      assert.strictEqual(error._tag, "ConfigError")
    })
  )
})
