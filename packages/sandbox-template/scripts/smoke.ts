/**
 * Smoke-test the built template: `bun run --filter @dream/sandbox-template smoke [env-file]`.
 *
 * Creates a sandbox from `dream-sandbox` and checks that the supervisor and
 * dreamd are running and the tools and both harness CLIs are installed. Given
 * an env file, it writes it where the ProjectDO would, waits for dreamd to
 * start, and prints dreamd's URL; the sandbox stays up for 15 minutes so
 * events can be delivered with `packages/dreamd/scripts/deliver.ts`.
 * Without one, it kills the sandbox when the checks are done.
 */
import { readFileSync } from "node:fs"
import { NodeRuntime } from "@effect/platform-node"
import { DaemonEnvFile, DefaultDaemonPort } from "@dream/domain"
import { Sandbox } from "e2b"
import { Effect } from "effect"
import { templateName } from "../src/index.ts"

const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}

const log = "/home/user/.dream/logs/dreamd.log"

const checks = [
  ["supervisor", "kill -0 $(cat /tmp/dream-supervisor.pid) && echo running"],
  ["dreamd", "pgrep -f src/bin/dreamd.ts > /dev/null && echo running"],
  ["dreamd log", `tail -3 ${log}`],
  ["tools", "node --version; pnpm --version; bun --version; git --version; python3 --version; rg --version | head -1"],
  ["playwright", "ls /opt/playwright"],
  [
    "harnesses",
    "cd ~/.ai-sdk-harness/.harness-bootstrap && claude-code/node_modules/.bin/claude --version && codex/node_modules/.bin/codex --version && ls -a claude-code codex | grep bootstrap-"
  ],
  ["dream", "dream --help | head -3"],
  ["disk", "df -h / | tail -1"],
  ["memory", "free -m | head -2"]
] as const

const smoke = Effect.gen(function* () {
  const envFile = process.argv[2]
  const started = Date.now()
  const sandbox = yield* Effect.tryPromise(() =>
    Sandbox.create(templateName, { ...connection, timeoutMs: 15 * 60_000 })
  )
  yield* Effect.logInfo(`Created sandbox ${sandbox.sandboxId} in ${Date.now() - started} ms`)
  const run = (command: string) =>
    Effect.tryPromise(() => sandbox.commands.run(command, { timeoutMs: 60_000 })).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.catch((error) => Effect.succeed(`FAILED: ${String(error.cause)}`))
    )
  let failed = false
  for (const [name, command] of checks) {
    const output = yield* run(command)
    if (output.startsWith("FAILED")) failed = true
    console.log(`--- ${name}\n${output}`)
  }
  if (envFile === undefined) {
    yield* Effect.tryPromise(() => sandbox.kill())
    if (failed) return yield* Effect.die(new Error("A check failed"))
    return
  }
  yield* Effect.tryPromise(() => sandbox.files.write(DaemonEnvFile, readFileSync(envFile, "utf8")))
  const up = yield* run(
    `for i in $(seq 1 60); do grep -q "dreamd started" ${log} && echo up && exit 0; sleep 1; done; tail -20 ${log}`
  )
  console.log(`--- dreamd after the env file\n${up}`)
  yield* Effect.logInfo(
    `dreamd for sandbox ${sandbox.sandboxId} is at https://${sandbox.getHost(DefaultDaemonPort)} for 15 minutes`
  )
})

smoke.pipe(NodeRuntime.runMain)
