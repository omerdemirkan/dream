/**
 * Runs one turn on each harness in a sandbox of a template build, against fakes for the Worker and both models
 * (packages/dreamd/scripts/fake-api.ts, fake-anthropic.ts and fake-responses.ts, as shipped in the build), so a
 * Claude Code or Codex release that breaks its adapter is caught before any project gets it. `build.ts` runs it on
 * every build before tagging the build `default`; on its own:
 *
 *   node scripts/harness-check.ts [template[:tag]]     (default: the current dream-sandbox build)
 */
import { DaemonEnvFile, DefaultDaemonPort } from "@dream/domain"
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

const sh = async (sandbox: Sandbox, command: string, timeoutMs = 120_000) => {
  const result = await sandbox.commands
    .run(command, { timeoutMs })
    .catch((error: { result?: { stdout: string; stderr: string; exitCode: number } }) => {
      if (error.result === undefined) throw error
      return error.result
    })
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
  const deliver = `node --disable-warning=ExperimentalWarning ${scripts}/deliver.ts http://127.0.0.1:${DefaultDaemonPort} ${daemonToken}`
  const sent = await sh(sandbox, `${deliver} message "Harness check: say hello."`)
  if (sent.exitCode !== 0) return { harness, ok: false, detail: `delivery failed: ${sent.output}` }
  const ended = await sh(
    sandbox,
    `for i in $(seq 1 150); do tail -n +${lines + 1} ${log} | grep -qE "Turn finished|The turn failed" && break; sleep 2; done; tail -n +${lines + 1} ${log} | grep -E "Turn |turn failed|harness:.*error" | cut -c1-300 | head -12`,
    330_000
  )
  // And the turn reached the fake model (not, say, the real API with a placeholder token).
  const fake = harness === "claude-code" ? "/tmp/fakes/anthropic.log" : "/tmp/fakes/responses.log"
  const asked = Number((await sh(sandbox, `grep -cE '"/v1/messages"|/responses' ${fake} || true`)).output)
  const ok = ended.output.includes("Turn finished") && !ended.output.includes("The turn failed") && asked > 0
  return { harness, ok, detail: `${ended.output}\n(${asked} requests reached the fake model)` }
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
  const sandbox = await Sandbox.create(template, { ...connection, timeoutMs: 20 * 60_000 })
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
