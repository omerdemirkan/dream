/**
 * A stand-in for Dream's Worker, for checking notifications from apps end to end with a real sandbox
 * (`packages/sandbox-template/scripts/notify-check.ts`). It runs the control plane's own code, as the tests do:
 * the Worker's `SandboxRpcs` handlers and the ProjectDO on node:sqlite, with E2B, APNs and the model faked. So no
 * project, account or phone is touched, and no model is called.
 *
 *   node apps/api/scripts/notify-standin.ts [port]      (default 8791; expose it so E2B can reach it)
 *
 * It signs a person in, creates one project, and serves:
 *   POST /sandbox/rpc     dreamd's SandboxRpcs, with that project's token
 *   GET  /check/project   { projectId, token, publicUrl }
 *   POST /check/allow     "Allow" on the project's open Notifications card, as the phone does
 *   GET  /check/pushes    the APNs payloads it would have sent for apps' notifications
 *   GET  /check/history   what the phone's Notifications sheet would show (GetAppNotifications)
 *   GET  /check/events    the agent events the project queued for dreamd (the stand-in never delivers them)
 */
import { createServer } from "node:http"
import { type AgentEvent, DaemonEnvFile } from "@dream/domain"
import { Effect, Redacted } from "effect"
import { type AlertPush, alertPayload } from "../src/push/Apns.ts"
import { makeCloud } from "../test/support/Cloud.ts"

const port = Number(process.argv[2] ?? 8791)
const stamp = () => new Date().toISOString().slice(11, 19)
const say = (line: string) => console.log(`${stamp()} ${line}`)

const claudeUrl =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"

const cloud = await Effect.runPromise(makeCloud())
const phone = cloud.phone
const signedIn = await Effect.runPromise(
  phone.DevSignIn({ email: "check@example.com", secret: Redacted.make("dev-secret") })
)
cloud.session.token = Redacted.value(signedIn.sessionToken)
await Effect.runPromise(
  phone.RegisterDevice({
    deviceId: "8f14e45f-ceea-4e7b-9a0c-6a3f1b2c3d4e" as never,
    apnsToken: "simulator-device-token",
    timeZone: "America/Los_Angeles"
  })
)
// A model connection the fakes accept; nothing calls a model.
cloud.world.scripts.set("claude setup-token", [
  { _tag: "Output", text: `Use the url below\r\n${claudeUrl}\r\n` },
  { _tag: "Output", text: "Paste code here if prompted > " }
])
const started = await Effect.runPromise(phone.StartModelConnection({ provider: "claude" }))
cloud.world.attachOutput = [
  { _tag: "Output", text: "Long-lived authentication token created successfully!\r\n" },
  { _tag: "Output", text: `sk-ant-oat01-${"x".repeat(60)}\r\n` }
]
await Effect.runPromise(
  phone.CompleteModelConnection({ connectionId: started.connection.id, code: Redacted.make("code#state") })
)
const project = await Effect.runPromise(phone.CreateProject({ idea: "Tell me when flights to Lisbon get cheap." }))
await Effect.runPromise(cloud.alarm(project.id))
const fake = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === project.id)!
const tokenLine = fake.files
  .get(DaemonEnvFile)!
  .split("\n")
  .find((l) => l.startsWith("DREAM_PROJECT_TOKEN="))!
const token = JSON.parse(tokenLine.slice("DREAM_PROJECT_TOKEN=".length)) as string

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json" } })

const route = async (request: Request): Promise<Response> => {
  const path = new URL(request.url).pathname
  if (path === "/sandbox/rpc") {
    const response = await cloud.sandboxHandler(request)
    say(`dreamd → ${response.status}`)
    return response
  }
  if (path === "/check/project") return json({ projectId: project.id, token, publicUrl: project.publicUrl })
  if (path === "/check/allow" && request.method === "POST") {
    const messages = await Effect.runPromise(phone.ListMessages({ projectId: project.id }))
    const card = messages.messages.find(
      (m) => m._tag === "Access" && m.request._tag === "Notifications" && m.state._tag === "Open"
    )
    if (card === undefined) return json({ error: "no open Notifications card" }, 404)
    const allowed = await Effect.runPromise(phone.AllowAppNotifications({ projectId: project.id, messageId: card.id }))
    say(`allowed ${card.id}`)
    return json(allowed)
  }
  if (path === "/check/pushes") {
    return json(
      cloud.world.pushes
        .filter((p) => p.kind === "alert" && (p.payload as AlertPush).category === "app")
        .map((p) => ({ token: p.token, payload: alertPayload(p.payload as AlertPush) }))
    )
  }
  if (path === "/check/history") {
    return json(await Effect.runPromise(phone.GetAppNotifications({ projectId: project.id })))
  }
  if (path === "/check/events") {
    await Effect.runPromise(cloud.alarm(project.id))
    return json(cloud.world.delivered.flatMap((d) => d.events as ReadonlyArray<AgentEvent>).map((e) => e._tag))
  }
  return json({ error: "not found" }, 404)
}

createServer(async (req, res) => {
  const chunks: Array<Uint8Array> = []
  for await (const chunk of req) chunks.push(chunk)
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  chunks.reduce((offset, c) => (body.set(c, offset), offset + c.length), 0)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value)
  }
  const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
    ...(req.method === "GET" || req.method === "HEAD" ? {} : { body })
  })
  const response = await route(request).catch((error) => json({ error: String(error) }, 500))
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(new Uint8Array(await response.arrayBuffer()))
}).listen(port, "0.0.0.0", () => say(`stand-in Worker on :${port}, project ${project.id}`))
