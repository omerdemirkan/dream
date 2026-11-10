/**
 * Moves a project from Claude Code to Codex and back in a sandbox of a template build, the way the ProjectDO does
 * (`PlanSwitcher`), against the fakes for the Worker and both models that ship in the build
 * (packages/dreamd/scripts/fake-*.ts), so no account is used:
 *
 *   node scripts/plan-switch-check.ts [template[:tag]]     (default: the current dream-sandbox build)
 *
 * For each move it delivers `PlanSwitching` with a message the fake model turns into a command writing the handoff
 * (the real agent writes it itself), rewrites dreamd's env file for the other harness (which restarts dreamd), and
 * delivers `PlanSwitched` with their next message. It checks that:
 *
 *   - the outgoing agent's turn wrote the handoff where the event said, on its own harness;
 *   - dreamd on the new harness started a new conversation, whose first prompt opens with the handoff from the old
 *     one (where its log is, and how it ended: the fake recalls the words the old conversation was told to remember)
 *     and carries the `PlanSwitched` event, pointing at the handoff;
 *   - the next turn continues that conversation (it still recalls them, and what it was told since);
 *   - a handoff request left over for the harness it left is dropped, starting no turn;
 *   - a move put back before the new harness ran a turn (the ProjectDO rolling back a failed one) goes on with the
 *     conversation it had.
 */
import { DaemonEnvFile, DefaultDaemonPort, devSandboxMetadata, type Harness, planHandoffPath } from "@dream/domain"
import { DateTime } from "effect"
import { Sandbox } from "e2b"
import { templateName } from "../src/index.ts"

const scripts = "/opt/dream/packages/dreamd/scripts"
const log = "/home/user/.dream/logs/dreamd.log"
const daemonToken = "plan-switch-check-daemon-token"
const fakeLog: Record<Harness, string> = {
  "claude-code": "/tmp/fakes/anthropic.log",
  codex: "/tmp/fakes/responses.log"
}

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

const problems: Array<string> = []
const expect = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) problems.push(what)
}

const template = process.argv[2] ?? templateName
const sandbox = await Sandbox.create(template, {
  ...connection,
  timeoutMs: 30 * 60_000,
  metadata: devSandboxMetadata("plan-switch-check")
})
console.log(`sandbox ${sandbox.sandboxId} of ${template}`)

const lines = async (file: string) => Number((await sh(sandbox, `[ -f ${file} ] && wc -l < ${file} || echo 0`)).output)
const since = async (file: string, from: number) => (await sh(sandbox, `tail -n +${from + 1} ${file}`)).output

/** dreamd on `harness`, as the ProjectDO starts it by writing its env file; resolves once the new one is up. */
const startOn = async (harness: Harness) => {
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
    `for i in $(seq 1 90); do [ "$(grep -c "dreamd started" ${log})" -gt ${started} ] && exit 0; sleep 1; done; exit 1`,
    120_000
  )
  expect(up.exitCode === 0, `dreamd started on ${harness}`)
}

const deliver = (events: ReadonlyArray<Record<string, unknown>>) =>
  sh(
    sandbox,
    `node --disable-warning=ExperimentalWarning ${scripts}/deliver.ts http://127.0.0.1:${DefaultDaemonPort} ` +
      `${daemonToken} events ${shellQuote(JSON.stringify(events))}`
  )

let messages = 0
const message = (text: string) => ({ _tag: "UserMessage", messageId: `msg_check_${++messages}`, text })

/** Delivers `events` and waits for the turn they start to end; returns the model requests it made. */
const turn = async (harness: Harness, what: string, events: ReadonlyArray<Record<string, unknown>>) => {
  const [logFrom, fakeFrom] = [await lines(log), await lines(fakeLog[harness])]
  const sent = await deliver(events)
  if (sent.exitCode !== 0) {
    expect(false, `${what}: delivered (${sent.output.slice(0, 300)})`)
    return []
  }
  const ended = await sh(
    sandbox,
    `for i in $(seq 1 150); do tail -n +${logFrom + 1} ${log} | grep -qE "Turn finished|The turn failed|couldn't run" && break; sleep 2; done; ` +
      `tail -n +${logFrom + 1} ${log} | grep -E "Turn |turn |moved from|handoff" | cut -c1-240 | head -8`,
    330_000
  )
  console.log(`${what}:\n${ended.output}`)
  expect(/Turn finished/.test(ended.output), `${what}: the turn finished on ${harness}`)
  return jsonLines(await since(fakeLog[harness], fakeFrom)).filter(
    (request) => request.role === "agent" || request.persona === "agent"
  )
}

const remembered = (requests: ReadonlyArray<Record<string, any>>) =>
  new Set<string>(requests.flatMap((request) => (request.remembered as ReadonlyArray<string> | undefined) ?? []))

/** Moves the project from `from` to `to`: the handoff turn, the restart on the new harness, the first turn there. */
const move = async (from: Harness, to: Harness, remember: string) => {
  console.log(`\n== ${from} → ${to}`)
  const handoff = planHandoffPath(DateTime.nowUnsafe(), to)
  await turn(from, "the handoff turn", [
    { _tag: "PlanSwitching", from, to, handoff },
    message(`RUN: mkdir -p /home/user/.dream/handoffs && printf '# Handoff\\nThey lift on Mondays.\\n' > ${handoff}`)
  ])
  const written = await sh(sandbox, `cat ${handoff}`)
  expect(written.output.includes("They lift on Mondays."), `the agent on ${from} wrote the handoff at ${handoff}`)

  const logFrom = await lines(log)
  await startOn(to)
  const restarted = await since(log, logFrom)
  expect(
    restarted.includes(`The project moved from ${from} to ${to}`),
    "dreamd started a new conversation with a handoff from the old one"
  )

  const first = await turn(to, "the first turn on the new plan", [
    { _tag: "PlanSwitched", from, to, outcome: "moved", handoff, model: to === "codex" ? "gpt-6.1-sol" : "opus" },
    message(`REMEMBER: ${remember}. How's it going?`)
  ])
  const opening = String(first[0]?.opening ?? "")
  console.log(`its first prompt opens: ${JSON.stringify(opening)}`)
  expect(opening.startsWith("Until now this project's agent ran on"), "the first prompt opens with the handoff")
  expect(
    Number(first[0]?.userMessages ?? 99) <= 2,
    `it's a new conversation (${first[0]?.userMessages} user message(s) in its first request)`
  )
  return { first, handoff }
}

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
      background(`node ${scripts}/fake-anthropic.ts 18789`, fakeLog["claude-code"]),
      background(`node ${scripts}/fake-responses.ts 18788`, fakeLog.codex),
      "sleep 3"
    ].join("\n")
  )

  console.log("\n== on claude-code")
  await startOn("claude-code")
  await turn("claude-code", "a turn on Claude", [message("REMEMBER: apple. A strength log, please.")])
  const second = await turn("claude-code", "the next turn on Claude", [message("And the charts?")])
  expect(remembered(second).has("apple"), "Claude's conversation goes on from turn to turn")

  const toCodex = await move("claude-code", "codex", "plum")
  expect(remembered(toCodex.first).has("apple"), "Codex's first turn has what Claude's conversation was told")
  const onCodex = await turn("codex", "the next turn on Codex", [message("Once more.")])
  expect(
    remembered(onCodex).has("apple") && remembered(onCodex).has("plum"),
    "the next turn on Codex continues its conversation"
  )

  // A handoff asked of the harness it left (a restart in the handoff turn can leave one queued) starts nothing.
  const logFrom = await lines(log)
  await deliver([{ _tag: "PlanSwitching", from: "claude-code", to: "codex", handoff: "/tmp/never.md" }])
  await sh(sandbox, "sleep 5")
  const after = await since(log, logFrom)
  expect(
    after.includes("Dropped a handoff") && !after.includes("Turn started"),
    "a handoff asked of the plan it left is dropped, with no turn"
  )

  const toClaude = await move("codex", "claude-code", "fig")
  expect(remembered(toClaude.first).has("plum"), "Claude's first turn back has what Codex's conversation was told")
  const back = await turn("claude-code", "the next turn back on Claude", [message("And now?")])
  expect(
    remembered(back).has("plum") && remembered(back).has("fig"),
    "the next turn back on Claude continues its conversation"
  )

  console.log("\n== claude-code → codex, put back before a turn")
  const putFrom = await lines(log)
  await startOn("codex")
  await startOn("claude-code")
  expect(
    (await since(log, putFrom)).includes("before its conversation on codex began; going on with the one it had"),
    "dreamd went back to the conversation it had"
  )
  const resumed = await turn("claude-code", "a turn after the put-back", [message("Still there?")])
  expect(
    remembered(resumed).has("fig") && Number(resumed[0]?.userMessages ?? 0) > 2,
    "it's the same conversation as before the move that didn't happen"
  )
  const inbox = await sh(sandbox, "cat /home/user/.dream/state/inbox.json")
  const entries = jsonLines(inbox.output.replace(/\n/g, ""))[0]?.entries
  expect(Array.isArray(entries) && entries.length === 0, "the inbox is empty at the end")

  console.log(problems.length === 0 ? "\nOK: the project moved to Codex and back, and picked up each time" : "")
  process.exitCode = problems.length === 0 ? 0 : 1
} finally {
  if (process.env.KEEP === undefined) {
    await sandbox.kill().catch(() => undefined)
    console.log("killed")
  } else console.log(`kept ${sandbox.sandboxId}`)
}
