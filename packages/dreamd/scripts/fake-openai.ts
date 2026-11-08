/**
 * A stand-in for OpenAI's platform API (`https://api.openai.com/v1`), for checking Dream's OpenAI gateway
 * (apps/api/src/openai/) and the egress rule that carries a project's gateway credential, without an OpenAI key:
 *
 *   - `POST /v1/responses`: a reply with usage, as JSON or (`stream: true`) SSE ending in `response.completed`;
 *     `background: true` answers `queued`, and `GET /v1/responses/:id` then has it `completed`. `GET`, `DELETE`
 *     and `POST …/cancel` on an id it made;
 *   - `POST /v1/chat/completions`: JSON with usage, or SSE with a usage chunk when `stream_options.include_usage`;
 *   - `POST /v1/embeddings`, `/v1/moderations`, `/v1/images/generations`, `/v1/audio/speech` (bytes, or SSE ending
 *     in `speech.audio.done` with `stream_format: "sse"`), `/v1/audio/transcriptions` (token usage, or whisper-1's
 *     duration), `GET /v1/models`;
 *   - realtime: `POST /v1/realtime/client_secrets` mints `ek_fake_…`; `POST /v1/realtime/calls` answers an SDP offer
 *     with 201 and `Location: /v1/realtime/calls/rtc_…`; the WebSocket `/v1/realtime?model=…` answers
 *     `response.create` with a `response.done` carrying usage and `input_audio_buffer.commit` with an input
 *     transcription; `/v1/realtime?call_id=rtc_…` (a sideband) sends one `response.done` and closes, as a call
 *     that ended;
 *   - GPT-Live: `POST /v1/live/sessions` answers 201 with a session id and SDP; the WebSocket `/v1/live/sessions`
 *     answers `session.start` with `session.started` and cumulative `session.usage.updated`, and `session.close`
 *     with `session.closed`; `/v1/live/sessions/:id/attach` sends usage and closes.
 *
 * Every usage is fixed, so a test can check what was metered: responses 1,000 input (600 cached) and 10 output (4
 * reasoning); chat 900 prompt (500 cached) and 20 completion (5 reasoning); realtime 300 input (200 audio, 100
 * cached) and 120 output (100 audio).
 *
 *   node packages/dreamd/scripts/fake-openai.ts [port] [host]     (default 18790, 127.0.0.1)
 *
 * It prints one JSON line per request or WebSocket: method, path, which `Authorization` came (`auth`: a short
 * SHA-256 of the header, `placeholder` when it's `OpenAIGateway.placeholderKey`, never the value), the
 * `originator` and `user-agent`, the model and what it answered; `GET /_fake/requests` returns them all. Node
 * built-ins only, so it runs from anywhere.
 */
import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Duplex } from "node:stream"

const port = Number(process.argv[2] ?? 18790)
const host = process.argv[3] ?? "127.0.0.1"
const placeholderKey = "dream-openai-placeholder"

const usage = {
  responses: {
    input_tokens: 1_000,
    input_tokens_details: { cached_tokens: 600 },
    output_tokens: 10,
    output_tokens_details: { reasoning_tokens: 4 },
    total_tokens: 1_010
  },
  chat: {
    prompt_tokens: 900,
    completion_tokens: 20,
    total_tokens: 920,
    prompt_tokens_details: { cached_tokens: 500, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 5, audio_tokens: 0 }
  },
  realtime: {
    total_tokens: 420,
    input_tokens: 300,
    output_tokens: 120,
    input_token_details: {
      text_tokens: 100,
      audio_tokens: 200,
      image_tokens: 0,
      cached_tokens: 100,
      cached_tokens_details: { text_tokens: 40, audio_tokens: 60, image_tokens: 0 }
    },
    output_token_details: { text_tokens: 20, audio_tokens: 100 }
  }
}

const id = (prefix: string) => `${prefix}_fake_${randomBytes(6).toString("hex")}`
const now = () => Math.floor(Date.now() / 1000)

const authOf = (request: IncomingMessage) => {
  const header = request.headers.authorization
  if (header === undefined) return { auth: null, placeholder: false }
  return {
    auth: createHash("sha256").update(header).digest("hex").slice(0, 12),
    placeholder: header === `Bearer ${placeholderKey}`
  }
}

/** Everything logged, for `GET /_fake/requests` (a check reading what reached it from a sandbox). */
const logged: Array<Record<string, unknown>> = []
const log = (entry: Record<string, unknown>) => {
  const line = { at: new Date().toISOString(), ...entry }
  logged.push(line)
  console.log(JSON.stringify(line))
}

const readBody = (request: IncomingMessage) =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })

const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", "x-request-id": id("req"), ...headers })
  response.end(JSON.stringify(body))
}

const sse = (response: ServerResponse, events: ReadonlyArray<Record<string, unknown>>, named = true) => {
  response.writeHead(200, { "content-type": "text/event-stream", "x-request-id": id("req") })
  let i = 0
  // A little apart, so a gateway that buffered the stream would show it.
  const next = () => {
    if (i >= events.length) {
      if (!named) response.write("data: [DONE]\n\n")
      response.end()
      return
    }
    const event = events[i++]!
    response.write(`${named ? `event: ${String(event.type)}\n` : ""}data: ${JSON.stringify(event)}\n\n`)
    setTimeout(next, 20)
  }
  next()
}

/** Responses made here, so `GET /v1/responses/:id` knows them. */
const responses = new Map<string, Record<string, unknown>>()

const response = (model: string, status: string, extra: Record<string, unknown> = {}) => ({
  id: id("resp"),
  object: "response",
  created_at: now(),
  status,
  model,
  service_tier: "default",
  output:
    status === "completed"
      ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] }]
      : [],
  usage: status === "completed" ? usage.responses : null,
  ...extra
})

type Body = Record<string, unknown> & {
  readonly model?: string
  readonly stream?: boolean
  readonly background?: boolean
  readonly input?: unknown
  readonly stream_format?: string
  readonly stream_options?: { readonly include_usage?: boolean }
}

const parseJson = (raw: Buffer): Body => {
  try {
    return JSON.parse(raw.toString("utf8")) as Body
  } catch {
    return {}
  }
}

const http = async (request: IncomingMessage, res: ServerResponse) => {
  const url = new URL(request.url ?? "/", "http://fake")
  const path = url.pathname.replace(/\/+$/, "")
  if (path === "/_fake/requests") return json(res, 200, logged)
  const raw = await readBody(request)
  const type = request.headers["content-type"] ?? ""
  const body = type.includes("json") ? parseJson(raw) : {}
  const model =
    body.model ?? (type.includes("multipart") ? /name="model"\r\n\r\n([^\r]+)/.exec(raw.toString())?.[1] : undefined)
  const entry = {
    method: request.method,
    path,
    ...authOf(request),
    originator: request.headers.originator ?? null,
    userAgent: request.headers["user-agent"] ?? null,
    model: model ?? null,
    stream: body.stream === true || body.stream_format === "sse",
    store: body.store ?? null,
    includeUsage: body.stream_options?.include_usage ?? null,
    safetyIdentifier: body.safety_identifier ?? null
  }
  log(entry)
  const m = model ?? "gpt-6-luna"

  if (request.method === "GET" && path === "/v1/models")
    return json(res, 200, { object: "list", data: [{ id: "gpt-6-luna", object: "model", owned_by: "openai" }] })

  if (request.method === "POST" && path === "/v1/responses") {
    if (body.background === true) {
      const queued = response(m, "queued", { background: true })
      responses.set(queued.id, { ...queued, status: "completed", usage: usage.responses })
      return json(res, 200, queued)
    }
    const done = response(m, "completed")
    responses.set(done.id, done)
    if (body.stream !== true) return json(res, 200, done)
    return sse(res, [
      { type: "response.created", response: { ...done, status: "in_progress", usage: null } },
      { type: "response.output_text.delta", delta: "hi " },
      { type: "response.output_text.delta", delta: "there" },
      { type: "response.completed", response: done }
    ])
  }
  const one = /^\/v1\/responses\/([^/]+)(\/cancel)?$/.exec(path)
  if (one !== null) {
    const found = responses.get(one[1]!)
    if (found === undefined)
      return json(res, 404, { error: { message: "No response found", type: "invalid_request_error" } })
    if (request.method === "DELETE") {
      responses.delete(one[1]!)
      return json(res, 200, { id: one[1], object: "response", deleted: true })
    }
    return json(res, 200, one[2] === undefined ? found : { ...found, status: "cancelled" })
  }

  if (request.method === "POST" && path === "/v1/chat/completions") {
    const cid = id("chatcmpl")
    const base = { id: cid, object: "chat.completion", created: now(), model: m, service_tier: "default" }
    if (body.stream !== true)
      return json(res, 200, {
        ...base,
        choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
        usage: usage.chat
      })
    const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finish }]
    })
    return sse(
      res,
      [
        chunk({ role: "assistant", content: "hi " }, null),
        chunk({ content: "there" }, "stop"),
        ...(body.stream_options?.include_usage === true
          ? [{ ...base, object: "chat.completion.chunk", choices: [], usage: usage.chat }]
          : [])
      ],
      false
    )
  }

  if (request.method === "POST" && path === "/v1/embeddings")
    return json(res, 200, {
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
      model: m,
      usage: { prompt_tokens: 8, total_tokens: 8 }
    })
  if (request.method === "POST" && path === "/v1/moderations")
    return json(res, 200, { id: id("modr"), model: m, results: [{ flagged: false }] })
  if (request.method === "POST" && (path === "/v1/images/generations" || path === "/v1/images/edits"))
    return json(res, 200, {
      created: now(),
      data: [{ b64_json: "iVBORw0KGgo=" }],
      usage: {
        input_tokens: 50,
        input_tokens_details: { text_tokens: 40, image_tokens: 10 },
        output_tokens: 1_056,
        output_tokens_details: { text_tokens: 0, image_tokens: 1_056 },
        total_tokens: 1_106
      }
    })
  if (request.method === "POST" && path === "/v1/audio/speech") {
    if (body.stream_format === "sse")
      return sse(res, [
        { type: "speech.audio.delta", audio: Buffer.from("fake-audio").toString("base64") },
        { type: "speech.audio.done", usage: { input_tokens: 12, output_tokens: 240, total_tokens: 252 } }
      ])
    res.writeHead(200, { "content-type": "audio/mpeg", "x-request-id": id("req") })
    return res.end(Buffer.alloc(2_048, 1))
  }
  if (request.method === "POST" && (path === "/v1/audio/transcriptions" || path === "/v1/audio/translations"))
    return json(
      res,
      200,
      m === "whisper-1"
        ? { text: "hello", usage: { type: "duration", seconds: 3 } }
        : {
            text: "hello",
            usage: {
              type: "tokens",
              input_tokens: 40,
              input_token_details: { text_tokens: 0, audio_tokens: 40 },
              output_tokens: 3,
              total_tokens: 43
            }
          }
    )

  if (request.method === "POST" && path === "/v1/realtime/client_secrets") {
    const session = (body.session as Record<string, unknown> | undefined) ?? {}
    return json(res, 200, {
      value: id("ek"),
      expires_at: now() + 600,
      session: { type: "realtime", model: session.model ?? "gpt-realtime-2.1", ...session }
    })
  }
  if (request.method === "POST" && path === "/v1/realtime/calls") {
    const call = id("rtc")
    res.writeHead(201, { "content-type": "application/sdp", location: `/v1/realtime/calls/${call}` })
    return res.end("v=0\r\no=- fake answer\r\n")
  }
  if (request.method === "POST" && path === "/v1/live/sessions")
    return json(res, 201, { id: id("sess"), object: "live.session", sdp: "v=0\r\no=- fake answer\r\n" })

  json(res, 404, { error: { message: `fake-openai has no ${request.method} ${path}`, type: "invalid_request_error" } })
}

// ---------------------------------------------------------------------------
// A minimal WebSocket server (RFC 6455: text frames, close, ping), so this stays on Node's built-ins
// ---------------------------------------------------------------------------

interface Socket {
  readonly send: (message: Record<string, unknown>) => void
  readonly close: () => void
}

const frame = (opcode: number, payload: Buffer) => {
  const length = payload.length
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
        : Buffer.concat([
            Buffer.from([0x80 | opcode, 127]),
            Buffer.from(new BigUint64Array([BigInt(length)]).buffer).reverse()
          ])
  return Buffer.concat([head, payload])
}

const accept = (
  request: IncomingMessage,
  socket: Duplex,
  onMessage: (ws: Socket, message: Record<string, unknown>) => void
) => {
  const key = request.headers["sec-websocket-key"] ?? ""
  const digest = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
  const protocol = request.headers["sec-websocket-protocol"]?.split(",")[0]?.trim()
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${digest}`,
      ...(protocol === undefined ? [] : [`Sec-WebSocket-Protocol: ${protocol}`]),
      "",
      ""
    ].join("\r\n")
  )
  let open = true
  const ws: Socket = {
    send: (message) => {
      if (open) socket.write(frame(1, Buffer.from(JSON.stringify(message))))
    },
    close: () => {
      if (!open) return
      open = false
      socket.write(frame(8, Buffer.from([0x03, 0xe8])))
      setTimeout(() => socket.end(), 50)
    }
  }
  let buffer = Buffer.alloc(0)
  socket.on("data", (data: Buffer) => {
    buffer = Buffer.concat([buffer, data])
    while (buffer.length >= 2) {
      const opcode = buffer[0]! & 0x0f
      const masked = (buffer[1]! & 0x80) !== 0
      let length = buffer[1]! & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        offset = 10
      }
      const total = offset + (masked ? 4 : 0) + length
      if (buffer.length < total) return
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined
      const payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total))
      if (mask !== undefined) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!
      buffer = buffer.subarray(total)
      if (opcode === 8) return ws.close()
      if (opcode === 9) socket.write(frame(10, payload))
      if (opcode === 1) {
        try {
          onMessage(ws, JSON.parse(payload.toString("utf8")) as Record<string, unknown>)
        } catch {
          // Not JSON: ignored, as OpenAI would answer with an error event.
        }
      }
    }
  })
  socket.on("error", () => {
    open = false
  })
  return ws
}

const upgrade = (request: IncomingMessage, socket: Duplex) => {
  const url = new URL(request.url ?? "/", "http://fake")
  const path = url.pathname.replace(/\/+$/, "")
  log({
    method: "WEBSOCKET",
    path,
    query: url.search,
    ...authOf(request),
    protocol: request.headers["sec-websocket-protocol"] ?? null,
    originator: request.headers.originator ?? null,
    userAgent: request.headers["user-agent"] ?? null
  })

  if (path === "/v1/realtime") {
    const callId = url.searchParams.get("call_id")
    const model = url.searchParams.get("model") ?? "gpt-realtime-2.1"
    const session = { id: id("sess"), object: "realtime.session", type: "realtime", model }
    const done = (responseId = id("resp")) => ({
      type: "response.done",
      event_id: id("event"),
      response: { id: responseId, object: "realtime.response", status: "completed", usage: usage.realtime }
    })
    const ws = accept(request, socket, (ws, message) => {
      log({ method: "WS-MESSAGE", path, type: message.type })
      if (message.type === "response.create") {
        const responseId = id("resp")
        ws.send({ type: "response.created", response: { id: responseId, status: "in_progress" } })
        ws.send({ type: "response.output_text.delta", delta: "hi" })
        ws.send(done(responseId))
      }
      if (message.type === "input_audio_buffer.commit")
        ws.send({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: id("item"),
          transcript: "hello",
          usage: {
            type: "tokens",
            input_tokens: 30,
            output_tokens: 2,
            total_tokens: 32,
            input_token_details: { audio_tokens: 30, text_tokens: 0 }
          }
        })
    })
    ws.send({ type: "session.created", session })
    if (callId !== null) {
      // A sideband: the call's events, then the call ends.
      setTimeout(() => ws.send(done()), 300)
      setTimeout(() => ws.close(), 900)
    }
    return
  }

  const attach = /^\/v1\/live\/sessions\/([^/]+)\/attach$/.exec(path)
  if (path === "/v1/live/sessions" || attach !== null) {
    const sessionId = attach?.[1] ?? id("sess")
    let seconds = 0
    const ws = accept(request, socket, (ws, message) => {
      log({ method: "WS-MESSAGE", path, type: message.type })
      if (message.type === "session.start") {
        ws.send({ type: "session.started", session: { id: sessionId, model: "gpt-live-1" } })
        seconds = 4
        ws.send({ type: "session.usage.updated", usage: { seconds } })
      }
      if (message.type === "session.close") {
        seconds = 6.5
        ws.send({ type: "session.closed", session: { id: sessionId }, usage: { seconds } })
        ws.close()
      }
    })
    if (attach !== null) {
      setTimeout(() => ws.send({ type: "session.usage.updated", usage: { seconds: 5 } }), 300)
      setTimeout(() => {
        ws.send({ type: "session.closed", session: { id: sessionId }, usage: { seconds: 9 } })
        ws.close()
      }, 900)
    }
    return
  }

  socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
}

createServer((request, response) => {
  http(request, response).catch((error: unknown) => {
    log({ error: String(error) })
    if (!response.headersSent) json(response, 500, { error: { message: "fake-openai failed" } })
  })
})
  .on("upgrade", upgrade)
  .listen(port, host, () => console.log(`fake OpenAI API on http://${host}:${port}`))
