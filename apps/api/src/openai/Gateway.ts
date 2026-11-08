/**
 * Dream's AI gateway, `https://openai.<domain>/v1` (`OpenAIGateway`): the apps the agent builds call OpenAI's API
 * here with any OpenAI SDK, and Dream forwards each call with its own key (`OPENAI_API_KEY`) and meters it to the
 * project (docs/metering.md, "The AI gateway"). A person's own OpenAI key never comes here: their apps use it
 * against api.openai.com directly, through its egress rule, as before.
 *
 * - **Who's calling.** The sandbox holds a placeholder; its egress rule for this host replaces `Authorization` with
 *   the project's gateway credential (`Tokens.openaiGateway`), checked here. The one exception is a browser starting
 *   a WebRTC call (`POST /v1/realtime/calls`) or a realtime WebSocket with a client secret its app minted through
 *   the gateway, which is a Dream secret (`ClientSecrets`), not OpenAI's.
 * - **What's forwarded.** The allowlist in `Endpoints.ts`; stored responses and sessions only for the project that
 *   made them (`Objects.ts`). Codex's own requests are refused: the harnesses run on the person's subscription.
 * - **Metering.** From what comes back, as it goes by (`Sse.ts`, `Usage.ts`, `Realtime.ts`), through `Meter`.
 *   Metering never fails a call.
 */
import type { ProjectId, UserId } from "@dream/domain"
import { Clock, DateTime, Duration, Effect, Option, Redacted } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { Tokens } from "../auth/Tokens.ts"
import { ApiConfig } from "../Config.ts"
import { Projects } from "../db/Projects.ts"
import { toHex, utf8 } from "../lib/Bytes.ts"
import { Meter, type MeterEvent } from "../metering/Meter.ts"
import { ClientSecrets, WrappedPrefix } from "./ClientSecrets.ts"
import { type MeteredEndpoint, type Route, routeOf } from "./Endpoints.ts"
import { type ObjectKind, OpenAIObjects } from "./Objects.ts"
import { bridge, sessionMeter } from "./Realtime.ts"
import { AfterResponse, CallSideband, OpenAIUpstream } from "./Runtime.ts"
import { observe } from "./Sse.ts"
import {
  asSpeech,
  type Caller,
  createdResponseId,
  fromEvent,
  fromJson,
  speechEstimate,
  toEvent,
  type Usage
} from "./Usage.ts"

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** An error the way OpenAI writes them, so SDKs show the message. */
const problem = (status: number, message: string, code: string, headers: Record<string, string> = {}) =>
  HttpServerResponse.jsonUnsafe(
    { error: { message, type: status === 401 ? "authentication_error" : "invalid_request_error", code } },
    { status, headers }
  )

/** Where a browser may call from: anywhere, since the wrapped secret is what's checked. */
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, openai-beta",
  "access-control-expose-headers": "location, x-request-id",
  "access-control-max-age": "600"
}

/** Is this Codex itself (its model traffic, realtime or onboarding), rather than an app? */
export const isCodex = (headers: Headers) =>
  /^codex/i.test(headers.get("originator") ?? "") || /^codex_/i.test(headers.get("user-agent") ?? "")

const dropRequest = new Set([
  "host",
  "authorization",
  "cookie",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
  "openai-organization",
  "openai-project",
  "x-real-ip",
  "true-client-ip",
  "originator",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol"
])

const forwardHeaders = (incoming: Headers, auth: Redacted.Redacted<string>, extra: Record<string, string> = {}) => {
  const headers = new Headers()
  incoming.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (dropRequest.has(lower) || lower.startsWith("cf-") || lower.startsWith("x-forwarded-")) return
    headers.set(name, value)
  })
  headers.set("authorization", `Bearer ${Redacted.value(auth)}`)
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  return headers
}

const backHeaders = (upstream: Headers, extra: Record<string, string> = {}) => {
  const headers = new Headers()
  upstream.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (lower === "set-cookie" || lower === "content-length" || lower === "transfer-encoding" || lower === "connection")
      return
    headers.set(name, value)
  })
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  return headers
}

/** A stable, opaque per-project id for OpenAI's abuse checks on Dream's key (`safety_identifier`). */
const safetyIdentifier = (projectId: string) =>
  Effect.promise(async () =>
    toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(`dream-openai:${projectId}`)))).slice(0, 32)
  )

const parseJson = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined)

// ---------------------------------------------------------------------------
// Who's calling
// ---------------------------------------------------------------------------

interface Authorized {
  readonly caller: Caller
  /** What OpenAI gets as the bearer: the key, or (a browser's call) OpenAI's client secret. */
  readonly auth: Redacted.Redacted<string>
  /** The model a client secret was minted for. */
  readonly model?: string | undefined
  /** Came with a wrapped client secret, from a browser. */
  readonly browser: boolean
}

const projectCache = new Map<ProjectId, { readonly ownerId: UserId | null; readonly atMs: number }>()
const ProjectCacheMs = 60_000

const bearerOf = (headers: Headers) => {
  const match = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "")
  return match?.[1]
}

/** A browser's realtime WebSocket carries its key as a subprotocol, `openai-insecure-api-key.<key>`. */
const protocolKey = (headers: Headers) =>
  (headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((p) => p.trim())
    .find((p) => p.startsWith("openai-insecure-api-key."))
    ?.slice("openai-insecure-api-key.".length)

const authorize = (raw: Request, route: Route) =>
  Effect.gen(function* () {
    const tokens = yield* Tokens
    const projects = yield* Projects
    const secrets = yield* ClientSecrets
    const bearer = bearerOf(raw.headers) ?? (route.kind === "realtime-socket" ? protocolKey(raw.headers) : undefined)
    if (bearer === undefined) return yield* Effect.fail(noCredential)

    if (bearer.startsWith(WrappedPrefix) && (route.kind === "realtime-call" || route.kind === "realtime-socket")) {
      const claims = yield* secrets
        .unwrap(bearer, yield* Clock.currentTimeMillis)
        .pipe(Effect.mapError(() => problem(401, "This client secret is invalid or expired.", "invalid_client_secret")))
      return {
        caller: { projectId: claims.projectId, userId: claims.userId },
        auth: Redacted.make(claims.secret),
        model: claims.model,
        browser: true
      } satisfies Authorized
    }

    const claims = yield* tokens.verifyOpenAIGateway(bearer).pipe(Effect.mapError(() => noCredential))
    const now = yield* Clock.currentTimeMillis
    let cached = projectCache.get(claims.projectId)
    if (cached === undefined || now - cached.atMs > ProjectCacheMs) {
      const project = yield* projects.find(claims.projectId)
      cached = { ownerId: Option.match(project, { onNone: () => null, onSome: (p) => p.ownerId }), atMs: now }
      projectCache.set(claims.projectId, cached)
    }
    if (cached.ownerId !== claims.userId)
      return yield* Effect.fail(problem(401, "This project no longer exists.", "project_gone"))
    return {
      caller: { projectId: claims.projectId, userId: claims.userId },
      auth: yield* dreamKey,
      browser: false
    } satisfies Authorized
  })

/** Dream's key, which every call through the gateway uses. */
const dreamKey = Effect.gen(function* () {
  const config = yield* ApiConfig
  if (Option.isSome(config.openaiApiKey)) return config.openaiApiKey.value
  return yield* Effect.fail(
    problem(503, "Dream's AI gateway isn't configured on this deployment yet (it has no OpenAI key).", "not_configured")
  )
})

const noCredential = problem(
  401,
  "This request reached Dream's OpenAI gateway without its credential. Dream adds it on the way out of the " +
    "project's sandbox, so call the gateway from there, with any API key (OPENAI_API_KEY as it's set works).",
  "missing_dream_credential"
)

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

type Services =
  | ApiConfig
  | Tokens
  | Projects
  | OpenAIObjects
  | ClientSecrets
  | Meter
  | OpenAIUpstream
  | AfterResponse
  | CallSideband

/** Runs effects from callbacks (stream observers, socket listeners), and keeps the request alive until they're done. */
const tracker = Effect.gen(function* () {
  const context = yield* Effect.context<Services>()
  const after = yield* AfterResponse
  const run = Effect.runPromiseWith(context)
  const pending: Array<Promise<unknown>> = []
  const spawn = (effect: Effect.Effect<void, never, Services>) => {
    pending.push(
      run(effect.pipe(Effect.catchCause((cause) => Effect.logWarning("openai gateway: background work failed", cause))))
    )
  }
  /** Registers `done` (and everything spawned until it settles) as work after the response. */
  const until = (done: Promise<unknown>) =>
    after.run(
      Effect.promise(async () => {
        await done
        // What `done` spawned on its way.
        for (let i = 0; i < pending.length; i++) await pending[i]
      })
    )
  return { spawn, until }
})

/** `effect` after the response, with this request's services. */
const later = <R extends Services>(effect: Effect.Effect<void, never, R>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    yield* (yield* AfterResponse).run(Effect.provideContext(effect, context))
  })

const meter = (
  caller: Caller,
  endpoint: MeteredEndpoint,
  usages: ReadonlyArray<Usage>,
  fallback: { readonly requestId: string; readonly model?: string | undefined }
) =>
  Effect.gen(function* () {
    if (usages.length === 0) return
    const at = yield* DateTime.now
    const events: Array<MeterEvent> = usages.map((usage) =>
      toEvent(caller, endpoint, endpoint === "speech" ? asSpeech(usage) : usage, { ...fallback, at })
    )
    yield* (yield* Meter).record(events)
    if (endpoint === "responses") {
      const objects = yield* OpenAIObjects
      for (const usage of usages) if (usage.id?.startsWith("resp_") === true) yield* objects.markMetered(usage.id)
    }
  })

const requestIdOf = (response: Response) =>
  response.headers.get("x-request-id") ?? `dream_${crypto.randomUUID().replaceAll("-", "")}`

const own = (caller: Caller, id: string, kind: ObjectKind, background: boolean) =>
  Effect.gen(function* () {
    const objects = yield* OpenAIObjects
    yield* objects.record({
      id,
      projectId: caller.projectId,
      ownerId: caller.userId,
      kind,
      background,
      nowMs: yield* Clock.currentTimeMillis
    })
  })

/**
 * Passes `response` on while metering what it says. JSON bodies and event streams are watched as they go by;
 * `estimate` meters a body that says nothing (speech audio). `onData` sees each event too.
 */
const metered = (
  response: Response,
  caller: Caller,
  endpoint: MeteredEndpoint | undefined,
  options: {
    readonly model?: string | undefined
    readonly estimate?: Usage | undefined
    readonly onData?: (data: unknown, spawn: (effect: Effect.Effect<void, never, Services>) => void) => void
    readonly drop?: (data: unknown) => boolean
    readonly headers?: Record<string, string>
  } = {}
) =>
  Effect.gen(function* () {
    const headers = backHeaders(response.headers, options.headers)
    const type = response.headers.get("content-type") ?? ""
    const kind = type.includes("text/event-stream") ? "sse" : type.includes("json") ? "json" : undefined
    if (endpoint === undefined || response.status >= 400 || response.body === null || kind === undefined) {
      if (endpoint !== undefined && response.ok && options.estimate !== undefined)
        yield* later(
          meter(caller, endpoint, [options.estimate], { requestId: requestIdOf(response), model: options.model })
        )
      return HttpServerResponse.raw(new Response(response.body, { status: response.status, headers }))
    }
    const { spawn, until } = yield* tracker
    const usages: Array<Usage> = []
    const requestId = requestIdOf(response)
    let finish: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const body = observe(
      response.body,
      kind,
      {
        onData: (data) => {
          const found = kind === "json" ? fromJson(data) : fromEvent(data)
          usages.push(...found)
          options.onData?.(data, spawn)
        },
        onEnd: () => {
          const all = usages.length === 0 && options.estimate !== undefined ? [options.estimate] : usages
          spawn(meter(caller, endpoint, all, { requestId, model: options.model }))
          finish()
        }
      },
      options.drop
    )
    yield* until(done)
    return HttpServerResponse.raw(new Response(body, { status: response.status, headers }))
  })

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

const upstreamUrl = (config: ApiConfig["Service"], path: string, search = "") =>
  `${config.openaiApiUrl.replace(/\/+$/, "")}/v1${path}${search}`

const send = (request: Request) =>
  Effect.gen(function* () {
    const upstream = yield* OpenAIUpstream
    return yield* upstream
      .fetch(request)
      .pipe(Effect.mapError((failure) => problem(502, failure.message, "openai_unreachable")))
  })

/** A JSON request's body, with Dream's changes (`edit`), as the text to send. */
const jsonBody = (raw: Request) =>
  Effect.map(
    Effect.promise(() => raw.text()),
    (text) => ({ text, json: parseJson(text) })
  )

const withSafety = (caller: Caller, json: Record<string, unknown>) =>
  Effect.gen(function* () {
    if (json.safety_identifier !== undefined) return json
    return { ...json, safety_identifier: yield* safetyIdentifier(caller.projectId) }
  })

const isTerminal = (status: unknown) =>
  status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled"

const createResponse = (raw: Request, path: string, search: string, who: Authorized) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const { text, json } = yield* jsonBody(raw)
    const body = json === undefined ? text : JSON.stringify(yield* withSafety(who.caller, json))
    const background = json?.background === true
    const stored = json?.store !== false
    const model = str(json?.model)
    const response = yield* send(
      new Request(upstreamUrl(config, path, search), {
        method: "POST",
        headers: forwardHeaders(raw.headers, who.auth, { "content-type": "application/json" }),
        body
      })
    )
    const type = response.headers.get("content-type") ?? ""
    if (response.ok && type.includes("json") && !type.includes("event-stream")) {
      // Small, and its id must be this project's before the app can ask for it again (a background poll).
      const answer = yield* Effect.promise(() => response.text())
      const parsed = parseJson(answer)
      const id = str(parsed?.id)
      if (id !== undefined && (stored || background)) yield* own(who.caller, id, "response", background)
      if (parsed !== undefined && isTerminal(parsed.status))
        yield* later(meter(who.caller, "responses", fromJson(parsed), { requestId: requestIdOf(response), model }))
      return HttpServerResponse.raw(
        new Response(answer, { status: response.status, headers: backHeaders(response.headers) })
      )
    }
    return yield* metered(response, who.caller, "responses", {
      model,
      onData: (data, spawn) => {
        const id = createdResponseId(data)
        if (id !== undefined && (stored || background)) spawn(own(who.caller, id, "response", background))
      }
    })
  })

const chat = (raw: Request, path: string, search: string, who: Authorized) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const { text, json } = yield* jsonBody(raw)
    if (json === undefined) {
      const response = yield* send(
        new Request(upstreamUrl(config, path, search), {
          method: "POST",
          headers: forwardHeaders(raw.headers, who.auth),
          body: text
        })
      )
      return yield* metered(response, who.caller, "chat")
    }
    const stream = json.stream === true
    const options = typeof json.stream_options === "object" && json.stream_options !== null ? json.stream_options : {}
    const asked = (options as { include_usage?: unknown }).include_usage === true
    // Never stored: the stored-completions list would show every project's to every other.
    const edited = {
      ...(yield* withSafety(who.caller, json)),
      store: false,
      ...(stream ? { stream_options: { ...options, include_usage: true } } : {})
    }
    const response = yield* send(
      new Request(upstreamUrl(config, path, search), {
        method: "POST",
        headers: forwardHeaders(raw.headers, who.auth, { "content-type": "application/json" }),
        body: JSON.stringify(edited)
      })
    )
    return yield* metered(response, who.caller, "chat", {
      model: str(json.model),
      // The usage chunk Dream asked for, which an app that didn't may not expect.
      ...(stream && !asked
        ? {
            drop: (data: unknown) => {
              const chunk = data as { readonly choices?: ReadonlyArray<unknown>; readonly usage?: unknown }
              return Array.isArray(chunk.choices) && chunk.choices.length === 0 && chunk.usage != null
            }
          }
        : {})
    })
  })

const forward = (
  raw: Request,
  path: string,
  search: string,
  who: Authorized,
  route: Extract<Route, { readonly kind: "forward" }>
) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const url = upstreamUrl(config, path, search)
    if (route.body === "none") {
      const response = yield* send(
        new Request(url, { method: raw.method, headers: forwardHeaders(raw.headers, who.auth) })
      )
      return yield* metered(response, who.caller, route.endpoint)
    }
    if (route.body === "form") {
      const form = yield* Effect.tryPromise({
        try: () => raw.formData(),
        catch: () => problem(400, "Expected a multipart/form-data body.", "invalid_body")
      })
      const headers = forwardHeaders(raw.headers, who.auth)
      // fetch writes the multipart boundary itself.
      headers.delete("content-type")
      const model = str(form.get("model"))
      const response = yield* send(new Request(url, { method: "POST", headers, body: form }))
      return yield* metered(response, who.caller, route.endpoint, { model })
    }
    const { text, json } = yield* jsonBody(raw)
    const model = str(json?.model)
    const input = str(json?.input)
    const response = yield* send(
      new Request(url, { method: "POST", headers: forwardHeaders(raw.headers, who.auth), body: text })
    )
    return yield* metered(response, who.caller, route.endpoint, {
      model,
      ...(route.endpoint === "speech" && input !== undefined ? { estimate: speechEstimate(model, input) } : {})
    })
  })

const owned = (
  raw: Request,
  path: string,
  search: string,
  who: Authorized,
  route: Extract<Route, { readonly kind: "owned" }>
) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const objects = yield* OpenAIObjects
    let owner = yield* objects.projectOf(route.id)
    // A stream's id is recorded as it goes by, a moment after the app saw it.
    if (Option.isNone(owner)) {
      yield* Effect.sleep(Duration.seconds(1))
      owner = yield* objects.projectOf(route.id)
    }
    if (Option.isNone(owner) || owner.value !== who.caller.projectId)
      return problem(404, `No ${route.id} was made by this project through Dream.`, "not_found")
    const hasBody = raw.method === "POST"
    const response = yield* send(
      new Request(upstreamUrl(config, path, search), {
        method: raw.method,
        headers: forwardHeaders(raw.headers, who.auth),
        ...(hasBody ? { body: yield* Effect.promise(() => raw.text()) } : {})
      })
    )
    return yield* metered(response, who.caller, route.endpoint)
  })

const clientSecret = (raw: Request, path: string, search: string, who: Authorized) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const secrets = yield* ClientSecrets
    const { text } = yield* jsonBody(raw)
    const extra = { "openai-safety-identifier": yield* safetyIdentifier(who.caller.projectId) }
    const response = yield* send(
      new Request(upstreamUrl(config, path, search), {
        method: "POST",
        headers: forwardHeaders(raw.headers, who.auth, extra),
        body: text
      })
    )
    const answer = yield* Effect.promise(() => response.text())
    const parsed = parseJson(answer)
    const value = str(parsed?.value)
    if (!response.ok || parsed === undefined || value === undefined)
      return HttpServerResponse.raw(
        new Response(answer, { status: response.status, headers: backHeaders(response.headers) })
      )
    const session = parsed.session as { readonly model?: unknown } | undefined
    const expiresAt =
      typeof parsed.expires_at === "number" ? parsed.expires_at : (yield* Clock.currentTimeMillis) / 1000 + 600
    const model = str(session?.model)
    const wrapped = yield* secrets.wrap({
      secret: value,
      projectId: who.caller.projectId,
      userId: who.caller.userId,
      ...(model === undefined ? {} : { model }),
      expiresAt
    })
    return HttpServerResponse.jsonUnsafe({ ...parsed, value: wrapped }, { status: response.status })
  })

/** Starts the sideband that meters a call or Live session the gateway can't see. */
const attachSideband = (who: Authorized, kind: "realtime" | "live", id: string, model: string | undefined) =>
  Effect.gen(function* () {
    yield* own(who.caller, id, kind === "realtime" ? "call" : "live", false)
    // The sideband attaches with Dream's key, which it holds itself.
    yield* (yield* CallSideband).attach({
      kind,
      id,
      projectId: who.caller.projectId,
      userId: who.caller.userId,
      ...(model === undefined ? {} : { model })
    })
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("openai gateway: couldn't attach a sideband", cause)))

const realtimeCall = (raw: Request, path: string, search: string, who: Authorized) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const headers = forwardHeaders(raw.headers, who.auth)
    const body = yield* Effect.promise(() => raw.arrayBuffer())
    const response = yield* send(new Request(upstreamUrl(config, path, search), { method: "POST", headers, body }))
    const answer = yield* Effect.promise(() => response.arrayBuffer())
    const location = response.headers.get("location") ?? ""
    const callId = /\/(rtc_[A-Za-z0-9_-]+)/.exec(location)?.[1]
    if (response.ok && callId !== undefined)
      yield* later(
        attachSideband(who, "realtime", callId, who.model ?? new URL(raw.url).searchParams.get("model") ?? undefined)
      )
    return HttpServerResponse.raw(
      new Response(answer, { status: response.status, headers: backHeaders(response.headers, who.browser ? cors : {}) })
    )
  })

const liveSession = (raw: Request, path: string, search: string, who: Authorized) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const { text, json } = yield* jsonBody(raw)
    const transport = json?.transport as { readonly type?: unknown } | undefined
    if (transport?.type === "sip")
      return problem(400, "Dream's OpenAI gateway doesn't place phone calls (SIP) yet.", "unsupported_by_dream")
    const response = yield* send(
      new Request(upstreamUrl(config, path, search), {
        method: "POST",
        headers: forwardHeaders(raw.headers, who.auth),
        body: text
      })
    )
    const answer = yield* Effect.promise(() => response.text())
    const id = str(parseJson(answer)?.id)
    if (response.ok && id !== undefined) {
      const session = json?.session as { readonly model?: unknown } | undefined
      yield* later(attachSideband(who, "live", id, str(session?.model)))
    }
    return HttpServerResponse.raw(
      new Response(answer, { status: response.status, headers: backHeaders(response.headers) })
    )
  })

const socket = (raw: Request, path: string, search: string, who: Authorized, kind: "realtime" | "live") =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const upstream = yield* OpenAIUpstream
    const protocols = (raw.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "" && !p.startsWith("openai-insecure-api-key."))
    const extra: Record<string, string> = {
      ...(protocols.length > 0 ? { "sec-websocket-protocol": protocols.join(", ") } : {}),
      ...(kind === "realtime" ? { "openai-safety-identifier": yield* safetyIdentifier(who.caller.projectId) } : {})
    }
    const headers: Record<string, string> = {}
    forwardHeaders(raw.headers, who.auth, extra).forEach((value, name) => {
      headers[name] = value
    })
    const opened = yield* upstream
      .connect(upstreamUrl(config, path, search), headers)
      .pipe(
        Effect.catchTag("UpstreamFailure", (failure) =>
          Effect.fail(problem(502, failure.message, "openai_unreachable"))
        )
      )
    const served = yield* upstream.serve
    const { spawn, until } = yield* tracker
    const startedMs = yield* Clock.currentTimeMillis
    const model = new URL(raw.url).searchParams.get("model") ?? who.model
    const session = sessionMeter(kind, { model })
    const requestId = `dream_ws_${crypto.randomUUID().replaceAll("-", "")}`
    const record = (found: ReturnType<typeof session.onMessage>) => {
      for (const { endpoint, usage } of found) spawn(meter(who.caller, endpoint, [usage], { requestId, model }))
    }
    let finish: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    bridge(served.socket, opened.socket, {
      onServerMessage: (data) => record(session.onMessage(data)),
      onEnd: () => {
        record(session.onEnd(Date.now() - startedMs))
        finish()
      }
    })
    yield* until(done)
    return HttpServerResponse.raw(served.response(opened.protocol ?? protocols[0]))
  })

/** Everything at `openai.<domain>`. */
export const openaiGateway = (raw: Request) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    if (!config.aiGatewayEnabled) return HttpServerResponse.text("Not found", { status: 404 })
    const url = new URL(raw.url)
    if (raw.method === "OPTIONS") {
      return url.pathname.replace(/\/+$/, "") === "/v1/realtime/calls"
        ? HttpServerResponse.empty({ status: 204, headers: cors })
        : HttpServerResponse.empty({ status: 204 })
    }
    if (!url.pathname.startsWith("/v1/"))
      return problem(404, "Dream's OpenAI gateway serves OpenAI's API under /v1, as api.openai.com does.", "not_found")
    const path = url.pathname.slice(3)
    const upgrade = (raw.headers.get("upgrade") ?? "").toLowerCase() === "websocket"
    const route = routeOf(raw.method, path, upgrade)
    if (route.kind === "refused") return problem(404, route.message, "unsupported_by_dream")
    if (isCodex(raw.headers))
      return problem(
        403,
        "Dream's OpenAI gateway is for the apps the agent builds; Codex runs on their own subscription.",
        "not_for_harness"
      )
    const who = yield* authorize(raw, route)
    if (who.browser && route.kind !== "realtime-call" && route.kind !== "realtime-socket")
      return problem(401, "A client secret only starts a realtime call.", "invalid_client_secret")
    const search = url.search
    switch (route.kind) {
      case "forward":
        return yield* forward(raw, path, search, who, route)
      case "create-response":
        return yield* createResponse(raw, path, search, who)
      case "chat":
        return yield* chat(raw, path, search, who)
      case "owned":
        return yield* owned(raw, path, search, who, route)
      case "client-secret":
        return yield* clientSecret(raw, path, search, who)
      case "realtime-call":
        return yield* realtimeCall(raw, path, search, who)
      case "live-session":
        return yield* liveSession(raw, path, search, who)
      case "realtime-socket":
        return yield* socket(raw, path, search, who, "realtime")
      case "live-socket":
        return yield* socket(raw, path, search, who, "live")
    }
  }).pipe(
    // Answers carried as failures (refusals, OpenAI unreachable) are just answers.
    Effect.catch((answer) => Effect.succeed(answer)),
    Effect.withSpan("openaiGateway")
  )

// ---------------------------------------------------------------------------
// Background responses nobody polled to the end
// ---------------------------------------------------------------------------

/**
 * Meters background responses whose end nobody watched through the gateway (the app stopped polling, or never
 * streamed them): every few minutes, each one older than two minutes and younger than a day gets one look, and is
 * metered once it's done. Older ones are given up on, and ownership records are kept for OpenAI's 30 days.
 */
export const sweepBackgroundResponses = Effect.gen(function* () {
  const config = yield* ApiConfig
  if (!config.aiGatewayEnabled) return
  const objects = yield* OpenAIObjects
  const upstream = yield* OpenAIUpstream
  const now = yield* Clock.currentTimeMillis
  for (const row of yield* objects.unmetered(now - Duration.toMillis(Duration.days(1)), now - 120_000, 25)) {
    const key = yield* dreamKey.pipe(Effect.option)
    if (Option.isNone(key)) return
    const response = yield* upstream
      .fetch(
        new Request(upstreamUrl(config, `/responses/${row.id}`), {
          headers: { authorization: `Bearer ${Redacted.value(key.value)}` }
        })
      )
      .pipe(Effect.option)
    if (Option.isNone(response)) continue
    if (response.value.status === 404) {
      yield* objects.markMetered(row.id)
      continue
    }
    const parsed = parseJson(yield* Effect.promise(() => response.value.text()))
    if (parsed === undefined || !isTerminal(parsed.status)) continue
    const caller: Caller = { projectId: row.project_id, userId: row.owner_id }
    yield* meter(caller, "responses", fromJson(parsed), { requestId: row.id, model: str(parsed.model) })
    yield* objects.markMetered(row.id)
  }
  yield* objects.prune(now - Duration.toMillis(Duration.days(31)))
}).pipe(
  Effect.catchCause((cause) => Effect.logWarning("openai gateway: background sweep failed", cause)),
  Effect.withSpan("openaiGateway.sweep")
)
