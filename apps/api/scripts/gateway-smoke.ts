/**
 * A few real calls through Dream's AI gateway (src/openai/), run in Node against the in-memory control plane
 * (test/support/Cloud.ts) and a real OpenAI, to check what OpenAI actually sends against what the gateway reads:
 * a Responses call, a Responses stream, a short speech, and a tiny realtime exchange over a WebSocket, then what the
 * ledger recorded for each and what it priced them at. About a cent in all.
 *
 *   OPENAI_API_URL=https://api.openai.com node apps/api/scripts/gateway-smoke.ts
 *
 * The key comes from `OPENAI_API_KEY`, or, when that's unset, from an egress proxy that adds it to requests for
 * OpenAI's host (a workspace connection); point `OPENAI_API_URL` at a fake (packages/dreamd/scripts/fake-openai.ts)
 * for a dry run. Also attaches the WebRTC sideband to `SIDEBAND_CALL=rtc_…` (a call started elsewhere), if given.
 */
import { Context, Effect, Layer, Option, Redacted } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { Tokens } from "../src/auth/Tokens.ts"
import { UpstreamFailure } from "@dream/domain"
import { openaiGateway } from "../src/openai/Gateway.ts"
import type { Socket } from "../src/openai/Realtime.ts"
import { OpenAIUpstream } from "../src/openai/Runtime.ts"
import { attachSideband } from "../src/openai/Sideband.ts"
import { makeCloud } from "../test/support/Cloud.ts"

const apiUrl = process.env.OPENAI_API_URL ?? "https://api.openai.com"
const key = process.env.OPENAI_API_KEY ?? "sk-added-by-the-egress-proxy"

/** One end of an in-memory socket pair: the gateway's end of the app's WebSocket. */
class MemorySocket implements Socket {
  peer: MemorySocket | undefined
  closed = false
  private readonly listeners: Record<string, Array<(event: never) => void>> = { message: [], close: [], error: [] }
  readonly send = (data: string | ArrayBuffer) => queueMicrotask(() => this.peer?.emit("message", { data }))
  readonly close = (code = 1000, reason = "") => {
    if (this.closed) return
    this.closed = true
    this.emit("close", { code, reason })
    this.peer?.close(code, reason)
  }
  readonly addEventListener = (type: string, listener: (event: never) => void) => {
    this.listeners[type]?.push(listener)
  }
  emit(type: string, event: unknown) {
    for (const listener of this.listeners[type] ?? []) listener(event as never)
  }
}

const served: { app: MemorySocket | undefined } = { app: undefined }

interface NodeSocket {
  readonly send: (data: string | ArrayBuffer) => void
  readonly close: (code?: number, reason?: string) => void
  readonly addEventListener: (type: string, listener: (event: unknown) => void) => void
}

/** Node's fetch and WebSocket (undici's, which takes headers), and an in-memory socket for the app. */
const nodeUpstream = Layer.succeed(
  OpenAIUpstream,
  OpenAIUpstream.of({
    fetch: (request) =>
      Effect.tryPromise({
        try: () => fetch(request),
        catch: (cause) => new UpstreamFailure({ service: "OpenAI", message: String(cause) })
      }),
    connect: (url, headers) =>
      Effect.tryPromise({
        try: () =>
          new Promise<{ socket: Socket; protocol: string | undefined }>((resolve, reject) => {
            const { "sec-websocket-protocol": _, ...rest } = headers
            // Node's WebSocket (undici's) takes headers, unlike the browser's.
            const ws = new (WebSocket as unknown as new (url: string, init: object) => NodeSocket)(
              url.replace(/^http/, "ws"),
              { headers: rest }
            )
            ws.addEventListener("open", () =>
              resolve({
                socket: {
                  send: (data) => ws.send(data),
                  close: (code, reason) => ws.close(code, reason),
                  addEventListener: (type, listener) => ws.addEventListener(type, listener as never)
                },
                protocol: undefined
              })
            )
            ws.addEventListener("error", (event) =>
              reject(new Error(String((event as { message?: string }).message ?? "error")))
            )
          }),
        catch: (cause) => new UpstreamFailure({ service: "OpenAI", message: String(cause) })
      }),
    serve: Effect.sync(() => {
      const gateway = new MemorySocket()
      const app = new MemorySocket()
      gateway.peer = app
      app.peer = gateway
      served.app = app
      return { socket: gateway, response: () => new Response(null, { status: 200 }) }
    })
  })
)

const program = Effect.gen(function* () {
  const cloud = yield* makeCloud(
    { aiGatewayEnabled: true, openaiApiKey: Option.some(Redacted.make(key)), openaiApiUrl: apiUrl },
    { openaiUpstream: nodeUpstream }
  )
  const signedIn = yield* cloud.phone.DevSignIn({
    email: "smoke@example.com",
    name: "Smoke",
    secret: Redacted.make("dev-secret")
  })
  // A project, made as the phone would (the fakes stand in for Claude's sign-in).
  cloud.session.token = Redacted.value(signedIn.sessionToken)
  const claudeUrl = "https://claude.com/cai/oauth/authorize?code=true&client_id=x&response_type=code&state=abc"
  cloud.world.scripts.set("claude setup-token", [
    { _tag: "Output", text: `Use the url below\r\n${claudeUrl}\r\n` },
    { _tag: "Output", text: "Paste code here if prompted > " }
  ])
  const started = yield* cloud.phone.StartModelConnection({ provider: "claude" })
  cloud.world.attachOutput = [
    {
      _tag: "Output",
      text: "Long-lived authentication token created successfully!\r\nYour OAuth token (valid for 1 year):\r\n"
    },
    { _tag: "Output", text: `sk-ant-oat01-${"x".repeat(60)}\r\n` }
  ]
  yield* cloud.phone.CompleteModelConnection({ connectionId: started.connection.id, code: Redacted.make("code#state") })
  const projectId = (yield* cloud.phone.CreateProject({ idea: "A gateway smoke test." })).id
  const tokens = Context.get(cloud.workerContext, Tokens)
  const credential = Redacted.value(yield* tokens.openaiGateway(projectId, signedIn.user.id))
  const call = (path: string, init: RequestInit & { readonly json?: unknown } = {}) =>
    Effect.gen(function* () {
      const request = new Request(`https://openai.dream.test${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${credential}`,
          ...(init.json === undefined ? {} : { "content-type": "application/json" }),
          ...(init.headers as Record<string, string> | undefined)
        },
        ...(init.json === undefined ? {} : { method: "POST", body: JSON.stringify(init.json) })
      })
      const response = yield* openaiGateway(request).pipe(Effect.provide(Layer.succeedContext(cloud.workerContext)))
      return HttpServerResponse.toWeb(response)
    })

  const show = (label: string, response: Response, body: string) =>
    console.log(`${label}: ${response.status} ${body.replace(/\s+/g, " ").slice(0, 160)}`)

  const model = process.env.SMOKE_MODEL ?? "gpt-5-nano"
  const one = yield* call("/v1/responses", { json: { model, input: "Say hi in two words.", max_output_tokens: 32 } })
  show("responses", one, yield* Effect.promise(() => one.text()))

  const stream = yield* call("/v1/responses", {
    json: { model, input: "Say hello in three words.", max_output_tokens: 32, stream: true }
  })
  const streamed = yield* Effect.promise(() => stream.text())
  show("stream", stream, `${streamed.split("\n\n").length} events, ends ${streamed.slice(-120)}`)

  const speech = yield* call("/v1/audio/speech", {
    json: { model: process.env.SMOKE_TTS ?? "gpt-4o-mini-tts", input: "Hello from Dream.", voice: "alloy" }
  })
  show("speech", speech, `${(yield* Effect.promise(() => speech.arrayBuffer())).byteLength} bytes`)

  const realtimeModel = process.env.SMOKE_REALTIME ?? "gpt-realtime-2.1-mini"
  const socket = yield* call(`/v1/realtime?model=${realtimeModel}`, { headers: { upgrade: "websocket" } })
  console.log(`realtime socket: ${socket.status}`)
  if (served.app !== undefined) {
    const app = served.app
    const done = yield* Effect.promise(
      () =>
        new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve("timeout"), 20_000)
          app.addEventListener("message", (event: { readonly data: string }) => {
            const message = JSON.parse(event.data) as { type: string; error?: unknown }
            if (message.type === "error") console.log(`realtime error: ${JSON.stringify(message.error)}`)
            if (message.type === "response.done") {
              clearTimeout(timer)
              resolve("response.done")
            }
          })
          app.send(
            JSON.stringify({
              type: "response.create",
              response: { output_modalities: ["text"], instructions: "Say hi.", max_output_tokens: 16 }
            })
          )
        })
    )
    console.log(`realtime: ${done}`)
    app.close()
  }

  const callId = process.env.SIDEBAND_CALL
  if (callId !== undefined) {
    yield* attachSideband({
      kind: "realtime",
      id: callId,
      projectId,
      userId: signedIn.user.id,
      model: realtimeModel
    }).pipe(Effect.provide(Layer.succeedContext(cloud.workerContext)))
    console.log(`sideband attached to ${callId}; waiting 60 s for the call`)
    yield* Effect.sleep("60 seconds")
  }

  yield* Effect.sleep("1 second")
  const rows = cloud.db
    .prepare(
      "SELECT id, quantities_json, dimensions_json, cost_usd FROM meter_events WHERE meter = 'model_request' ORDER BY rowid"
    )
    .all() as ReadonlyArray<Record<string, string | number>>
  for (const row of rows) {
    const dimensions = JSON.parse(String(row.dimensions_json)) as Record<string, string>
    console.log(
      `metered ${dimensions.endpoint} ${dimensions.model ?? "?"}${dimensions.estimated === "true" ? " (estimated)" : ""}: ` +
        `${row.quantities_json} → $${Number(row.cost_usd).toFixed(6)}`
    )
  }
  yield* cloud.close
})

await Effect.runPromise(Effect.scoped(program))
process.exit(0)
