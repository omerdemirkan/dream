/**
 * Checks threads in a sandbox of a template build, against the fakes for the Worker and Claude's API that ship in
 * the build (packages/dreamd/scripts/fake-*.ts), so no account is used:
 *
 *   node packages/sandbox-template/scripts/threads-check.ts [template[:tag]]   (default: the current dream-sandbox)
 *
 * It asks a question with `dream ask`, then delivers their reply in that question's thread the way the ProjectDO
 * does (`UserMessage` with a `thread`), and checks that the agent's turn prompt says which thread it's in and that
 * the question is still open, and that the agent's `dream ask revise` and `dream message --reply-to` reach the
 * Worker as `ReviseQuestion` and a `SendMessage` in the thread. It also checks the skill the agent reads has them.
 */
import { DaemonEnvFile, DefaultDaemonPort, devSandboxMetadata } from "@dream/domain"
import { Sandbox } from "e2b"
import { templateName } from "../src/index.ts"

const scripts = "/opt/dream/packages/dreamd/scripts"
const log = "/home/user/.dream/logs/dreamd.log"
const daemonToken = "threads-check-daemon-token"

const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}

type Run = { stdout: string; stderr: string; exitCode: number }

const sh = async (sandbox: Sandbox, command: string, timeoutMs = 120_000) => {
  const result: Run = await sandbox.commands
    .run(command, { timeoutMs, cwd: "/home/user" })
    .catch((error: { result?: Run }) => {
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

const question = "Which sound should the rest timer end with?"
const louder = "A chime that gets louder"

const check = async (sandbox: Sandbox): Promise<ReadonlyArray<string>> => {
  const problems: Array<string> = []
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
      "sleep 3"
    ].join("\n")
  )
  await sandbox.files.write(
    DaemonEnvFile,
    [
      "DREAM_API_URL=http://127.0.0.1:8787",
      "DREAM_PROJECT_ID=prj_dev",
      "DREAM_PROJECT_TOKEN=dev-project-token",
      `DREAM_DAEMON_TOKEN=${daemonToken}`,
      "DREAM_HARNESS=claude-code",
      ""
    ].join("\n")
  )
  const up = await sh(
    sandbox,
    `for i in $(seq 1 60); do grep -q "dreamd started" ${log} 2>/dev/null && exit 0; sleep 1; done; exit 1`
  )
  if (up.exitCode !== 0) return ["dreamd didn't start"]

  const asked = await sh(
    sandbox,
    `dream ask ${shellQuote(question)} --option 'Soft chime' --option 'Three short buzzes' --json`
  )
  if (asked.exitCode !== 0) return [...problems, `dream ask failed: ${asked.output}`]
  const questionId = (JSON.parse(asked.output.slice(asked.output.indexOf("{"))) as { id: string }).id

  const run =
    `dream ask revise ${questionId} --option ${shellQuote(louder)} --option 'Soft chime' --option 'Three short buzzes' && ` +
    `dream message --reply-to ${questionId} 'Good idea: it is the first option now.'`
  const text = `Could it start soft and get louder if I don't stop it?\nRUN: ${run}`
  const deliver = `node --disable-warning=ExperimentalWarning ${scripts}/deliver.ts http://127.0.0.1:${DefaultDaemonPort} ${daemonToken}`
  const sent = await sh(
    sandbox,
    `${deliver} reply ${shellQuote(text)} ${questionId} question ${shellQuote(question)} open`
  )
  if (sent.exitCode !== 0) return [...problems, `delivery failed: ${sent.output}`]

  const replied = await sh(
    sandbox,
    `for i in $(seq 1 120); do grep -q '"replyTo"' /tmp/fakes/api.log && exit 0; sleep 2; done; exit 1`,
    300_000
  )
  if (replied.exitCode !== 0) problems.push("no SendMessage with replyTo reached the Worker")

  const requests = jsonLines((await sh(sandbox, "cat /tmp/fakes/anthropic.log")).output)
  const wrote = requests.flatMap((r) => (Array.isArray(r.wrote) ? (r.wrote as Array<string>) : []))
  console.log(`turn prompt:\n  ${wrote.join("\n  ") || "(nothing)"}`)
  const line = wrote.find((w) => w.includes(`in the thread on your question ${questionId}`))
  if (line === undefined) problems.push("the turn prompt didn't say which thread the reply is in")
  else if (!line.includes("still open")) problems.push("the turn prompt didn't say the question is still open")

  // The harness writes the skill when the session starts, with the turn.
  const skill = await sh(sandbox, "grep -rl -- '--reply-to' /home/user/.claude/skills 2>/dev/null | head -1")
  if (skill.output === "") problems.push("the skill the agent reads doesn't mention --reply-to")
  else {
    const body = await sh(sandbox, `grep -c -e '^## Threads' -e 'dream ask revise' ${skill.output}`)
    if (Number(body.output) < 2) problems.push(`the skill (${skill.output}) lacks the Threads section`)
  }
  const calls = jsonLines((await sh(sandbox, "cat /tmp/fakes/api.log")).output)
  const revise = calls.find((c) => c.rpc === "ReviseQuestion")?.payload
  console.log(`ReviseQuestion: ${JSON.stringify(revise)}`)
  if (revise?.messageId !== questionId || revise?.options?.[0] !== louder)
    problems.push("dream ask revise didn't reach the Worker as ReviseQuestion with the new options")
  const reply = calls.find((c) => c.rpc === "SendMessage" && c.payload?.replyTo !== undefined)?.payload
  console.log(`SendMessage: ${JSON.stringify(reply)}`)
  if (reply?.replyTo !== questionId) problems.push("dream message --reply-to didn't put the message in the thread")
  return problems
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const template = process.argv[2] ?? templateName
  const sandbox = await Sandbox.create(template, {
    ...connection,
    timeoutMs: 10 * 60_000,
    metadata: devSandboxMetadata("threads-check")
  })
  console.log(`sandbox ${sandbox.sandboxId} of ${template}`)
  try {
    const problems = await check(sandbox)
    console.log(problems.length === 0 ? "threads: ok" : `threads: FAILED\n${problems.map((p) => `  ${p}`).join("\n")}`)
    if (problems.length > 0) process.exitCode = 1
  } finally {
    await sandbox.kill().catch(() => undefined)
  }
}
