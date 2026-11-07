/**
 * Checks a move to a bigger sandbox on real E2B, end to end, against the fake model and API servers that ship in the
 * template (no account, project or subscription is touched):
 *
 *   NODE_USE_ENV_PROXY=1 node apps/api/scripts/move-check.ts [standard template] [large template]
 *                                                      (default dream-sandbox, dream-sandbox-large)
 *
 * It sets a project up in a sandbox of the standard template the way the ProjectDO does: dreamd against the fake API,
 * Claude Code against the fake Anthropic server, an app served on port 3000 and noted as published, a wake-up
 * scheduled, and one turn run. Then it moves the project to the large template with `SandboxMove`, as the ProjectDO
 * does after the turn that asked (new daemon token, dreamd started, servers restored), and checks that the new
 * sandbox has the large machine, the project's files, dreamd's state and published port, the same harness session
 * (a second turn goes on in it), and the app answering on its port URL. Both sandboxes are labeled as dev sandboxes
 * and killed at the end. Needs E2B_API_KEY, or an HTTPS proxy that adds it.
 */
import { DaemonEnvFile, DefaultDaemonPort, devSandboxMetadata } from "@dream/domain"
import { Cause, Duration, Effect, Exit, Layer, Option, Redacted, Schedule } from "effect"
import { FetchHttpClient } from "effect/http"
import { ApiConfig } from "../src/Config.ts"
import { Daemon } from "../src/e2b/Daemon.ts"
import { E2B, type SandboxAccess } from "../src/e2b/E2B.ts"
import { Envd } from "../src/e2b/Envd.ts"
import { SandboxMove } from "../src/e2b/Move.ts"
import { randomToken } from "../src/lib/Ids.ts"

const [standard = "dream-sandbox", large = "dream-sandbox-large"] = process.argv.slice(2)
const scripts = "/opt/dream/packages/dreamd/scripts"
const log = "/home/user/.dream/logs/dreamd.log"
const metadata = devSandboxMetadata("move-check")

const config = ApiConfig.layerTest({
  e2bApiKey: Option.some(Redacted.make(process.env.E2B_API_KEY ?? "placeholder-added-by-proxy")),
  e2bApiUrl: "https://api.e2b.app",
  e2bDomain: "e2b.app",
  sandboxTemplate: standard,
  sandboxTemplateLarge: Option.some(large)
})

const app = `let hits = 0
const started = new Date().toISOString()
Bun.serve({ port: 3000, fetch: () => new Response(JSON.stringify({ hits: ++hits, started })) })
`

const results: Array<{ check: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`)
}

const program = Effect.gen(function* () {
  const e2b = yield* E2B
  const envd = yield* Envd
  const daemon = yield* Daemon
  const mover = yield* SandboxMove
  const sh = (sandbox: SandboxAccess, command: string, timeout: Duration.Input = "2 minutes") =>
    Effect.map(envd.run(sandbox, { command, timeout }), (result) => result.output.trim())
  const envFile = (daemonToken: string) =>
    [
      "DREAM_API_URL=http://127.0.0.1:8787",
      "DREAM_PROJECT_ID=prj_dev",
      "DREAM_PROJECT_TOKEN=dev-project-token",
      `DREAM_DAEMON_TOKEN=${daemonToken}`,
      "DREAM_HARNESS=claude-code",
      ""
    ].join("\n")
  const waitForDaemon = (sandbox: SandboxAccess, daemonToken: string) =>
    daemon.health(sandbox, daemonToken).pipe(Effect.retry(Schedule.spaced("2 seconds")), Effect.timeout("90 seconds"))
  /** Delivers a message to dreamd from inside the sandbox and waits for the turn it starts to end. */
  const turn = (sandbox: SandboxAccess, daemonToken: string, text: string) =>
    Effect.gen(function* () {
      const before = Number(yield* sh(sandbox, `grep -c "Turn finished" ${log} || true`))
      yield* sh(
        sandbox,
        `node --disable-warning=ExperimentalWarning ${scripts}/deliver.ts http://127.0.0.1:${DefaultDaemonPort} ${daemonToken} message '${text}'`
      )
      return yield* sh(
        sandbox,
        `for i in $(seq 1 120); do [ "$(grep -c "Turn finished" ${log})" -gt ${before} ] && echo finished && exit 0; sleep 2; done; tail -5 ${log}`,
        "5 minutes"
      )
    })
  const appAnswer = (sandbox: SandboxAccess) =>
    Effect.promise(() =>
      fetch(`https://3000-${sandbox.sandboxId}.${sandbox.domain}/`, {
        headers: { "e2b-traffic-access-token": sandbox.trafficAccessToken }
      }).then(async (response) => `${response.status} ${await response.text()}`)
    )
  const shape = (sandbox: SandboxAccess) => sh(sandbox, "echo $(nproc) vCPU, $(free -g | awk '/Mem:/ {print $2+1}') GB")
  const sessionFiles = (sandbox: SandboxAccess) =>
    sh(
      sandbox,
      "cat ~/.dream/state/session.json 2>/dev/null; echo; wc -l ~/.claude/projects/*/*.jsonl 2>/dev/null | tail -1"
    )

  // A project on the standard size, with a turn behind it, an app, a published port and a wake-up.
  const old = yield* Effect.acquireRelease(
    e2b.create({ template: standard, timeoutSeconds: 30 * 60, autoPause: true, envVars: {}, metadata, rules: {} }),
    (sandbox) => e2b.kill(sandbox.sandboxId).pipe(Effect.ignore)
  )
  console.log(`old sandbox ${old.sandboxId} (${standard}): ${yield* shape(old)}`)
  const oldToken = randomToken(40)
  yield* envd.writeFile(
    old,
    "/home/user/.claude/settings.json",
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18789" } })
  )
  yield* envd.writeFile(old, "/home/user/project/app.ts", app)
  yield* envd.writeFile(old, "/home/user/.dream/state/published.json", JSON.stringify({ port: 3000 }))
  yield* sh(old, "mkdir -p /tmp/fakes")
  // Started the way the agent's servers are: detached, outside dreamd's tree, output to files.
  for (const command of [
    `node ${scripts}/fake-api.ts 8787 > /tmp/fakes/api.log 2>&1`,
    `node ${scripts}/fake-anthropic.ts 18789 > /tmp/fakes/anthropic.log 2>&1`,
    "cd /home/user/project && exec bun app.ts > /home/user/project/app.log 2>&1"
  ]) {
    yield* envd.startBackground(old, { command })
  }
  yield* sh(old, "sleep 3")
  yield* envd.writeFile(old, DaemonEnvFile, envFile(oldToken))
  yield* waitForDaemon(old, oldToken)
  check("first turn on the standard machine", (yield* turn(old, oldToken, "Say hello.")) === "finished")
  const wake = yield* sh(old, `. /opt/dream/sandbox/env.sh; dream wake --at 30m "look at the app again"`)
  check("a wake-up scheduled", wake.includes("Scheduled"), wake.split("\n")[0])
  check(
    "dream machine says standard",
    (yield* sh(old, ". /opt/dream/sandbox/env.sh; dream machine")).includes("standard")
  )
  const before = { session: yield* sessionFiles(old), app: yield* appAnswer(old) }
  console.log(`before the move: app ${before.app}`)

  // The move, as the ProjectDO does it after the turn that asked.
  const started = Date.now()
  const target = yield* Effect.acquireRelease(
    mover.copy({ from: old, template: large, timeoutSeconds: 30 * 60, metadata, rules: {} }),
    (sandbox) => e2b.kill(sandbox.sandboxId).pipe(Effect.ignore)
  )
  const copied = Date.now()
  const newToken = randomToken(40)
  yield* envd.writeFile(target, DaemonEnvFile, envFile(newToken))
  yield* waitForDaemon(target, newToken)
  const restored = yield* mover.restore(target)
  const done = Date.now()
  console.log(
    `moved to ${target.sandboxId} (${large}): copy ${Math.round((copied - started) / 1000)} s, dreamd and servers ${Math.round((done - copied) / 1000)} s`
  )
  console.log(
    `restarted: ${JSON.stringify(restored.restarted)}\nnot restarted: ${JSON.stringify(restored.notRestarted)}`
  )
  yield* e2b.kill(old.sandboxId).pipe(Effect.ignore)

  check("the large machine", (yield* shape(target)).startsWith("4 vCPU"), yield* shape(target))
  check("swap is on", (yield* sh(target, "grep -c '^/swapfile ' /proc/swaps || true")) === "1")
  check("the project's files came over", (yield* sh(target, "cat ~/project/app.ts")).includes("Bun.serve"))
  check(
    "dreamd's published port came over",
    (yield* sh(target, "cat ~/.dream/state/published.json")).includes('"port":3000')
  )
  check(
    "the app was restarted",
    restored.restarted.some((command) => command.includes("bun app.ts"))
  )
  const after = yield* appAnswer(target)
  check("the app answers on its port URL", after.startsWith("200 "), after)
  check("dream machine says large", (yield* sh(target, ". /opt/dream/sandbox/env.sh; dream machine")).includes("large"))
  const second = yield* turn(target, newToken, "Say hello again.")
  check("a second turn runs in the new sandbox", second === "finished", second === "finished" ? "" : second)
  const afterSession = yield* sessionFiles(target)
  const sessionId = (text: string) => /"sessionId":\s*"([^"]+)"/.exec(text)?.[1]
  const lines = (text: string) =>
    Number(
      /(\d+) total|(\d+) \//
        .exec(text.split("\n").at(-1) ?? "")
        ?.slice(1)
        .find(Boolean) ?? 0
    )
  check(
    "the harness session went on",
    sessionId(before.session) !== undefined && sessionId(before.session) === sessionId(afterSession),
    `session ${sessionId(before.session)} → ${sessionId(afterSession)}`
  )
  check(
    "the conversation grew in the same transcript",
    lines(afterSession) > lines(before.session),
    `${lines(before.session)} → ${lines(afterSession)} lines`
  )
}).pipe(Effect.scoped)

const exit = await Effect.runPromiseExit(
  program.pipe(
    Effect.provide(
      SandboxMove.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(E2B.layer, Envd.layer, Daemon.layer)),
        Layer.provide(Layer.merge(FetchHttpClient.layer, config))
      )
    )
  )
)
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause))
  process.exitCode = 1
} else if (results.some((result) => !result.ok)) process.exitCode = 1
console.log(process.exitCode === 1 ? "FAILED" : "PASSED")
