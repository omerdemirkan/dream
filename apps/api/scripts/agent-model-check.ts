/**
 * Checks a project's choice of agent model and effort on real E2B, on both harnesses, against the fake model and API
 * servers that ship in the template (no account, project or subscription is touched):
 *
 *   NODE_USE_ENV_PROXY=1 node apps/api/scripts/agent-model-check.ts [template]   (default dream-sandbox)
 *
 * For each harness, in a sandbox of its own, it writes dreamd's env file from the ProjectDO's own `daemonSettings`
 * for a project created with a model and effort other than Dream's default, runs its first turn, and checks that the
 * requests that reached the fake model carried them. Then it changes the choice as `SetAgentModel` does (the env
 * file written again between turns, which restarts dreamd), runs a second turn, and checks it ran on the new model
 * and effort in the same harness session. The sandboxes are dev sandboxes, killed at the end. Needs E2B_API_KEY, or
 * an HTTPS proxy that adds it.
 */
import {
  agentChoice,
  DaemonEnvFile,
  DefaultDaemonPort,
  devSandboxMetadata,
  type Harness,
  type ProjectId,
  type ReasoningEffort
} from "@dream/domain"
import { Cause, Duration, Effect, Exit, Layer, Option, Redacted, Schedule } from "effect"
import { FetchHttpClient } from "effect/http"
import { ApiConfig } from "../src/Config.ts"
import { Daemon } from "../src/e2b/Daemon.ts"
import { E2B, type SandboxAccess } from "../src/e2b/E2B.ts"
import { Envd } from "../src/e2b/Envd.ts"
import { randomToken } from "../src/lib/Ids.ts"
import { daemonSettings } from "../src/project/SandboxManager.ts"

const [template = "dream-sandbox"] = process.argv.slice(2)
const scripts = "/opt/dream/packages/dreamd/scripts"
const log = "/home/user/.dream/logs/dreamd.log"
const metadata = devSandboxMetadata("agent-model-check")

interface Choice {
  readonly model: string
  readonly effort: ReasoningEffort
}

/** Two choices per harness, neither Dream's default, and neither at medium (Claude Code's side requests use it). */
const plans: ReadonlyArray<{ readonly harness: Harness; readonly first: Choice; readonly then: Choice }> = [
  { harness: "claude-code", first: { model: "sonnet", effort: "xhigh" }, then: { model: "fable", effort: "low" } },
  { harness: "codex", first: { model: "gpt-6-luna", effort: "low" }, then: { model: "gpt-6-astra", effort: "max" } }
]

const config = ApiConfig.layerTest({
  e2bApiKey: Option.some(Redacted.make(process.env.E2B_API_KEY ?? "placeholder-added-by-proxy")),
  e2bApiUrl: "https://api.e2b.app",
  e2bDomain: "e2b.app",
  sandboxTemplate: template
})

const results: Array<{ check: string; ok: boolean }> = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ check: name, ok })
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`)
}

interface FakeRequest {
  readonly model?: string
  readonly effort?: string
  readonly did?: string
}

/** Claude Code sends the alias's model id (`sonnet` → claude-sonnet-5-5); Codex the slug itself. */
const onModel = (harness: Harness, model: string) => (request: FakeRequest) =>
  harness === "claude-code" ? request.model?.includes(`-${model}-`) === true : request.model === model

const runHarness = (plan: (typeof plans)[number]) =>
  Effect.gen(function* () {
    const e2b = yield* E2B
    const envd = yield* Envd
    const daemon = yield* Daemon
    const { harness } = plan
    const sh = (sandbox: SandboxAccess, command: string, timeout: Duration.Input = "2 minutes") =>
      Effect.map(envd.run(sandbox, { command, timeout }), (result) => result.output.trim())
    const sandbox = yield* Effect.acquireRelease(
      e2b.create({ template, timeoutSeconds: 30 * 60, autoPause: false, envVars: {}, metadata, rules: {} }),
      (s) => e2b.kill(s.sandboxId).pipe(Effect.ignore)
    )
    console.log(`${harness}: sandbox ${sandbox.sandboxId} (${template})`)
    const daemonToken = randomToken(40)
    const fake = harness === "claude-code" ? "/tmp/fakes/anthropic.log" : "/tmp/fakes/responses.log"
    if (harness === "claude-code") {
      yield* envd.writeFile(
        sandbox,
        "/home/user/.claude/settings.json",
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18789" } })
      )
    }
    yield* sh(sandbox, "mkdir -p /tmp/fakes")
    for (const command of [
      `node ${scripts}/fake-api.ts 8787 > /tmp/fakes/api.log 2>&1`,
      `node ${scripts}/fake-anthropic.ts 18789 > /tmp/fakes/anthropic.log 2>&1`,
      `node ${scripts}/fake-responses.ts 18788 > /tmp/fakes/responses.log 2>&1`
    ]) {
      yield* envd.startBackground(sandbox, { command })
    }
    yield* sh(sandbox, "sleep 3")

    /** dreamd's env file as the ProjectDO writes it for a project with `choice`, then waits for that dreamd. */
    const writeEnv = (choice: Choice) =>
      Effect.gen(function* () {
        const settings = daemonSettings({
          apiUrl: "http://127.0.0.1:8787",
          projectId: "prj_dev" as ProjectId,
          harness,
          daemonToken,
          agentModel: Option.none(),
          codexAgentModel: Option.none(),
          agentEffort: Option.none(),
          chosen: agentChoice(harness, choice)
        })
        const started = Number(yield* sh(sandbox, `grep -c "dreamd started" ${log} 2>/dev/null || true`))
        const lines = Object.entries({
          ...settings,
          DREAM_PROJECT_TOKEN: "dev-project-token",
          DREAM_CODEX_BASE_URL: "http://127.0.0.1:18788/backend-api/codex"
        }).map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        yield* envd.writeFile(sandbox, DaemonEnvFile, `${lines.join("\n")}\n`)
        yield* sh(
          sandbox,
          `for i in $(seq 1 60); do [ "$(grep -c "dreamd started" ${log} 2>/dev/null || echo 0)" -gt ${started} ] && exit 0; sleep 1; done`
        )
        yield* daemon
          .health(sandbox, daemonToken)
          .pipe(Effect.retry(Schedule.spaced("2 seconds")), Effect.timeout("90 seconds"))
        return settings
      })

    /** Delivers a message, waits for its turn to end, and returns the requests the fake model saw meanwhile. */
    const turn = (text: string) =>
      Effect.gen(function* () {
        const lines = Number(yield* sh(sandbox, `wc -l < ${log}`))
        const fakeLines = Number(yield* sh(sandbox, `wc -l < ${fake}`))
        yield* sh(
          sandbox,
          `node --disable-warning=ExperimentalWarning ${scripts}/deliver.ts http://127.0.0.1:${DefaultDaemonPort} ${daemonToken} message '${text}'`
        )
        const ended = yield* sh(
          sandbox,
          `for i in $(seq 1 150); do tail -n +${lines + 1} ${log} | grep -qE "Turn finished|The turn failed" && break; sleep 2; done; tail -n +${lines + 1} ${log} | grep -E "Turn finished|turn failed|runs on|resume" | cut -c1-200 | head -6`,
          "6 minutes"
        )
        const requests = (yield* sh(sandbox, `tail -n +${fakeLines + 1} ${fake}`)).split("\n").flatMap((line) => {
          try {
            const request = JSON.parse(line) as FakeRequest
            return request.model === undefined || request.did?.startsWith("progress-line") ? [] : [request]
          } catch {
            return []
          }
        })
        return { ended, requests }
      })
    /** The conversation dreamd resumes: the harness's own ids in the saved session (Claude Code's session, Codex's thread). */
    const sessionId = Effect.map(sh(sandbox, "cat ~/.dream/state/session.json 2>/dev/null"), (text) => {
      const ids = [...new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])]
      return ids.length === 0 ? undefined : ids.sort().join(",")
    })
    const verify = (name: string, choice: Choice, ran: { ended: string; requests: ReadonlyArray<FakeRequest> }) => {
      const asked = ran.requests.map((r) => `${r.model}/${r.effort ?? "-"}`)
      check(`${harness}: ${name} finished`, ran.ended.includes("Turn finished"), ran.ended.split("\n")[0])
      check(
        `${harness}: ${name} ran on ${choice.model} at ${choice.effort}`,
        ran.requests.length > 0 &&
          ran.requests.every(onModel(harness, choice.model)) &&
          ran.requests.some((r) => r.effort === choice.effort) &&
          // Claude Code's side requests (no tools) go at medium whatever the turn's effort.
          ran.requests.every((r) => r.effort === choice.effort || (harness === "claude-code" && r.effort === "medium")),
        asked.join(", ")
      )
    }

    const firstEnv = yield* writeEnv(plan.first)
    check(
      `${harness}: dreamd's env carries the project's choice`,
      firstEnv.DREAM_MODEL === plan.first.model && firstEnv.DREAM_EFFORT === plan.first.effort
    )
    verify("first turn", plan.first, yield* turn("Say hello."))
    const before = yield* sessionId

    yield* writeEnv(plan.then)
    const runsOn = yield* sh(sandbox, `grep "The agent runs on" ${log} | tail -1 | cut -c1-200`)
    check(
      `${harness}: dreamd restarted on the new choice`,
      runsOn.includes(`model ${plan.then.model}, effort ${plan.then.effort}`),
      runsOn
    )
    const second = yield* turn("Say hello again.")
    verify("second turn", plan.then, second)
    const after = yield* sessionId
    const resumeFailed = yield* sh(sandbox, `grep -c "Couldn't resume" ${log} || true`)
    check(
      `${harness}: the second turn went on in the same session`,
      before !== undefined && before === after && resumeFailed === "0",
      `${before} → ${after}`
    )
  }).pipe(Effect.scoped)

const program = Effect.forEach(plans, runHarness, { concurrency: "unbounded", discard: true })

const exit = await Effect.runPromiseExit(
  program.pipe(
    Effect.provide(
      Layer.mergeAll(E2B.layer, Envd.layer, Daemon.layer).pipe(
        Layer.provide(Layer.merge(FetchHttpClient.layer, config))
      )
    )
  )
)
if (Exit.isFailure(exit)) {
  console.error(Cause.pretty(exit.cause))
  process.exitCode = 1
}
const failed = results.filter((r) => !r.ok)
console.log(
  failed.length === 0
    ? `\nall ${results.length} checks passed`
    : `\n${failed.length} of ${results.length} checks failed`
)
if (failed.length > 0) process.exitCode = 1
