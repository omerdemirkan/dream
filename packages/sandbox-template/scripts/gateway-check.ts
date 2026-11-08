/**
 * Checks Dream's AI gateway from inside a real sandbox of a template build: that the agent's commands reach it and
 * the harnesses don't. A public fake-openai (packages/dreamd/scripts/fake-openai.ts, e.g. behind `ol expose`)
 * stands in for the gateway's host; the sandbox gets the egress rule a project would (`Authorization` replaced with
 * a credential) and dreamd the env a project's would (`DREAM_OPENAI_BASE_URL`). Then, on each harness, against
 * the fake Worker and fake models shipped in the build:
 *
 *   - a turn runs a command (the fakes' `RUN:`) that calls the gateway over HTTPS and opens a realtime WebSocket
 *     with plain Node, and both arrive with the egress credential, not the placeholder the command sent;
 *   - the turn still reaches only its own fake model, and the harness process (Codex's) holds no gateway variable;
 *   - nothing Codex sent itself reached the gateway.
 *
 *   node scripts/gateway-check.ts <template[:tag]> <gateway host>
 *   e.g. node scripts/gateway-check.ts dream-sandbox-gw 18791-xxxx.e2b.app
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { DaemonEnvFile, DefaultDaemonPort, devSandboxMetadata, OpenAIGateway } from "@dream/domain"
import { Sandbox } from "e2b"

const [template, host] = process.argv.slice(2)
if (template === undefined || host === undefined) {
  console.error("usage: node scripts/gateway-check.ts <template[:tag]> <gateway host>")
  process.exit(2)
}

const scripts = "/opt/dream/packages/dreamd/scripts"
const log = "/home/user/.dream/logs/dreamd.log"
const daemonToken = "gateway-check-daemon-token"
const credential = "Bearer gateway-check-credential"
const credentialHash = createHash("sha256").update(credential).digest("hex").slice(0, 12)
const baseUrl = `https://${host}/v1`

const connection = {
  apiKey: process.env.E2B_API_KEY ?? "placeholder-added-by-proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}

type Run = { stdout: string; stderr: string; exitCode: number }
const sh = async (sandbox: Sandbox, command: string, timeoutMs = 120_000) => {
  const result: Run | undefined = await sandbox.commands
    .run(command, { timeoutMs })
    .catch((error: { result?: Run }) => error.result)
  // Sandbox output can include a harness's environment; nothing here prints one, but never echo a token.
  const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…")
  return { exitCode: result?.exitCode ?? -1, output: output.trim() }
}
const background = (command: string, out: string) => `setsid nohup ${command} > ${out} 2>&1 < /dev/null &`

/** What the agent's command does: plain Node, as an app would, with what its environment gives it. */
const probe = `
const base = process.env.OPENAI_BASE_URL, key = process.env.OPENAI_API_KEY
const out = { base, placeholder: key === ${JSON.stringify(OpenAIGateway.placeholderKey)}, caTrust: process.env.NODE_EXTRA_CA_CERTS ?? null }
try {
  const r = await fetch(base + "/models", { headers: { authorization: "Bearer " + key } })
  out.http = r.status
} catch (e) { out.http = "error: " + (e.cause?.message ?? e.message) }
out.socket = await new Promise((resolve) => {
  try {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/realtime?model=gpt-realtime-2.1")
    const timer = setTimeout(() => resolve("timeout"), 8000)
    ws.onmessage = (m) => { const t = JSON.parse(String(m.data)).type; if (t === "response.done") { clearTimeout(timer); ws.close(); resolve(t) } }
    ws.onopen = () => ws.send(JSON.stringify({ type: "response.create" }))
    ws.onerror = (e) => { clearTimeout(timer); resolve("error: " + (e.message ?? "")) }
  } catch (e) { resolve("error: " + e.message) }
})
console.log(JSON.stringify(out))
`

interface Logged {
  readonly at: string
  readonly method: string
  readonly path: string
  readonly auth: string | null
  readonly placeholder: boolean
  readonly originator: string | null
  readonly userAgent: string | null
}
const gatewayLog = async (): Promise<ReadonlyArray<Logged>> =>
  (await (await fetch(`https://${host}/_fake/requests`)).json()) as ReadonlyArray<Logged>

const turn = async (sandbox: Sandbox, harness: "claude-code" | "codex") => {
  const problems: Array<string> = []
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
      `DREAM_OPENAI_BASE_URL=${baseUrl}`,
      ""
    ].join("\n")
  )
  const up = await sh(
    sandbox,
    `for i in $(seq 1 60); do [ "$(grep -c "dreamd started" ${log})" -gt ${started} ] && exit 0; sleep 1; done; exit 1`
  )
  if (up.exitCode !== 0) return [`${harness}: dreamd didn't start`]
  const lines = Number((await sh(sandbox, `wc -l < ${log}`)).output)
  const fake = harness === "claude-code" ? "/tmp/fakes/anthropic.log" : "/tmp/fakes/responses.log"
  const fakeLines = Number((await sh(sandbox, `wc -l < ${fake}`)).output)
  const since = new Date().toISOString()
  const out = `/tmp/gateway-probe-${harness}.json`
  const deliver = `node --disable-warning=ExperimentalWarning ${scripts}/deliver.ts http://127.0.0.1:${DefaultDaemonPort} ${daemonToken}`
  const sent = await sh(sandbox, `${deliver} message 'Gateway check. RUN: node /tmp/gateway-probe.mjs > ${out} 2>&1'`)
  if (sent.exitCode !== 0) return [`${harness}: delivery failed: ${sent.output}`]
  const ended = await sh(
    sandbox,
    `for i in $(seq 1 150); do tail -n +${lines + 1} ${log} | grep -qE "Turn finished|The turn failed" && break; sleep 2; done; tail -n +${lines + 1} ${log} | grep -E "Turn |turn failed" | cut -c1-300 | head -5`,
    330_000
  )
  if (!ended.output.includes("Turn finished")) problems.push(`the turn didn't finish: ${ended.output}`)

  // The command reached the gateway, over HTTPS and a WebSocket, with what egress added.
  const result = await sh(sandbox, `cat ${out}`)
  console.log(`${harness}: the command saw ${result.output}`)
  try {
    const seen = JSON.parse(result.output) as Record<string, unknown>
    if (seen.base !== baseUrl) problems.push(`OPENAI_BASE_URL was ${String(seen.base)}`)
    if (seen.placeholder !== true) problems.push("OPENAI_API_KEY wasn't the placeholder")
    if (seen.http !== 200) problems.push(`GET /models answered ${String(seen.http)}`)
    if (seen.socket !== "response.done") problems.push(`the realtime socket said ${String(seen.socket)}`)
  } catch {
    problems.push("the command left no result")
  }
  // Requests and sockets; a socket's messages are logged apart, with no headers.
  const reached = (await gatewayLog()).filter((entry) => entry.at >= since && entry.method !== "WS-MESSAGE")
  console.log(
    `${harness}: the gateway saw ${reached.map((e) => `${e.method} ${e.path} auth=${e.auth === credentialHash ? "egress" : e.placeholder ? "placeholder" : e.auth}${e.originator === null ? "" : ` originator=${e.originator}`}`).join("; ")}`
  )
  if (!reached.some((e) => e.path === "/v1/models")) problems.push("GET /v1/models never reached the gateway")
  if (!reached.some((e) => e.method === "WEBSOCKET")) problems.push("the WebSocket never reached the gateway")
  if (reached.some((e) => e.auth !== credentialHash))
    problems.push("a request reached the gateway without the egress credential")
  if (reached.some((e) => /codex/i.test(`${e.originator ?? ""} ${e.userAgent ?? ""}`)))
    problems.push("Codex itself called the gateway")

  // The turn's own model traffic went to its fake model.
  const requests = (await sh(sandbox, `tail -n +${fakeLines + 1} ${fake} | grep -c '"model"' || true`)).output
  console.log(`${harness}: ${requests} requests reached its fake model`)
  if (Number(requests) === 0) problems.push("no request reached the fake model")

  // The harness process itself holds no gateway variable (Codex), or holds it only to pass on (Claude Code).
  const binary = harness === "codex" ? "codex" : "claude"
  const envs = await sh(
    sandbox,
    `for p in $(pgrep -f "${binary}" | grep -v $$); do tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -c "^OPENAI_BASE_URL=${baseUrl}" ; done | sort | uniq -c`
  )
  console.log(`${harness}: ${binary} processes with the gateway's OPENAI_BASE_URL: ${envs.output || "none found"}`)
  if (harness === "codex" && /\s1$/m.test(envs.output)) problems.push("a codex process holds OPENAI_BASE_URL")
  return problems.map((p) => `${harness}: ${p}`)
}

const sandbox = await Sandbox.create(template, {
  ...connection,
  timeoutMs: 20 * 60_000,
  metadata: devSandboxMetadata("gateway-check"),
  network: { rules: { [host]: [{ transform: { headers: { Authorization: credential } } }] } }
})
try {
  await sandbox.files.write(
    "/home/user/.claude/settings.json",
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18789" } })
  )
  await sandbox.files.write("/tmp/gateway-probe.mjs", probe)
  // This checkout's fake model for Codex, which runs a `RUN:` command through its shell tool.
  await sandbox.files.write(
    "/tmp/fakes/fake-responses.ts",
    readFileSync(new URL("../../dreamd/scripts/fake-responses.ts", import.meta.url), "utf8")
  )
  await sh(
    sandbox,
    [
      "mkdir -p /tmp/fakes",
      background(`node ${scripts}/fake-api.ts 8787`, "/tmp/fakes/api.log"),
      background(`node ${scripts}/fake-anthropic.ts 18789`, "/tmp/fakes/anthropic.log"),
      background(`node /tmp/fakes/fake-responses.ts 18788`, "/tmp/fakes/responses.log"),
      "sleep 3"
    ].join("\n")
  )
  const problems = [...(await turn(sandbox, "claude-code")), ...(await turn(sandbox, "codex"))]
  console.log(problems.length === 0 ? "gateway check: ok" : `gateway check FAILED:\n${problems.join("\n")}`)
  if (problems.length > 0) process.exitCode = 1
} finally {
  await sandbox.kill().catch(() => undefined)
}
