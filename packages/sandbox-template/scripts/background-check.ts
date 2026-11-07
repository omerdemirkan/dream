/**
 * Checks, in a sandbox of a template build, that a turn lasts while the agent's background work runs, against fakes
 * for the Worker and both models (packages/dreamd/scripts/fake-api.ts, fake-anthropic.ts and fake-responses.ts, as
 * shipped in the build). Each case delivers one message to dreamd and reads what dreamd logged, what the fake Worker
 * was told (`ReportTurn`) and what the fake model was asked:
 *
 *   subagent      Claude Code: the agent starts a background subagent that works for 30 s and replies at once.
 *                 The turn is reported finished only after the subagent's report came back and the agent's own
 *                 follow-up turn for it (a request carrying the task notification) ran.
 *   command       Claude Code: the same for a background command (`sleep 20`), which leaves the CLI idle meanwhile.
 *   codex         Codex: the agent spawns a child that works for 30 s and ends its turn without waiting; the turn
 *                 holds, then another root turn hands over the child's final answer.
 *   limit         Claude Code with the quiet limit shortened to 30 s: a background `sleep 600` holds the turn until
 *                 Dream stops it, and the next turn tells the agent what was stopped.
 *   restart       Claude Code: dreamd restarts while a turn is held for a background command; the new dreamd tells
 *                 the agent what stopped with it (and, as after any restart, the turn's events run again).
 *
 *   node scripts/background-check.ts [template[:tag]] [case…]     (default: the current dream-sandbox build, all cases)
 *
 * Needs E2B access (`E2B_API_KEY`, or the workspace's connection). Takes about five minutes.
 */
import { DaemonEnvFile, DefaultDaemonPort, devSandboxMetadata } from "@dream/domain"
import { Sandbox } from "e2b"
import { templateName } from "../src/index.ts"

const scripts = "/opt/dream/packages/dreamd/scripts"
const log = "/home/user/.dream/logs/dreamd.log"
const daemonToken = "background-check-daemon-token"
const fakes = {
  api: "/tmp/fakes/api.log",
  anthropic: "/tmp/fakes/anthropic.log",
  responses: "/tmp/fakes/responses.log"
}

type Run = { stdout: string; stderr: string; exitCode: number }

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
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
const lineCount = async (sandbox: Sandbox, file: string) => Number((await sh(sandbox, `wc -l < ${file}`)).output)
const since = async (sandbox: Sandbox, file: string, from: number) =>
  (await sh(sandbox, `tail -n +${from + 1} ${file}`)).output

type Json = Record<string, unknown>
const jsonLines = (text: string): ReadonlyArray<Json> =>
  text.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line)
      return typeof value === "object" && value !== null ? [value as Json] : []
    } catch {
      return []
    }
  })

/** Restart dreamd on `harness`, with `extra` env lines, and wait until it says it started. */
const restart = async (sandbox: Sandbox, harness: "claude-code" | "codex", extra: ReadonlyArray<string> = []) => {
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
      // A new file each time, so dreamd always restarts.
      `DREAM_CHECK_RUN=${Date.now()}`,
      ...extra,
      ""
    ].join("\n")
  )
  const up = await sh(
    sandbox,
    `for i in $(seq 1 60); do [ "$(grep -c "dreamd started" ${log})" -gt ${started} ] && exit 0; sleep 1; done; exit 1`
  )
  if (up.exitCode !== 0) throw new Error("dreamd didn't start")
}

const deliver = (sandbox: Sandbox, text: string) =>
  sh(
    sandbox,
    `node --disable-warning=ExperimentalWarning ${scripts}/deliver.ts http://127.0.0.1:${DefaultDaemonPort} ${daemonToken} message ${shellQuote(text)}`
  )

/** Wait until dreamd has logged `count` turn ends since line `from`, for up to `seconds`. */
const turnsEnded = async (sandbox: Sandbox, from: number, count: number, seconds: number) =>
  sh(
    sandbox,
    `for i in $(seq 1 ${Math.ceil(seconds / 2)}); do [ "$(tail -n +${from + 1} ${log} | grep -cE "Turn finished|The turn failed")" -ge ${count} ] && exit 0; sleep 2; done; exit 1`,
    (seconds + 30) * 1000
  )

/** The `ReportTurn` calls the fake Worker got since line `from`: when each turn started and finished. */
const reports = async (sandbox: Sandbox, from: number) =>
  jsonLines(await since(sandbox, fakes.api, from))
    .filter((entry) => entry.rpc === "ReportTurn")
    .map((entry) => ({ at: Date.parse(String(entry.at)), state: String((entry.payload as Json).state) }))

const span = (turns: ReadonlyArray<{ readonly at: number; readonly state: string }>) => {
  const started = turns.find((turn) => turn.state === "started")
  const finished = turns.find((turn) => turn.state === "finished")
  return started === undefined || finished === undefined ? undefined : (finished.at - started.at) / 1000
}

interface CaseResult {
  readonly name: string
  readonly ok: boolean
  readonly detail: ReadonlyArray<string>
}

/** What dreamd logged about the case's turns, to show when it fails. */
const turnLog = async (sandbox: Sandbox, from: number) =>
  (
    await sh(
      sandbox,
      `tail -n +${from + 1} ${log} | grep -E "Turn |turn failed|Background|background|limit" | cut -c1-220 | head -20`
    )
  ).output
    .split("\n")
    .map((line) => `  | ${line}`)

const check = (detail: Array<string>, ok: boolean, what: string) => {
  detail.push(`${ok ? "ok  " : "FAIL"} ${what}`)
  return ok
}

/** A background subagent (or command) that outlives the agent's reply holds the turn until it reports back. */
const claudeHold = async (sandbox: Sandbox, name: string, message: string, works: number): Promise<CaseResult> => {
  await restart(sandbox, "claude-code")
  const from = { log: await lineCount(sandbox, log), api: await lineCount(sandbox, fakes.api) }
  const model = await lineCount(sandbox, fakes.anthropic)
  const sent = await deliver(sandbox, message)
  if (sent.exitCode !== 0) return { name, ok: false, detail: [`delivery failed: ${sent.output}`] }
  const ended = await turnsEnded(sandbox, from.log, 1, works + 120)
  const requests = jsonLines(await since(sandbox, fakes.anthropic, model)).filter((r) => r.role === "agent")
  const seconds = span(await reports(sandbox, from.api))
  const detail: Array<string> = []
  const results = [
    check(detail, ended.exitCode === 0, "the turn ended"),
    check(
      detail,
      seconds !== undefined && seconds >= works,
      `the turn was reported working until its background work was done (${seconds ?? "?"} s, the work ${works} s)`
    ),
    check(
      detail,
      requests.some((r) => r.notified === true),
      "the agent got Claude Code's own turn for the task notification"
    ),
    check(
      detail,
      (await sh(sandbox, `tail -n +${from.log + 1} ${log} | grep -c "The turn failed" || true`)).output === "0",
      "the turn didn't fail"
    )
  ]
  if (!results.every(Boolean)) {
    detail.push(...(await turnLog(sandbox, from.log)))
    const all = jsonLines(await since(sandbox, fakes.anthropic, model))
    detail.push(
      ...all.map((r) => `  > ${r.at} ${r.role} ${r.model} ${r.did}${r.notified === true ? " (notified)" : ""}`)
    )
  }
  return { name, ok: results.every(Boolean), detail }
}

const codexHold = async (sandbox: Sandbox): Promise<CaseResult> => {
  const name = "codex"
  await restart(sandbox, "codex")
  const from = { log: await lineCount(sandbox, log), api: await lineCount(sandbox, fakes.api) }
  const model = await lineCount(sandbox, fakes.responses)
  // The child forks the root's turn (the default), so it reads `SLEEP` there; a message it gets alone is encrypted.
  const sent = await deliver(
    sandbox,
    'SPAWN_BG: {"task_name":"research","message":"SLEEP: 30000","reasoning_effort":"low"}'
  )
  if (sent.exitCode !== 0) return { name, ok: false, detail: [`delivery failed: ${sent.output}`] }
  const ended = await turnsEnded(sandbox, from.log, 1, 150)
  const requests = jsonLines(await since(sandbox, fakes.responses, model)).filter((r) => r.role === "agent")
  const seconds = span(await reports(sandbox, from.api))
  const handed = requests.some((r) =>
    ((r.recent as ReadonlyArray<string> | undefined) ?? []).some((item) => item.includes("Dream kept your turn going"))
  )
  const detail: Array<string> = []
  const results = [
    check(detail, ended.exitCode === 0, "the turn ended"),
    check(
      detail,
      seconds !== undefined && seconds >= 30,
      `the turn was reported working until the child finished (${seconds ?? "?"} s, the child 30 s)`
    ),
    check(detail, handed, "another root turn handed over the child's final answer")
  ]
  if (!results.every(Boolean)) {
    detail.push(...(await turnLog(sandbox, from.log)))
    detail.push(
      ...jsonLines(await since(sandbox, fakes.responses, model)).map(
        (r) => `  > ${r.role} ${r.model} ${r.did} ${JSON.stringify(r.outputs).slice(0, 120)}`
      )
    )
  }
  return { name, ok: results.every(Boolean), detail }
}

/** Past the (shortened) quiet limit, Dream stops the turn and the next one says what it stopped. */
const limit = async (sandbox: Sandbox): Promise<CaseResult> => {
  const name = "limit"
  await restart(sandbox, "claude-code", ["DREAM_BACKGROUND_QUIET=30 seconds"])
  const from = { log: await lineCount(sandbox, log), api: await lineCount(sandbox, fakes.api) }
  const model = await lineCount(sandbox, fakes.anthropic)
  const sent = await deliver(sandbox, "RUN_BG: sleep 600")
  if (sent.exitCode !== 0) return { name, ok: false, detail: [`delivery failed: ${sent.output}`] }
  const ended = await turnsEnded(sandbox, from.log, 2, 180)
  const dreamd = await since(sandbox, log, from.log)
  const requests = jsonLines(await since(sandbox, fakes.anthropic, model)).filter((r) => r.role === "agent")
  const seconds = span(await reports(sandbox, from.api))
  const detail: Array<string> = []
  const results = [
    check(detail, dreamd.includes("past Dream's limit; stopping the turn"), "Dream stopped the held turn"),
    check(
      detail,
      seconds !== undefined && seconds >= 30 && seconds < 150,
      `after the limit, not when the command ended (${seconds ?? "?"} s)`
    ),
    check(detail, ended.exitCode === 0, "a second turn ran"),
    check(
      detail,
      requests.some((r) => r.stoppedNote === true),
      "its prompt told the agent what Dream stopped"
    ),
    check(detail, !dreamd.includes("The turn failed"), "neither turn failed")
  ]
  return { name, ok: results.every(Boolean), detail }
}

/** dreamd restarts while a turn holds for a background command; the new one tells the agent it stopped. */
const restarted = async (sandbox: Sandbox): Promise<CaseResult> => {
  const name = "restart"
  await restart(sandbox, "claude-code")
  const from = await lineCount(sandbox, log)
  const model = await lineCount(sandbox, fakes.anthropic)
  // The turn's events go to the first turn after the restart too, so that one runs the command again: short.
  const sent = await deliver(sandbox, "RUN_BG: sleep 45")
  if (sent.exitCode !== 0) return { name, ok: false, detail: [`delivery failed: ${sent.output}`] }
  // Wait until the turn is held: the agent replied after starting the command, which is still running.
  await sh(
    sandbox,
    `for i in $(seq 1 60); do [ "$(tail -n +${model + 1} ${fakes.anthropic} | grep -c '"did":"after-tool"')" -ge 1 ] && exit 0; sleep 1; done; exit 1`,
    90_000
  )
  await sh(sandbox, "sleep 5")
  await restart(sandbox, "claude-code")
  const ended = await turnsEnded(sandbox, from, 1, 150)
  const dreamd = await since(sandbox, log, from)
  const requests = jsonLines(await since(sandbox, fakes.anthropic, model)).filter((r) => r.role === "agent")
  const detail: Array<string> = []
  const results = [
    check(
      detail,
      dreamd.includes("Background work stopped before dreamd started"),
      "the new dreamd found what the held turn was waiting on"
    ),
    check(detail, ended.exitCode === 0, "a turn ran after the restart"),
    check(
      detail,
      requests.some((r) => r.stoppedNote === true),
      "its prompt told the agent the work stopped with the restart"
    )
  ]
  return { name, ok: results.every(Boolean), detail }
}

const cases: Readonly<Record<string, (sandbox: Sandbox) => Promise<CaseResult>>> = {
  subagent: (sandbox) =>
    claudeHold(
      sandbox,
      "subagent",
      // Claude Code refuses a bare long `sleep` in the foreground; this waits as long without being one.
      'AGENT: {"description":"research","prompt":"SUBAGENT: RUN: timeout 30 tail -f /dev/null; true","model":"haiku","effort":"low","run_in_background":true}',
      30
    ),
  command: (sandbox) => claudeHold(sandbox, "command", "RUN_BG: sleep 20", 20),
  codex: codexHold,
  limit,
  restart: restarted
}

const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}

export const checkBackground = async (template: string, names: ReadonlyArray<string> = Object.keys(cases)) => {
  const sandbox = await Sandbox.create(template, {
    ...connection,
    timeoutMs: 30 * 60_000,
    metadata: devSandboxMetadata("background-check")
  })
  try {
    await sandbox.files.write(
      "/home/user/.claude/settings.json",
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18789" } })
    )
    await sh(
      sandbox,
      [
        "mkdir -p /tmp/fakes",
        background(`node ${scripts}/fake-api.ts 8787`, fakes.api),
        background(`node ${scripts}/fake-anthropic.ts 18789`, fakes.anthropic),
        background(`node ${scripts}/fake-responses.ts 18788`, fakes.responses),
        "sleep 3"
      ].join("\n")
    )
    const results: Array<CaseResult> = []
    for (const name of names) {
      const run = cases[name]
      if (run === undefined) throw new Error(`no case ${name}; the cases are ${Object.keys(cases).join(", ")}`)
      results.push(await run(sandbox).catch((error) => ({ name, ok: false, detail: [String(error)] })))
      console.log(
        `${name}: ${results.at(-1)?.ok ? "ok" : "FAILED"}\n${results
          .at(-1)
          ?.detail.map((d) => `  ${d}`)
          .join("\n")}`
      )
    }
    return results
  } finally {
    await sandbox.kill().catch(() => undefined)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [template = templateName, ...names] = process.argv.slice(2)
  const results = await checkBackground(template, names.length === 0 ? undefined : names)
  console.log(results.every((r) => r.ok) ? "\nAll checks passed." : "\nSome checks failed.")
  if (results.some((r) => !r.ok)) process.exitCode = 1
}
