/**
 * Runs a scheduled task (`dream wake --task`) on each harness in a sandbox of a template build, against the fakes for
 * the Worker and both models that ship in the build (packages/dreamd/scripts/fake-*.ts), so no account is used:
 *
 *   node scripts/task-check.ts [template[:tag]]     (default: the current dream-sandbox build)
 *
 * For each harness it starts dreamd, delivers a `WakeDue` with a task the way the ProjectDO does, and checks that:
 * the task ran in a session of its own (its requests carry the task's system prompt, not the agent's, on the model
 * and effort the wake gave); it finished and was reported (`ReportTask`) with its tokens; no turn of the agent's
 * started; and the inbox is empty again. On Claude Code the fake model also has the task run
 * `dream wake "…"`, which reaches the Worker as `WakeNow`: the task can wake the agent.
 */
import { DaemonEnvFile, DefaultDaemonPort } from "@dream/domain"
import { Sandbox } from "e2b"
import { templateName } from "../src/index.ts"

const scripts = "/opt/dream/packages/dreamd/scripts"
const log = "/home/user/.dream/logs/dreamd.log"
const daemonToken = "task-check-daemon-token"
const wakeReason = "TASK-CHECK the feed answered 503"

const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}

type Run = { stdout: string; stderr: string; exitCode: number }

const sh = async (sandbox: Sandbox, command: string, timeoutMs = 120_000) => {
  const result: Run = await sandbox.commands.run(command, { timeoutMs }).catch((error: { result?: Run }) => {
    if (error.result === undefined) throw error
    return error.result
  })
  return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}`.trim() }
}

const background = (command: string, out: string) => `setsid nohup ${command} > ${out} 2>&1 < /dev/null &`
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const jsonLines = (text: string): ReadonlyArray<Record<string, any>> =>
  text.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line)
      return typeof value === "object" && value !== null ? [value] : []
    } catch {
      return []
    }
  })

interface Case {
  readonly harness: "claude-code" | "codex"
  readonly model: string
  readonly effort: string
  readonly brief: string
  /** How the fake logs the model Claude Code resolves an alias to. */
  readonly modelMatches: (model: string) => boolean
}

const cases: ReadonlyArray<Case> = [
  {
    harness: "claude-code",
    model: "sonnet",
    effort: "medium",
    brief: `Check the feed and tell the agent what you found.\nRUN: dream wake ${shellQuote(wakeReason)}`,
    modelMatches: (model) => model.includes("-sonnet-")
  },
  {
    harness: "codex",
    model: "gpt-6-luna",
    effort: "low",
    brief: "Check the feed and say what you found.",
    modelMatches: (model) => model === "gpt-6-luna"
  }
]

const runCase = async (sandbox: Sandbox, check: Case) => {
  const problems: Array<string> = []
  const started = Number((await sh(sandbox, `grep -c "dreamd started" ${log} || true`)).output)
  await sandbox.files.write(
    DaemonEnvFile,
    [
      "DREAM_API_URL=http://127.0.0.1:8787",
      "DREAM_PROJECT_ID=prj_dev",
      "DREAM_PROJECT_TOKEN=dev-project-token",
      `DREAM_DAEMON_TOKEN=${daemonToken}`,
      `DREAM_HARNESS=${check.harness}`,
      "DREAM_CODEX_BASE_URL=http://127.0.0.1:18788/backend-api/codex",
      ""
    ].join("\n")
  )
  const up = await sh(
    sandbox,
    `for i in $(seq 1 60); do [ "$(grep -c "dreamd started" ${log})" -gt ${started} ] && exit 0; sleep 1; done; exit 1`
  )
  if (up.exitCode !== 0) return [`${check.harness}: dreamd didn't start`]
  const fake = check.harness === "claude-code" ? "/tmp/fakes/anthropic.log" : "/tmp/fakes/responses.log"
  const mark = async (file: string) => Number((await sh(sandbox, `wc -l < ${file}`)).output)
  const [logFrom, fakeFrom, apiFrom] = [await mark(log), await mark(fake), await mark("/tmp/fakes/api.log")]

  const deliver = `node --disable-warning=ExperimentalWarning ${scripts}/deliver.ts http://127.0.0.1:${DefaultDaemonPort} ${daemonToken}`
  const sent = await sh(
    sandbox,
    `${deliver} task "Check the feed" ${shellQuote(check.brief)} ${check.model} ${check.effort}`
  )
  if (sent.exitCode !== 0) return [`${check.harness}: delivery failed: ${sent.output}`]
  const ended = await sh(
    sandbox,
    `for i in $(seq 1 150); do tail -n +${logFrom + 1} ${log} | grep -q "Scheduled task finished" && break; sleep 2; done; ` +
      `tail -n +${logFrom + 1} ${log} | grep -E "task|Turn " | cut -c1-300 | head -12`,
    330_000
  )
  console.log(`${check.harness} dreamd:\n${ended.output}`)
  if (!/Scheduled task finished.*succeeded/.test(ended.output)) problems.push("the task didn't finish as succeeded")
  if (ended.output.includes("Turn started")) problems.push("a turn of the agent's started")

  const requests = jsonLines((await sh(sandbox, `tail -n +${fakeFrom + 1} ${fake}`)).output).filter(
    (r) => typeof r.model === "string"
  )
  const asked = requests.map((r) => `${r.model}/${r.effort ?? "-"} ${r.persona ?? "?"}`)
  console.log(`${check.harness} model requests: ${asked.join(", ")}`)
  const own = requests.filter((r) => r.persona === "task")
  if (own.length === 0) problems.push("no request carried the task's system prompt")
  if (requests.some((r) => r.persona === "agent")) problems.push("a request carried the agent's system prompt")
  if (!own.every((r) => check.modelMatches(String(r.model)) && r.effort === check.effort))
    problems.push(`the task's requests weren't all on ${check.model}/${check.effort}`)

  const calls = jsonLines((await sh(sandbox, `tail -n +${apiFrom + 1} /tmp/fakes/api.log`)).output)
  const report = calls.find((c) => c.rpc === "ReportTask")?.payload
  console.log(`${check.harness} ReportTask: ${JSON.stringify(report)}`)
  if (report === undefined) problems.push("no ReportTask reached the Worker")
  else {
    if (report.outcome !== "succeeded") problems.push(`ReportTask said ${report.outcome}`)
    if (!(report.usage?.tokens?.cacheRead > 0)) problems.push("ReportTask carried no tokens")
  }
  if (check.harness === "claude-code") {
    const woke = calls.find((c) => c.rpc === "WakeNow")?.payload?.why
    if (woke !== wakeReason)
      problems.push(`the task's dream wake didn't reach the Worker (got ${JSON.stringify(woke)})`)
  }
  const inbox = await sh(sandbox, "cat /home/user/.dream/state/inbox.json")
  const entries = jsonLines(inbox.output.replace(/\n/g, ""))[0]?.entries
  if (!Array.isArray(entries) || entries.length !== 0)
    problems.push(`the inbox isn't empty: ${inbox.output.slice(0, 300)}`)
  return problems.map((problem) => `${check.harness}: ${problem}`)
}

const template = process.argv[2] ?? templateName
const sandbox = await Sandbox.create(template, { ...connection, timeoutMs: 20 * 60_000 })
console.log(`sandbox ${sandbox.sandboxId} of ${template}`)
try {
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
  const problems: Array<string> = []
  for (const check of cases) problems.push(...(await runCase(sandbox, check)))
  console.log(problems.length === 0 ? "OK: tasks ran in sessions of their own on both harnesses" : problems.join("\n"))
  process.exitCode = problems.length === 0 ? 0 : 1
} finally {
  await sandbox.kill().catch(() => undefined)
  console.log("killed")
}
