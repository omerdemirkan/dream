/**
 * Checks Dream's AI gateway on the deployed Worker without running an agent: no project, no turn, nobody's
 * subscription. It asks the operator's route for a short-lived credential of a dev pseudo-project owned by Dream
 * (`POST /admin/openai/dev-credential`), starts a throwaway sandbox whose egress rule for `openai.<domain>` carries
 * it, as a project's would, and from inside it, with plain Node and a placeholder key, makes:
 *
 *   - one Responses call and one streamed Responses call, one short speech and one tiny realtime WebSocket exchange,
 *     on the cheapest models (about a cent in all);
 *   - a refused path (`GET /v1/files`, 404) and a request that says it's Codex (403).
 *
 * Then it prints what the ledger recorded for the pseudo-project (`GET /admin/openai/dev-events`) and kills the
 * sandbox. With the gateway on but no OpenAI key yet, it checks the gateway answers "isn't configured" and stops.
 * It prints statuses and token counts, never a credential.
 *
 *   node packages/sandbox-template/scripts/gateway-live-check.ts
 *
 * DREAM_API_URL (default https://dream.omer.build), DREAM_DOMAIN (default omer.build); the dev secret comes from
 * DREAM_DEV_SECRET, or the `dream-ops` D1 database as qa.ts reads it (through the workspace's Cloudflare
 * connection). E2B's key comes from the workspace's connection too.
 */
import { devSandboxMetadata } from "@dream/domain"
import { Sandbox } from "e2b"

const Api = process.env.DREAM_API_URL ?? "https://dream.omer.build"
const Domain = process.env.DREAM_DOMAIN ?? "omer.build"
const Account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "2d98de7c4511e98d2f774c4fcc9b9b93"
const GatewayHost = `openai.${Domain}`
const connection = {
  apiKey: process.env.E2B_API_KEY ?? "e2b_placeholder_injected_by_proxy",
  ...(process.env.HTTPS_PROXY === undefined ? {} : { proxy: process.env.HTTPS_PROXY })
}

type Json = Record<string, any>

const devSecret = async (): Promise<string> => {
  if (process.env.DREAM_DEV_SECRET) return process.env.DREAM_DEV_SECRET.trim()
  const cf = async (path: string, init?: RequestInit): Promise<Json> => {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${Account}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_API_TOKEN !== "anything"
          ? { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }
          : {})
      }
    })
    const body = (await res.json()) as Json
    if (!body.success) throw new Error(`Cloudflare ${path}: ${JSON.stringify(body.errors)}`)
    return body.result
  }
  const dbs = (await cf("/d1/database")) as Array<{ uuid: string; name: string }>
  const ops = dbs.find((d) => d.name === "dream-ops")
  if (ops === undefined) throw new Error("dream-ops database not found")
  const rows = await cf(`/d1/database/${ops.uuid}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: "SELECT value FROM settings WHERE name = 'DEV_LOGIN_SECRET'" })
  })
  const secret = rows?.[0]?.results?.[0]?.value
  if (typeof secret !== "string") throw new Error("no DEV_LOGIN_SECRET in dream-ops")
  return secret
}

/** What runs in the sandbox: an app's calls, with OPENAI_BASE_URL and a placeholder key, as dreamd gives them. */
const probe = `
const base = process.env.OPENAI_BASE_URL, key = process.env.OPENAI_API_KEY
const out = {}
const call = async (name, path, init = {}) => {
  try {
    const r = await fetch(base + path, { ...init, headers: { authorization: "Bearer " + key, "content-type": "application/json", ...(init.headers ?? {}) } })
    const type = r.headers.get("content-type") ?? ""
    const body = type.includes("json") ? await r.json() : type.includes("event-stream") ? await r.text() : (await r.arrayBuffer()).byteLength
    out[name] = { status: r.status, body: typeof body === "string" ? body.slice(-400) : body }
  } catch (e) { out[name] = { error: String(e.cause?.message ?? e.message) } }
}
const only = process.argv[2]
if (only === "configured") {
  await call("responses", "/responses", { method: "POST", body: JSON.stringify({ model: "gpt-5-nano", input: "Say hi." }) })
} else {
  await call("responses", "/responses", { method: "POST", body: JSON.stringify({ model: "gpt-5-nano", input: "Say hi in two words.", max_output_tokens: 64, reasoning: { effort: "minimal" } }) })
  await call("stream", "/responses", { method: "POST", body: JSON.stringify({ model: "gpt-5-nano", input: "Say hello.", max_output_tokens: 64, reasoning: { effort: "minimal" }, stream: true }) })
  await call("speech", "/audio/speech", { method: "POST", body: JSON.stringify({ model: "tts-1", input: "Hello from Dream.", voice: "alloy" }) })
  await call("files", "/files")
  await call("codex", "/responses", { method: "POST", headers: { originator: "codex_cli_rs" }, body: JSON.stringify({ model: "gpt-5-nano", input: "hi" }) })
  out.realtime = await new Promise((resolve) => {
    const ws = new WebSocket(base.replace(/^http/, "ws") + "/realtime?model=gpt-realtime-2.1-mini")
    const timer = setTimeout(() => { ws.close(); resolve({ said: "timeout" }) }, 20000)
    ws.onopen = () => ws.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["text"], instructions: "Say hi.", max_output_tokens: 16 } }))
    ws.onmessage = (m) => {
      const event = JSON.parse(String(m.data))
      if (event.type === "error") { clearTimeout(timer); ws.close(); resolve({ said: "error", error: event.error?.message }) }
      if (event.type === "response.done") { clearTimeout(timer); ws.close(); resolve({ said: "response.done", usage: event.response?.usage }) }
    }
    ws.onerror = (e) => { clearTimeout(timer); resolve({ said: "socket error", error: e.message }) }
  })
}
console.log(JSON.stringify(out))
`

const main = async () => {
  const secret = await devSecret()
  const minted = await fetch(`${Api}/admin/openai/dev-credential`, {
    method: "POST",
    headers: { "x-dream-dev-secret": secret, "content-type": "application/json" },
    body: JSON.stringify({ label: "live-check" })
  })
  if (minted.status !== 200)
    throw new Error(`the dev credential route answered ${minted.status}: ${await minted.text()}`)
  const dev = (await minted.json()) as {
    credential: string
    projectId: string
    enabled: boolean
    configured: boolean
  }
  console.log(`dev pseudo-project ${dev.projectId}; gateway enabled: ${dev.enabled}, OpenAI key: ${dev.configured}`)
  if (!dev.enabled) {
    console.log("gateway live check: the gateway is off on this deployment (DREAM_AI_GATEWAY_ENABLED)")
    process.exitCode = 1
    return
  }

  const sandbox = await Sandbox.create("dream-sandbox", {
    ...connection,
    timeoutMs: 5 * 60_000,
    metadata: devSandboxMetadata("gateway-live-check"),
    network: { rules: { [GatewayHost]: [{ transform: { headers: { Authorization: `Bearer ${dev.credential}` } } }] } }
  })
  const problems: Array<string> = []
  try {
    await sandbox.files.write("/tmp/gateway-live-probe.mjs", probe)
    const run = async (mode: string) => {
      const result = await sandbox.commands
        .run(`node /tmp/gateway-live-probe.mjs ${mode}`, {
          timeoutMs: 90_000,
          envs: {
            OPENAI_BASE_URL: `https://${GatewayHost}/v1`,
            OPENAI_API_KEY: "dream-openai-placeholder",
            NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt"
          }
        })
        .catch((error: { result?: { stdout: string; stderr: string } }) => error.result)
      try {
        return JSON.parse(result?.stdout ?? "") as Json
      } catch {
        throw new Error(`the probe failed: ${(result?.stderr ?? "").slice(0, 400)}`)
      }
    }

    if (!dev.configured) {
      const seen = await run("configured")
      const message = seen.responses?.body?.error?.message ?? ""
      console.log(`responses: ${seen.responses?.status} ${message}`)
      if (seen.responses?.status !== 503 || !message.includes("isn't configured"))
        problems.push("without a key, the gateway should answer 503 isn't configured")
    } else {
      const seen = await run("all")
      const usage = (u: Json | undefined) =>
        u === undefined
          ? "no usage"
          : `${u.input_tokens ?? u.prompt_tokens} in, ${u.output_tokens ?? u.completion_tokens} out`
      console.log(`responses: ${seen.responses?.status}, ${usage(seen.responses?.body?.usage)}`)
      console.log(
        `stream: ${seen.stream?.status}, ends ${String(seen.stream?.body ?? "").includes("response.completed") ? "with response.completed" : "without response.completed"}`
      )
      console.log(`speech: ${seen.speech?.status}, ${seen.speech?.body} bytes`)
      console.log(
        `realtime: ${seen.realtime?.said}${seen.realtime?.usage ? `, ${usage(seen.realtime.usage)}` : ""}${seen.realtime?.error ? `: ${seen.realtime.error}` : ""}`
      )
      console.log(`GET /v1/files: ${seen.files?.status}; a Codex-identified request: ${seen.codex?.status}`)
      if (seen.responses?.status !== 200) problems.push(`the Responses call answered ${seen.responses?.status}`)
      if (seen.stream?.status !== 200) problems.push(`the stream answered ${seen.stream?.status}`)
      if (seen.speech?.status !== 200) problems.push(`speech answered ${seen.speech?.status}`)
      if (seen.realtime?.said !== "response.done") problems.push(`the realtime socket said ${seen.realtime?.said}`)
      if (seen.files?.status !== 404) problems.push("GET /v1/files wasn't refused")
      if (seen.codex?.status !== 403) problems.push("Codex's request wasn't refused")

      // What the ledger recorded (metering runs just after each answer).
      await new Promise((resolve) => setTimeout(resolve, 3000))
      const read = await fetch(`${Api}/admin/openai/dev-events?project=${dev.projectId}`, {
        headers: { "x-dream-dev-secret": secret }
      })
      const events = (await read.json()) as ReadonlyArray<{
        id: string
        owner: string
        quantities: Record<string, number>
        dimensions: Record<string, string>
        usd: number
      }>
      for (const event of events)
        console.log(
          `metered ${event.dimensions.endpoint} ${event.dimensions.model}: ${JSON.stringify(event.quantities)} → $${event.usd.toFixed(6)} (owner ${event.owner})`
        )
      const endpoints = new Set(events.map((e) => e.dimensions.endpoint))
      for (const endpoint of ["responses", "speech", "realtime"])
        if (!endpoints.has(endpoint)) problems.push(`nothing metered for ${endpoint}`)
      if (events.some((e) => e.owner !== "dream")) problems.push("an event was metered to someone other than Dream")
    }
  } finally {
    await sandbox.kill().catch(() => undefined)
  }
  console.log(problems.length === 0 ? "gateway live check: ok" : `gateway live check FAILED:\n${problems.join("\n")}`)
  if (problems.length > 0) process.exitCode = 1
}

await main()
