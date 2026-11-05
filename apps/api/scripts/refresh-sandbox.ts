/**
 * Refresh one sandbox by hand, exactly as the ProjectDO does between turns (`SandboxRefresh`):
 *
 *   node apps/api/scripts/refresh-sandbox.ts <sandbox-id> <daemon-token> [template]     (default dream-sandbox)
 *
 * The daemon token is the sandbox's DREAM_DAEMON_TOKEN (in /home/user/.dream/dreamd.env). Needs E2B_API_KEY, or an
 * HTTPS proxy that adds it (with NODE_USE_ENV_PROXY=1). It prints what happened, never a token. It doesn't know
 * about turns the ProjectDO is tracking, so only run it on a sandbox nobody is using, or one dreamd says is idle.
 */
import { Cause, Effect, Exit, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { ApiConfig } from "../src/Config.ts"
import { Daemon } from "../src/e2b/Daemon.ts"
import { E2B } from "../src/e2b/E2B.ts"
import { Envd } from "../src/e2b/Envd.ts"
import { SandboxRefresh } from "../src/e2b/Refresh.ts"

const [sandboxId, daemonToken, template = "dream-sandbox"] = process.argv.slice(2)
if (sandboxId === undefined || daemonToken === undefined) {
  console.error("usage: refresh-sandbox.ts <sandbox-id> <daemon-token> [template]")
  process.exit(2)
}

// Only the E2B settings matter here; the rest are the test defaults.
const config = ApiConfig.layerTest({
  e2bApiKey: Option.some(Redacted.make(process.env.E2B_API_KEY ?? "placeholder-added-by-proxy")),
  e2bApiUrl: "https://api.e2b.app",
  e2bDomain: "e2b.app",
  sandboxTemplate: template
})

const program = Effect.gen(function* () {
  const e2b = yield* E2B
  const refresh = yield* SandboxRefresh
  const target = yield* e2b.connect(sandboxId, 10 * 60)
  const started = Date.now()
  const result = yield* refresh.run({ target, daemonToken, template, metadata: { purpose: "manual-refresh" } })
  yield* Effect.logInfo(`${result._tag} in ${Math.round((Date.now() - started) / 1000)} s`, result)
})

const exit = await Effect.runPromiseExit(
  program.pipe(
    Effect.provide(
      SandboxRefresh.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(E2B.layer, Envd.layer, Daemon.layer)),
        Layer.provide(Layer.merge(FetchHttpClient.layer, config))
      )
    )
  )
)
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause))
  process.exitCode = 1
}
