/**
 * Dream's OpenAI gateway (src/openai/), end to end against a fake OpenAI: who may call it, what it forwards and
 * refuses, whose key it uses, and what it meters, from JSON bodies, streams, realtime sockets and WebRTC calls.
 */
import { assert, describe, it } from "@effect/vitest"
import { DaemonEnvFile, OpenAIGateway, type ProjectId, type UserId } from "@dream/domain"
import { Context, Effect, Layer, Option, Redacted } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { Tokens } from "../src/auth/Tokens.ts"
import { SandboxCredentials } from "../src/integrations/SandboxCredentials.ts"
import { routeOf } from "../src/openai/Endpoints.ts"
import { openaiGateway, sweepBackgroundResponses } from "../src/openai/Gateway.ts"
import { sessionMeter, type Socket } from "../src/openai/Realtime.ts"
import { OpenAIUpstream, type SidebandRequest } from "../src/openai/Runtime.ts"
import { fromEvent, fromJson } from "../src/openai/Usage.ts"
import { makeCloud } from "./support/Cloud.ts"

// ---------------------------------------------------------------------------
// A fake OpenAI
// ---------------------------------------------------------------------------

interface Seen {
  readonly method: string
  readonly url: string
  readonly auth: string | null
  readonly headers: Record<string, string>
  readonly body: string
}

class FakeSocket implements Socket {
  peer: FakeSocket | undefined
  closed = false
  private readonly listeners: Record<string, Array<(event: never) => void>> = { message: [], close: [], error: [] }
  readonly send = (data: string | ArrayBuffer) => {
    queueMicrotask(() => this.peer?.emit("message", { data }))
  }
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

const pair = () => {
  const a = new FakeSocket()
  const b = new FakeSocket()
  a.peer = b
  b.peer = a
  return [a, b] as const
}

const realtimeUsage = {
  input_tokens: 300,
  output_tokens: 120,
  input_token_details: { audio_tokens: 200, cached_tokens: 100, cached_tokens_details: { audio_tokens: 60 } },
  output_token_details: { audio_tokens: 100 }
}

const fakeOpenAI = () => {
  const seen: Array<Seen> = []
  const sockets: Array<{ url: string; headers: Record<string, string> }> = []
  /** The app's end of the last socket the gateway served. */
  const served: { app: FakeSocket | undefined } = { app: undefined }
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-request-id": `req_${seen.length}`, ...headers }
    })
  const sse = (events: ReadonlyArray<unknown>, named: boolean) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const event of events)
            controller.enqueue(
              new TextEncoder().encode(
                `${named ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`
              )
            )
          if (!named) controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
          controller.close()
        }
      }),
      { headers: { "content-type": "text/event-stream", "x-request-id": "req_stream" } }
    )
  const responsesUsage = {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 600 },
    output_tokens: 10,
    output_tokens_details: { reasoning_tokens: 4 }
  }
  const stored = new Map<string, unknown>()

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const body = request.method === "GET" ? "" : await request.text()
    const headers: Record<string, string> = {}
    request.headers.forEach((value, name) => {
      headers[name] = value
    })
    seen.push({ method: request.method, url: request.url, auth: request.headers.get("authorization"), headers, body })
    const parsed = (() => {
      try {
        return JSON.parse(body) as Record<string, any>
      } catch {
        return {} as Record<string, any>
      }
    })()
    const path = url.pathname
    if (path === "/v1/responses") {
      const id = `resp_${seen.length}`
      if (parsed.background === true) {
        stored.set(id, { id, status: "completed", model: parsed.model, usage: responsesUsage })
        return json({ id, status: "queued", model: parsed.model, usage: null })
      }
      const done = {
        id,
        object: "response",
        status: "completed",
        model: parsed.model,
        service_tier: "default",
        usage: responsesUsage
      }
      stored.set(id, done)
      if (parsed.stream === true)
        return sse(
          [
            { type: "response.created", response: { ...done, status: "in_progress", usage: null } },
            { type: "response.output_text.delta", delta: "hi" },
            { type: "response.completed", response: done }
          ],
          true
        )
      return json(done)
    }
    const one = /^\/v1\/responses\/([^/]+)$/.exec(path)
    if (one !== null) return stored.has(one[1]!) ? json(stored.get(one[1]!)) : json({ error: {} }, 404)
    if (path === "/v1/chat/completions") {
      const base = { id: "chatcmpl_1", model: parsed.model }
      const usage = { prompt_tokens: 900, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 500 } }
      if (parsed.stream !== true) return json({ ...base, choices: [{ message: { content: "hi" } }], usage })
      return sse(
        [
          { ...base, choices: [{ delta: { content: "hi" } }] },
          ...(parsed.stream_options?.include_usage === true ? [{ ...base, choices: [], usage }] : [])
        ],
        false
      )
    }
    if (path === "/v1/audio/speech")
      return new Response(new Uint8Array(64), {
        headers: { "content-type": "audio/mpeg", "x-request-id": `req_speech_${seen.length}` }
      })
    if (path === "/v1/audio/transcriptions")
      return json({
        text: "hello",
        usage: { type: "tokens", input_tokens: 40, input_token_details: { audio_tokens: 40 }, output_tokens: 3 }
      })
    if (path === "/v1/embeddings") return json({ model: parsed.model, usage: { prompt_tokens: 8 } })
    if (path === "/v1/realtime/client_secrets")
      return json({ value: "ek_real_secret", expires_at: Math.floor(Date.now() / 1000) + 600, session: parsed.session })
    if (path === "/v1/realtime/calls")
      return new Response("v=0 answer", {
        status: 201,
        headers: { "content-type": "application/sdp", location: "/v1/realtime/calls/rtc_abc123" }
      })
    if (path === "/v1/live/sessions") return json({ id: "sess_live1", sdp: "v=0" }, 201)
    return json({ error: { message: "nope" } }, 404)
  }

  const layer = Layer.succeed(
    OpenAIUpstream,
    OpenAIUpstream.of({
      fetch: (request) => Effect.promise(() => handle(request)),
      connect: (url, headers) =>
        Effect.sync(() => {
          sockets.push({ url, headers })
          const [gateway, openai] = pair()
          openai.addEventListener("message", (event: { readonly data: string }) => {
            const message = JSON.parse(event.data) as { type: string }
            if (message.type === "response.create")
              openai.send(JSON.stringify({ type: "response.done", response: { id: "resp_rt1", usage: realtimeUsage } }))
            if (message.type === "input_audio_buffer.commit")
              openai.send(
                JSON.stringify({
                  type: "conversation.item.input_audio_transcription.completed",
                  item_id: "item_1",
                  usage: { type: "duration", seconds: 2.5 }
                })
              )
          })
          queueMicrotask(() =>
            openai.send(
              JSON.stringify({
                type: "session.created",
                session: {
                  model: "gpt-realtime-2.1",
                  audio: { input: { transcription: { model: "gpt-4o-mini-transcribe" } } }
                }
              })
            )
          )
          return { socket: gateway, protocol: undefined }
        }),
      serve: Effect.sync(() => {
        const [gateway, app] = pair()
        served.app = app
        return { socket: gateway, response: () => new Response(null, { status: 200, headers: { "x-upgraded": "1" } }) }
      })
    })
  )
  return { seen, sockets, served, layer }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const claudeUrl =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"

const setup = (options: { readonly enabled?: boolean; readonly key?: boolean } = {}) =>
  Effect.gen(function* () {
    const fake = fakeOpenAI()
    const sidebands: Array<SidebandRequest> = []
    const cloud = yield* makeCloud(
      {
        aiGatewayEnabled: options.enabled ?? true,
        ...(options.key === false ? { openaiApiKey: Option.none() } : {})
      },
      {
        openaiUpstream: fake.layer,
        attachSideband: (request) => Effect.sync(() => void sidebands.push(request))
      }
    )
    const signedIn = yield* cloud.phone.DevSignIn({
      email: "omer@example.com",
      name: "Omer",
      secret: Redacted.make("dev-secret")
    })
    cloud.session.token = Redacted.value(signedIn.sessionToken)
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
    yield* cloud.phone.CompleteModelConnection({
      connectionId: started.connection.id,
      code: Redacted.make("code#state")
    })
    const project = yield* cloud.phone.CreateProject({ idea: "A private podcast read in my voice." })
    const other = yield* cloud.phone.CreateProject({ idea: "A voice tutor for Arabic." })
    const tokens = Context.get(cloud.workerContext, Tokens)
    const credential = (projectId: ProjectId) =>
      Effect.map(tokens.openaiGateway(projectId, signedIn.user.id), Redacted.value)
    const call = (
      path: string,
      init: {
        readonly method?: string
        readonly body?: BodyInit
        readonly headers?: Record<string, string>
        readonly projectId?: ProjectId
        readonly auth?: string | null
      } = {}
    ) =>
      Effect.gen(function* () {
        const auth = init.auth === undefined ? `Bearer ${yield* credential(init.projectId ?? project.id)}` : init.auth
        const request = new Request(`https://openai.dream.test${path}`, {
          method: init.method ?? (init.body === undefined ? "GET" : "POST"),
          headers: { ...(auth === null ? {} : { authorization: auth }), ...(init.headers ?? {}) },
          ...(init.body === undefined ? {} : { body: init.body })
        })
        const response = yield* openaiGateway(request).pipe(Effect.provide(Layer.succeedContext(cloud.workerContext)))
        return HttpServerResponse.toWeb(response)
      })
    /** What the ledger recorded (`meter_events`), priced by its price book. */
    const events = Effect.gen(function* () {
      // Metering runs after the response; let it.
      yield* Effect.sleep("50 millis")
      return (
        cloud.db
          .prepare(
            "SELECT id, owner, meter, quantities_json, dimensions_json, center, cost_usd FROM meter_events ORDER BY rowid"
          )
          .all() as ReadonlyArray<Record<string, string | number>>
      )
        .filter((row) => row.meter === "model_request")
        .map((row) => ({
          id: String(row.id),
          owner: String(row.owner),
          meter: String(row.meter),
          center: String(row.center),
          usd: Number(row.cost_usd),
          quantities: JSON.parse(String(row.quantities_json)) as Record<string, number>,
          dimensions: JSON.parse(String(row.dimensions_json)) as Record<string, string>
        }))
    })
    return { cloud, fake, project, other, user: signedIn.user, call, events, sidebands, credential }
  })

const post = (body: unknown) => ({ body: JSON.stringify(body), headers: { "content-type": "application/json" } })

// ---------------------------------------------------------------------------

describe("the OpenAI gateway", () => {
  it.live("says it isn't configured when it's on without Dream's key", () =>
    Effect.gen(function* () {
      const { call, cloud } = yield* setup({ key: false })
      const response = yield* call("/v1/models")
      assert.strictEqual(response.status, 503)
      assert.include(((yield* Effect.promise(() => response.json())) as any).error.message, "isn't configured")
      yield* cloud.close
    })
  )

  it.live("is a 404 while it's off", () =>
    Effect.gen(function* () {
      const { call, cloud } = yield* setup({ enabled: false })
      const response = yield* call("/v1/models")
      assert.strictEqual(response.status, 404)
      yield* cloud.close
    })
  )

  it.live("takes only the project's credential, refuses Codex and what it doesn't forward", () =>
    Effect.gen(function* () {
      const { call, cloud, fake } = yield* setup()
      const placeholder = yield* call("/v1/models", { auth: `Bearer ${OpenAIGateway.placeholderKey}` })
      assert.strictEqual(placeholder.status, 401)
      assert.include(((yield* Effect.promise(() => placeholder.json())) as any).error.message, "on the way out")
      const files = yield* call("/v1/files")
      assert.strictEqual(files.status, 404)
      assert.include(((yield* Effect.promise(() => files.json())) as any).error.message, "shared by every project")
      const codex = yield* call("/v1/responses", {
        ...post({ model: "gpt-6-luna" }),
        headers: { originator: "codex_cli_rs" }
      })
      assert.strictEqual(codex.status, 403)
      const models = yield* call("/v1/models")
      assert.strictEqual(models.status, 404) // the fake has none, but it got there with Dream's key
      assert.strictEqual(fake.seen.at(-1)?.auth, "Bearer sk-dream-test")
      assert.strictEqual(fake.seen.length, 1)
      yield* cloud.close
    })
  )

  it.live("meters a Responses call, keeps its id for this project, and adds a safety identifier", () =>
    Effect.gen(function* () {
      const { call, cloud, fake, events, project, other, user } = yield* setup()
      const response = yield* call("/v1/responses", post({ model: "gpt-6-luna", input: "hi" }))
      assert.strictEqual(response.status, 200)
      const body = (yield* Effect.promise(() => response.json())) as { id: string }
      const sent = JSON.parse(fake.seen.at(-1)!.body)
      assert.match(sent.safety_identifier, /^[0-9a-f]{32}$/)
      assert.strictEqual(fake.seen.at(-1)!.auth, "Bearer sk-dream-test")
      const metered = yield* events
      assert.deepStrictEqual(
        metered.map((e) => ({
          id: e.id,
          owner: e.owner,
          meter: e.meter,
          center: e.center,
          q: e.quantities,
          d: e.dimensions
        })),
        [
          {
            id: `openai:${body.id}`,
            owner: user.id,
            meter: "model_request",
            center: "models",
            q: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 10, reasoning_tokens: 4 },
            d: {
              project: project.id,
              payer: "dream",
              provider: "openai",
              endpoint: "responses",
              model: "gpt-6-luna",
              service_tier: "default"
            }
          }
        ]
      )
      // Priced by the ledger's book, from the tokens as OpenAI nests them: 400 fresh, 600 cached in, 10 out.
      assert.closeTo(metered[0]!.usd, (400 * 0.1 + 600 * 0.01 + 10 * 0.5) / 1e6, 1e-12)
      const again = yield* call(`/v1/responses/${body.id}`)
      assert.strictEqual(again.status, 200)
      yield* Effect.promise(() => again.text())
      assert.strictEqual((yield* call(`/v1/responses/${body.id}`, { projectId: other.id })).status, 404)
      // Read back, it's the same transaction: still one event.
      assert.strictEqual((yield* events).length, 1)
      yield* cloud.close
    })
  )

  it.live("passes a stream through as it comes and meters its last event", () =>
    Effect.gen(function* () {
      const { call, cloud, events } = yield* setup()
      const response = yield* call("/v1/responses", post({ model: "gpt-6-luna", input: "hi", stream: true }))
      const text = yield* Effect.promise(() => response.text())
      assert.include(text, "event: response.created")
      assert.include(text, "event: response.completed")
      const metered = yield* events
      assert.strictEqual(metered.length, 1)
      assert.strictEqual(metered[0]!.quantities.input_tokens, 1000)
      const id = /"id":"(resp_\d+)"/.exec(text)![1]!
      assert.strictEqual((yield* call(`/v1/responses/${id}`)).status, 200)
      yield* cloud.close
    })
  )

  it.live("never stores a chat completion, and asks for usage without showing it to an app that didn't", () =>
    Effect.gen(function* () {
      const { call, cloud, fake, events } = yield* setup()
      const response = yield* call(
        "/v1/chat/completions",
        post({ model: "gpt-5-mini", stream: true, store: true, messages: [] })
      )
      const text = yield* Effect.promise(() => response.text())
      const sent = JSON.parse(fake.seen.at(-1)!.body)
      assert.strictEqual(sent.store, false)
      assert.strictEqual(sent.stream_options.include_usage, true)
      assert.notInclude(text, "prompt_tokens")
      assert.include(text, "[DONE]")
      const metered = yield* events
      assert.deepStrictEqual(metered[0]?.quantities, { input_tokens: 900, cached_input_tokens: 500, output_tokens: 20 })
      assert.strictEqual(metered[0]?.dimensions.endpoint, "chat")
      assert.strictEqual(metered[0]?.id, "openai:chatcmpl_1")
      const asked = yield* call(
        "/v1/chat/completions",
        post({ model: "gpt-5-mini", stream: true, stream_options: { include_usage: true }, messages: [] })
      )
      assert.include(yield* Effect.promise(() => asked.text()), "prompt_tokens")
      assert.strictEqual(fake.seen.at(-1)?.url.includes("/v1/chat/completions"), true)
      assert.strictEqual((yield* call("/v1/chat/completions")).status, 404)
      yield* cloud.close
    })
  )

  it.live("estimates speech from its input, and reads transcription's model from the form", () =>
    Effect.gen(function* () {
      const { call, cloud, events } = yield* setup()
      const speech = yield* call("/v1/audio/speech", post({ model: "tts-1", input: "Hello there", voice: "alloy" }))
      assert.strictEqual((yield* Effect.promise(() => speech.arrayBuffer())).byteLength, 64)
      const voiced = yield* call(
        "/v1/audio/speech",
        post({ model: "gpt-4o-mini-tts", input: "Hello there", voice: "marin" })
      )
      yield* Effect.promise(() => voiced.arrayBuffer())
      const form = new FormData()
      form.set("model", "gpt-4o-mini-transcribe")
      form.set("file", new Blob([new Uint8Array(10)]), "a.wav")
      const transcribed = yield* call("/v1/audio/transcriptions", { body: form })
      assert.strictEqual(transcribed.status, 200)
      // Metered once the app has read it.
      assert.include(yield* Effect.promise(() => transcribed.text()), "hello")
      const metered = yield* events
      assert.deepStrictEqual(
        metered.map((e) => [e.dimensions.endpoint, e.dimensions.model, e.quantities, e.dimensions.estimated]),
        [
          ["speech", "tts-1", { characters: 11 }, "true"],
          [
            "speech",
            "gpt-4o-mini-tts",
            { characters: 11, input_tokens: 3, output_tokens: 15, output_audio_tokens: 15 },
            "true"
          ],
          [
            "transcription",
            "gpt-4o-mini-transcribe",
            { input_tokens: 40, input_audio_tokens: 40, output_tokens: 3 },
            undefined
          ]
        ]
      )
      yield* cloud.close
    })
  )

  it.live("wraps client secrets, and a browser's WebRTC call with one goes through it and gets a sideband", () =>
    Effect.gen(function* () {
      const { call, cloud, fake, sidebands, project } = yield* setup()
      const minted = yield* call(
        "/v1/realtime/client_secrets",
        post({ session: { type: "realtime", model: "gpt-realtime-2.1" } })
      )
      const secret = ((yield* Effect.promise(() => minted.json())) as { value: string }).value
      assert.match(secret, /^dream_ek_/)
      assert.notInclude(secret, "ek_real_secret")
      // The browser: no Dream credential, just the wrapped secret.
      const offer = yield* call("/v1/realtime/calls", {
        body: "v=0 offer",
        headers: { "content-type": "application/sdp" },
        auth: `Bearer ${secret}`
      })
      assert.strictEqual(offer.status, 201)
      assert.strictEqual(offer.headers.get("access-control-allow-origin"), "*")
      assert.strictEqual(fake.seen.at(-1)?.auth, "Bearer ek_real_secret")
      yield* Effect.sleep("20 millis")
      assert.deepStrictEqual(sidebands, [
        {
          kind: "realtime",
          id: "rtc_abc123",
          projectId: project.id,
          userId: sidebands[0]!.userId,
          model: "gpt-realtime-2.1"
        }
      ])
      // Elsewhere a client secret opens nothing.
      assert.strictEqual((yield* call("/v1/models", { auth: `Bearer ${secret}` })).status, 401)
      assert.strictEqual((yield* call("/v1/realtime/calls", { body: "x", auth: "Bearer dream_ek_forged" })).status, 401)
      // A GPT-Live WebRTC session from the app's server gets one too; phone calls are refused.
      assert.strictEqual(
        (yield* call(
          "/v1/live/sessions",
          post({ session: { model: "gpt-live-1" }, transport: { type: "webrtc", sdp: "v=0" } })
        )).status,
        201
      )
      yield* Effect.sleep("20 millis")
      assert.strictEqual(sidebands.at(-1)?.kind, "live")
      assert.strictEqual(sidebands.at(-1)?.id, "sess_live1")
      assert.strictEqual(
        (yield* call("/v1/live/sessions", post({ session: { model: "gpt-live-1" }, transport: { type: "sip" } })))
          .status,
        400
      )
      yield* cloud.close
    })
  )

  it.live("proxies a realtime WebSocket and meters each response and input transcription", () =>
    Effect.gen(function* () {
      const { call, cloud, fake, events } = yield* setup()
      const response = yield* call("/v1/realtime?model=gpt-realtime-2.1", { headers: { upgrade: "websocket" } })
      assert.strictEqual(response.headers.get("x-upgraded"), "1")
      assert.strictEqual(fake.sockets[0]?.url, "https://api.openai.test/v1/realtime?model=gpt-realtime-2.1")
      assert.strictEqual(fake.sockets[0]?.headers.authorization, "Bearer sk-dream-test")
      const app = fake.served.app!
      const received: Array<string> = []
      app.addEventListener("message", (event: { readonly data: string }) => received.push(event.data))
      app.send(JSON.stringify({ type: "response.create" }))
      app.send(JSON.stringify({ type: "input_audio_buffer.commit" }))
      yield* Effect.sleep("20 millis")
      app.close()
      const metered = yield* events
      assert.isTrue(received.some((r) => r.includes("response.done")))
      // 60 text, 140 audio and 40 + 60 cached in; 20 text and 100 audio out, at gpt-realtime-2.1's prices.
      assert.closeTo(metered[0]!.usd, (60 * 4 + 140 * 32 + 40 * 0.4 + 60 * 0.4 + 20 * 24 + 100 * 64) / 1e6, 1e-12)
      assert.deepStrictEqual(
        metered.map((e) => [e.id, e.dimensions.model, e.quantities]),
        [
          [
            "openai:resp_rt1",
            "gpt-realtime-2.1",
            {
              input_tokens: 300,
              cached_input_tokens: 100,
              input_audio_tokens: 200,
              cached_audio_tokens: 60,
              output_tokens: 120,
              output_audio_tokens: 100
            }
          ],
          ["openai:item_1:transcription", "gpt-4o-mini-transcribe", { audio_ms: 2500 }]
        ]
      )
      yield* cloud.close
    })
  )

  it.live("meters a background response nobody polled to the end", () =>
    Effect.gen(function* () {
      const { call, cloud, events } = yield* setup()
      const response = yield* call("/v1/responses", post({ model: "gpt-6-luna", input: "hi", background: true }))
      const { id } = (yield* Effect.promise(() => response.json())) as { id: string }
      assert.strictEqual((yield* events).length, 0)
      // Two minutes on, the sweep looks.
      cloud.db.prepare("UPDATE openai_objects SET created_at_ms = created_at_ms - 180000").run()
      yield* sweepBackgroundResponses.pipe(Effect.provide(Layer.succeedContext(cloud.workerContext)))
      const metered = yield* events
      assert.deepStrictEqual(
        metered.map((e) => e.id),
        [`openai:${id}`]
      )
      yield* sweepBackgroundResponses.pipe(Effect.provide(Layer.succeedContext(cloud.workerContext)))
      assert.strictEqual((yield* events).length, 1)
      yield* cloud.close
    })
  )

  it.live("puts the gateway's credential in egress and its address in dreamd's env only while it's on", () =>
    Effect.gen(function* () {
      for (const enabled of [true, false]) {
        const { cloud, project, user, credential } = yield* setup({ enabled })
        const setupFor = Context.get(cloud.workerContext, SandboxCredentials)
        const rules = (yield* setupFor.setup(user.id as UserId, "claude-code", project.id)).rules
        const rule = rules["openai.dream.test"]
        if (enabled)
          assert.deepStrictEqual(rule, [
            { transform: { headers: { Authorization: `Bearer ${yield* credential(project.id)}` } } }
          ])
        else assert.isUndefined(rule)
        yield* cloud.alarm(project.id)
        const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === project.id)
        const env = sandbox?.files.get(DaemonEnvFile) ?? ""
        assert.strictEqual(env.includes("DREAM_OPENAI_BASE_URL"), enabled)
        if (enabled) assert.include(env, "https://openai.dream.test/v1")
        yield* cloud.close
      }
    })
  )
})

describe("reading usage", () => {
  it("covers every endpoint's shape", () => {
    assert.deepStrictEqual(fromJson({ id: "x", usage: { type: "duration", seconds: 3 } })[0]?.quantities, {
      audio_ms: 3000
    })
    assert.deepStrictEqual(
      fromJson({
        created: 1,
        usage: {
          input_tokens: 50,
          input_tokens_details: { image_tokens: 10 },
          output_tokens: 1056,
          output_tokens_details: { image_tokens: 1056 }
        }
      })[0]?.quantities,
      { input_tokens: 50, input_image_tokens: 10, output_tokens: 1056, output_image_tokens: 1056 }
    )
    const withTools = fromJson({
      id: "resp_1",
      usage: { input_tokens: 5, output_tokens: 1 },
      tool_usage: { web_search: { num_requests: 2 }, image_gen: { input_tokens: 3, output_tokens: 4 } }
    })
    assert.deepStrictEqual(
      withTools.map((u) => [u.id, u.quantities]),
      [
        ["resp_1", { input_tokens: 5, output_tokens: 1, web_search_calls: 2 }],
        ["resp_1:image_gen", { input_tokens: 3, output_tokens: 4 }]
      ]
    )
    assert.deepStrictEqual(
      fromEvent({ type: "speech.audio.done", usage: { input_tokens: 12, output_tokens: 240 } })[0]?.quantities,
      {
        input_tokens: 12,
        output_tokens: 240
      }
    )
    assert.deepStrictEqual(fromEvent({ type: "response.output_text.delta", delta: "x" }), [])
    assert.deepStrictEqual(fromJson("not json"), [])
  })

  it("meters a GPT-Live session once, from its last count", () => {
    const meter = sessionMeter("live", {})
    meter.onMessage(JSON.stringify({ type: "session.started", session: { id: "sess_1", model: "gpt-live-1" } }))
    meter.onMessage(JSON.stringify({ type: "session.usage.updated", usage: { seconds: 4 } }))
    const closed = meter.onMessage(JSON.stringify({ type: "session.closed", usage: { seconds: 6.5 } }))
    assert.deepStrictEqual(
      closed.map((c) => [c.endpoint, c.usage.id, c.usage.quantities]),
      [["live", "sess_1", { session_ms: 6500 }]]
    )
    assert.deepStrictEqual(meter.onEnd(10_000), [])
    const cut = sessionMeter("live", { id: "sess_2" })
    cut.onMessage(JSON.stringify({ type: "session.usage.updated", usage: { seconds: 3 } }))
    assert.deepStrictEqual(cut.onEnd(9_000)[0]?.usage.quantities, { session_ms: 3000 })
  })

  it("estimates a sideband's call that reported no usage by its length", () => {
    const meter = sessionMeter("realtime", { id: "rtc_1", estimateDuration: true })
    assert.deepStrictEqual(
      meter.onEnd(61_000).map((c) => [c.usage.quantities, c.usage.estimated]),
      [[{ session_ms: 61_000 }, true]]
    )
  })

  it("routes only what it supports", () => {
    assert.strictEqual(routeOf("POST", "/responses", false).kind, "create-response")
    assert.strictEqual(routeOf("GET", "/responses/resp_abc", false).kind, "owned")
    assert.strictEqual(routeOf("POST", "/responses/resp_abc", false).kind, "refused")
    assert.strictEqual(routeOf("GET", "/realtime", true).kind, "realtime-socket")
    assert.strictEqual(routeOf("GET", "/live/sessions", true).kind, "live-socket")
    for (const [method, path] of [
      ["GET", "/files"],
      ["POST", "/vector_stores"],
      ["GET", "/conversations/conv_1"],
      ["POST", "/batches"],
      ["GET", "/organization/usage/completions"],
      ["POST", "/videos"],
      ["POST", "/audio/voices"]
    ] as const)
      assert.strictEqual(routeOf(method, path, false).kind, "refused", path)
  })
})
