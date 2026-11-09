/**
 * Finishing an access request on a computer, with real email: the Worker's own code (router, DesktopAccess, the
 * ProjectDO on node:sqlite, providers faked, as in the tests), but mail goes out through Cloudflare Email Service's
 * REST API from dream@mail.<domain>, so the email, its rendering and its link can be checked in a real inbox and
 * browser before the Worker is deployed. No live project or account is touched.
 *
 *   node apps/api/scripts/desktop-check.ts <inbox address> <public base URL of this port> [port]
 *
 * Expose the port (`ol expose 8792`) and pass that URL, so the emailed link opens this process. Sends with the
 * workspace's Cloudflare credentials (CLOUDFLARE_ACCOUNT_ID; the token comes from the ambient connection).
 * It signs the inbox's owner in, creates a project, asks for a Stripe key and emails the link, then serves:
 *   the desktop pages (/desktop…), as the Worker does
 *   POST /check/send     email a new link for the same request
 *   GET  /check/card     the card as the phone sees it
 *   POST /check/expire   ages every link and session past its end
 */
import { createServer } from "node:http"
import { type AccessMessage, DaemonEnvFile, type ProjectId } from "@dream/domain"
import { Effect, Layer, Redacted, type Scope } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type { SendEmailBinding } from "../src/email/Mailer.ts"
import { route } from "../src/http/Router.ts"
import { makeCloud } from "../test/support/Cloud.ts"

const [inbox, base, portArg] = process.argv.slice(2)
if (inbox === undefined || base === undefined)
  throw new Error("usage: desktop-check.ts <inbox> <public base URL> [port]")
const port = Number(portArg ?? 8792)
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "2d98de7c4511e98d2f774c4fcc9b9b93"
const say = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`)

/** The binding's call, made over REST: the same message the Worker would send. */
const rest: SendEmailBinding = {
  send: async (message) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_API_TOKEN !== "anything" ? process.env.CLOUDFLARE_API_TOKEN : "from-connection"}`
      },
      body: JSON.stringify({ ...message, from: { address: message.from.email, name: message.from.name } })
    })
    const body = await response.text()
    say(`send → ${response.status} ${body.slice(0, 300)}`)
    if (!response.ok) throw Object.assign(new Error("send failed"), { code: `HTTP_${response.status}` })
    return body
  }
}

const host = new URL(base).host
const cloud = await Effect.runPromise(
  makeCloud({ domain: "omer.build", apiHost: host, apiUrl: base.replace(/\/$/, "") }, { email: rest })
)
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))
const text = (body: string) => new TextEncoder().encode(body)

const signedIn = await run(cloud.phone.DevSignIn({ email: inbox, secret: Redacted.make("dev-secret") }))
cloud.session.token = Redacted.value(signedIn.sessionToken)
// A Claude connection, as the tests make one, so the project can start.
const connect = await run(cloud.phone.CreateConnectLink({ provider: "claude" }))
const connectRequest = new Request(`${base.replace(/\/$/, "")}/connect/claude`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ t: new URL(connect.url).searchParams.get("t")!, token: `sk-ant-oat01-${"c".repeat(80)}` })
})
await run(
  route(connectRequest).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(connectRequest)),
    Effect.provide(Layer.succeedContext(cloud.workerContext))
  )
)
const project = await run(cloud.phone.CreateProject({ idea: "A shop for my prints." }))
await run(cloud.alarm(project.id))
const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === project.id)!
const env = Object.fromEntries(
  sandbox.files
    .get(DaemonEnvFile)!
    .trim()
    .split("\n")
    .map((line) => [line.slice(0, line.indexOf("=")), JSON.parse(line.slice(line.indexOf("=") + 1))])
) as Record<string, string>
const dreamd = await run(cloud.sandbox(env.DREAM_PROJECT_TOKEN!))
const request = await run(
  dreamd.RequestAccess({
    request: {
      _tag: "Key",
      service: "Stripe",
      host: "api.stripe.com",
      header: "Authorization",
      format: "Bearer {key}"
    },
    why: "Take payments for the prints",
    context: "Make a **restricted key** at [Stripe's API keys page](https://dashboard.stripe.com/apikeys)."
  })
)
const ref = { projectId: project.id as ProjectId, messageId: request.id }
const card = () =>
  run(cloud.phone.ListMessages({ projectId: project.id })).then(({ messages }) =>
    messages.find((m): m is AccessMessage => m.id === request.id)
  )

const send = () => run(cloud.phone.EmailAccessLink(ref).pipe(Effect.result))
say(`first send: ${JSON.stringify(await send())}`)

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", base)
  try {
    if (url.pathname === "/check/send" && req.method === "POST") {
      res.end(text(JSON.stringify(await send())))
      return
    }
    if (url.pathname === "/check/card") {
      res.end(text(JSON.stringify(await card())))
      return
    }
    if (url.pathname === "/check/expire" && req.method === "POST") {
      cloud.db.prepare("UPDATE desktop_links SET expires_at_ms = 1, session_expires_at_ms = 1").run()
      res.end(text("expired"))
      return
    }
    const chunks: Array<Uint8Array> = []
    for await (const chunk of req as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk)
    const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    chunks.reduce((at, c) => (body.set(c, at), at + c.length), 0)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v)
    const raw = new Request(url, {
      method: req.method ?? "GET",
      headers,
      ...(req.method === "GET" || req.method === "HEAD" ? {} : { body })
    })
    const response = await run(
      route(raw).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
        Effect.provide(Layer.succeedContext(cloud.workerContext))
      )
    )
    const web = HttpServerResponse.toWeb(response)
    // Paths only: the token never reaches a URL, and this log is where it would show if it did.
    say(`${req.method} ${url.pathname}${url.search === "" ? "" : "?…"} → ${web.status}`)
    res.writeHead(web.status, Object.fromEntries(web.headers))
    res.end(new Uint8Array(await web.arrayBuffer()))
  } catch (error) {
    say(`error ${String(error)}`)
    res.writeHead(500, {})
    res.end()
  }
}).listen(port, "0.0.0.0", () => say(`listening on ${port} for ${base}`))
