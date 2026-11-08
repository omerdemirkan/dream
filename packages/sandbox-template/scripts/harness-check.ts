/**
 * Runs one turn on each harness in a sandbox of a template build, against fakes for the Worker and both models
 * (packages/dreamd/scripts/fake-api.ts, fake-anthropic.ts and fake-responses.ts, as shipped in the build), so a
 * Claude Code or Codex release that breaks its adapter is caught before any project gets it. The turn also checks
 * the fleet: the top-level agent asks for the model and effort dreamd says it runs on, and starts a subagent on a
 * model and effort of its choosing (Claude Code's `Agent` tool, Codex's `spawn_agent`), which the subagent's own
 * requests carry, and that the harness installed every one of Dream's skills where it reads them. `build.ts` runs it on every build before tagging the build `default`; on its own:
 *
 *   node scripts/harness-check.ts [template[:tag]]     (default: the current dream-sandbox build)
 */
import { skillNames } from "@dream/agent-context"
import { DaemonEnvFile, DefaultDaemonPort, devSandboxMetadata } from "@dream/domain"
import { Sandbox } from "e2b"
import { templateName } from "../src/index.ts"

const scripts = "/opt/dream/packages/dreamd/scripts"
const log = "/home/user/.dream/logs/dreamd.log"
const daemonToken = "harness-check-daemon-token"

export interface HarnessResult {
  readonly harness: "claude-code" | "codex"
  readonly ok: boolean
  /** What went wrong, or the turn's log lines. */
  readonly detail: string
}

type Run = { stdout: string; stderr: string; exitCode: number }

/** Runs a command; a nonzero exit is a result. A dropped connection to envd is retried once (it happens). */
const sh = async (sandbox: Sandbox, command: string, timeoutMs = 120_000, retry = true) => {
  const result: Run | undefined = await sandbox.commands
    .run(command, { timeoutMs })
    .catch((error: { result?: Run; name?: string }) => {
      if (error.result !== undefined) return error.result
      if (retry && error.name === "SandboxUnreachableError") return undefined
      throw error
    })
  if (result === undefined) return sh(sandbox, command, timeoutMs, false)
  return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}`.trim() }
}

const background = (command: string, out: string) => `setsid nohup ${command} > ${out} 2>&1 < /dev/null &`

/** One turn on `harness`: restart dreamd on it, deliver a message, and wait for the turn to finish or fail. */
const turn = async (sandbox: Sandbox, harness: HarnessResult["harness"]): Promise<HarnessResult> => {
  const started = Number((await sh(sandbox, `grep -c "dreamd started" ${log} || true`)).output)
  await sandbox.files.write(
    DaemonEnvFile,
    [
      "DREAM_API_URL=http://127.0.0.1:8787",
      "DREAM_PROJECT_ID=prj_dev",
      "DREAM_PROJECT_TOKEN=dev-project-token",
      `DREAM_DAEMON_TOKEN=${daemonToken}`,
      `DREAM_HARNESS=${harness}`,
      "DREAM_CODEX_BASE_URL=http://127.0.0.1:18788/backend-api/codex",
      ""
    ].join("\n")
  )
  const up = await sh(
    sandbox,
    `for i in $(seq 1 60); do [ "$(grep -c "dreamd started" ${log})" -gt ${started} ] && exit 0; sleep 1; done; exit 1`
  )
  if (up.exitCode !== 0) return { harness, ok: false, detail: "dreamd didn't start" }
  const lines = Number((await sh(sandbox, `wc -l < ${log}`)).output)
  const fake = harness === "claude-code" ? "/tmp/fakes/anthropic.log" : "/tmp/fakes/responses.log"
  const fakeLines = Number((await sh(sandbox, `wc -l < ${fake}`)).output)
  const deliver = `node --disable-warning=ExperimentalWarning ${scripts}/deliver.ts http://127.0.0.1:${DefaultDaemonPort} ${daemonToken}`
  const sent = await sh(sandbox, `${deliver} message ${shellQuote(checkMessage)}`)
  if (sent.exitCode !== 0) return { harness, ok: false, detail: `delivery failed: ${sent.output}` }
  const ended = await sh(
    sandbox,
    `for i in $(seq 1 150); do tail -n +${lines + 1} ${log} | grep -qE "Turn finished|The turn failed" && break; sleep 2; done; tail -n +${lines + 1} ${log} | grep -E "Turn |turn failed|harness:.*error" | cut -c1-300 | head -12`,
    330_000
  )
  // And the turn reached the fake model (not, say, the real API with a placeholder token), on the fleet's models.
  const requests = (await sh(sandbox, `tail -n +${fakeLines + 1} ${fake}`)).output
    .split("\n")
    .flatMap((line): ReadonlyArray<FakeRequest> => {
      try {
        const request = JSON.parse(line) as FakeRequest
        return request.model === undefined ? [] : [request]
      } catch {
        return []
      }
    })
  // Logged when the harness starts, before the turn.
  const runsOn = (await sh(sandbox, `grep "The agent runs on" ${log} | tail -1 | cut -c1-300`)).output
  const window = harness === "codex" ? await codexWindow(sandbox) : undefined
  const fleet = [
    ...fleetProblems(harness, runsOn, requests),
    ...(window?.problems ?? []),
    ...(await skillProblems(sandbox, harness))
  ]
  const ok = ended.output.includes("Turn finished") && !ended.output.includes("The turn failed") && fleet.length === 0
  const asked = requests.map(
    (r) => `${r.model}/${r.effort ?? "-"}${r.did?.startsWith("reply") === false ? ` ${r.did}` : ""}`
  )
  return {
    harness,
    ok,
    detail: [
      runsOn,
      ...(window === undefined ? [] : [`(Codex context windows used: ${window.found.join(", ")})`]),
      ended.output,
      `(${requests.length} requests reached the fake model: ${asked.join(", ")})`,
      ...fleet
    ].join("\n")
  }
}

/**
 * Codex doesn't send its context window; the threads' rollouts record the one it used (95% of the window it was
 * configured with, clamped to the model's maximum). Without dreamd's setting it's the catalog default, 272k.
 */
const codexWindow = async (
  sandbox: Sandbox
): Promise<{ readonly problems: ReadonlyArray<string>; readonly found: ReadonlyArray<number> }> => {
  const found = (
    await sh(sandbox, `grep -rhoE '"model_context_window":[0-9]+' /home/user/.codex/sessions | sort -u`)
  ).output
    .split("\n")
    .flatMap((line) => /:(\d+)$/.exec(line)?.[1] ?? [])
    .map(Number)
  if (found.length === 0) return { problems: ["no Codex rollout recorded a context window"], found }
  const small = found.filter((window) => window <= 272_000)
  return {
    problems:
      small.length === 0 ? [] : [`Codex ran with the default context window (${small.join(", ")}), not dreamd's`],
    found
  }
}

/** Every skill of Dream's, installed by the harness where it reads skills, with the name it's listed under. */
const skillProblems = async (sandbox: Sandbox, harness: HarnessResult["harness"]): Promise<ReadonlyArray<string>> => {
  const dir = harness === "claude-code" ? "/home/user/.claude/skills" : "/home/user/.agents/skills"
  const names = (await sh(sandbox, `head -qn 2 ${dir}/*/SKILL.md 2>/dev/null | grep '^name: ' | cut -c7-`)).output
  const installed = new Set(names.split("\n").filter((name) => name !== ""))
  // dream-openai comes only with Dream's AI gateway, which this check's dreamd isn't given (gateway-check.ts is).
  const missing = skillNames.filter((name) => name !== "dream-openai" && !installed.has(name))
  return [
    ...(missing.length === 0 ? [] : [`${harness} doesn't have ${missing.join(", ")} in ${dir}`]),
    ...(installed.has("dream-openai") ? [`${harness} has dream-openai without the AI gateway`] : [])
  ]
}

/** One line for each fake: Claude Code's subagent runs on Haiku at low effort, Codex's on its own model at low. */
const checkMessage = [
  "Harness check: say hello.",
  'AGENT: {"description":"harness check","prompt":"say hi","model":"haiku","effort":"low","run_in_background":false}',
  'SPAWN: {"task_name":"harness_check","message":"say hi","reasoning_effort":"low","fork_turns":"none"}'
].join("\n")

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

interface FakeRequest {
  readonly model?: string
  readonly effort?: string
  readonly did?: string
}

/** What's wrong with the models and efforts the turn asked for; nothing if it's the fleet. */
const fleetProblems = (
  harness: HarnessResult["harness"],
  dreamdLog: string,
  requests: ReadonlyArray<FakeRequest>
): ReadonlyArray<string> => {
  const runsOn = /The agent runs on \S+, model (\S+), effort (\S+)/.exec(dreamdLog)
  if (runsOn === null) return ["dreamd didn't say which model the agent runs on"]
  const [, model, effort] = runsOn as unknown as [string, string, string]
  const top = requests.filter((r) => r.did?.startsWith(harness === "claude-code" ? "agent:" : "spawn:"))
  // Claude Code resolves an alias (`opus`) to an id of that family.
  const isTop = (r: FakeRequest) =>
    harness === "claude-code" && !model.startsWith("claude-") ? r.model?.includes(`-${model}-`) : r.model === model
  const problems: Array<string> = []
  if (top.length === 0) problems.push("the agent didn't start a subagent")
  if (!top.every((r) => isTop(r) && r.effort === effort))
    problems.push(`the top-level agent didn't ask for ${model}/${effort}`)
  const sub =
    harness === "claude-code"
      ? requests.filter((r) => r.model?.includes("-haiku-") && r.effort === "low")
      : requests.filter((r) => r.model === model && r.effort === "low")
  if (sub.length === 0) problems.push("no request from a subagent on the model and effort it was given")
  return problems
}

/** Both harnesses' turns in `sandbox`, which must be a fresh sandbox of the build (its dreamd waits for an env file). */
export const checkHarnesses = async (sandbox: Sandbox): Promise<ReadonlyArray<HarnessResult>> => {
  await sandbox.files.write(
    "/home/user/.claude/settings.json",
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18789" } })
  )
  await sh(
    sandbox,
    [
      "mkdir -p /tmp/fakes",
      background(`node ${scripts}/fake-api.ts 8787`, "/tmp/fakes/api.log"),
      background(`node ${scripts}/fake-anthropic.ts 18789`, "/tmp/fakes/anthropic.log"),
      background(`node ${scripts}/fake-responses.ts 18788`, "/tmp/fakes/responses.log"),
      "sleep 3"
    ].join("\n")
  )
  const results: Array<HarnessResult> = []
  for (const harness of ["claude-code", "codex"] as const) results.push(await turn(sandbox, harness))
  return results
}

const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}

/** A sandbox of `template` (e.g. `dream-sandbox:release-…`), checked and killed. */
export const checkTemplate = async (template: string): Promise<ReadonlyArray<HarnessResult>> => {
  const sandbox = await Sandbox.create(template, {
    ...connection,
    timeoutMs: 20 * 60_000,
    metadata: devSandboxMetadata("harness-check", "harness-check")
  })
  try {
    return await checkHarnesses(sandbox)
  } finally {
    await sandbox.kill().catch(() => undefined)
  }
}

export const report = (results: ReadonlyArray<HarnessResult>) =>
  results.map((r) => `${r.harness}: ${r.ok ? "ok" : "FAILED"}\n${r.detail.replace(/^/gm, "  ")}`).join("\n")

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await checkTemplate(process.argv[2] ?? templateName)
  console.log(report(results))
  if (results.some((r) => !r.ok)) process.exitCode = 1
}
