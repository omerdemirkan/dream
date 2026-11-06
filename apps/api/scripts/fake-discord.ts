/**
 * The fake Discord from the tests (`test/support/FakeDiscord.ts`), served over real HTTP and WebSockets, for an
 * end-to-end check of a relay running in workerd (`scripts/relay-probe.ts`). Runs under Bun, which has a WebSocket
 * server built in:
 *
 *   bun apps/api/scripts/fake-discord.ts [port] [token] [public host]     (default 8791, "fake-bot-token")
 *
 * Expose the port publicly; a relay then needs DISCORD_API_URL=https://<host>/api/v10 and DISCORD_GATEWAY_HOST=<host>.
 * The Gateway is at wss://<host>/ (resuming at the same host). Controls, for the check to drive it:
 *
 *   POST /control/message  {"content", "mentionsBot"?}   a MESSAGE_CREATE on the newest session
 *   POST /control/drop                                     drop every line (as a network failure: 1006)
 *   POST /control/reconnect                                op 7
 *   POST /control/invalidate {"resumable"}                 op 9
 *   GET  /control/state                                    connected lines, sessions, and what clients did
 */
import { FakeDiscord, type GatewayConnection } from "../test/support/FakeDiscord.ts"

declare const Bun: {
  serve: (options: unknown) => { readonly port: number }
}

interface Socket {
  send: (text: string) => void
  close: (code?: number, reason?: string) => void
  data: { receive?: (text: string) => void; closed?: () => void }
}

const port = Number(process.argv[2] ?? 8791)
const token = process.argv[3] ?? "fake-bot-token"
const publicHost = process.argv[4]
let discord: FakeDiscord | undefined

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** The fake learns its public host from the first request, so it can name its Gateway URL. */
const fakeFor = (request: Request) => {
  if (discord !== undefined) return discord
  const host = publicHost ?? request.headers.get("x-forwarded-host") ?? new URL(request.url).host
  discord = new FakeDiscord({
    token,
    gatewayUrl: `wss://${host}`,
    resumeUrl: `wss://${host}`,
    heartbeatInterval: 41_250
  })
  return discord
}

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`)

Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(request: Request, server: { upgrade: (request: Request, options: unknown) => boolean }) {
    const url = new URL(request.url)
    const fake = fakeFor(request)
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      log(`gateway connect ${url.search}`)
      return server.upgrade(request, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 })
    }
    if (url.pathname.endsWith("/gateway/bot")) {
      const answer = fake.gatewayBot(request.headers.get("authorization") ?? undefined)
      log(`GET /gateway/bot -> ${answer.status}`)
      return json(answer.body, answer.status)
    }
    if (url.pathname === "/control/state") {
      return json({
        connected: fake.connected,
        sessions: [...fake.sessions.values()].map((session) => ({ id: session.id, seq: session.seq })),
        calls: fake.calls.filter((call) => !call.startsWith("heartbeat")),
        heartbeats: fake.calls.filter((call) => call.startsWith("heartbeat")).length
      })
    }
    if (request.method === "POST" && url.pathname.startsWith("/control/")) {
      const body = (await request.json().catch(() => ({}))) as {
        content?: string
        mentionsBot?: boolean
        resumable?: boolean
      }
      switch (url.pathname) {
        case "/control/message": {
          const seq = fake.message(body.content ?? "hello", { mentionsBot: body.mentionsBot === true })
          log(`dispatched MESSAGE_CREATE ${seq} "${body.content}" (${fake.connected} connected)`)
          return json({ seq })
        }
        case "/control/drop":
          fake.drop()
          log("dropped every line")
          return json({ ok: true })
        case "/control/reconnect":
          fake.requestReconnect()
          return json({ ok: true })
        case "/control/invalidate":
          fake.invalidate(body.resumable === true)
          return json({ ok: true })
      }
    }
    return new Response("not found", { status: 404 })
  },
  websocket: {
    open(ws: Socket) {
      const connection: GatewayConnection = {
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason)
      }
      const opened = fakeFor(new Request("http://localhost/")).open(connection)
      ws.data.receive = opened.receive
      ws.data.closed = opened.closed
    },
    message(ws: Socket, message: string | Uint8Array) {
      ws.data.receive?.(typeof message === "string" ? message : new TextDecoder().decode(message))
    },
    close(ws: Socket, code: number) {
      log(`gateway line closed by the client (${code})`)
      ws.data.closed?.()
    }
  }
})
log(`fake Discord on :${port}`)
