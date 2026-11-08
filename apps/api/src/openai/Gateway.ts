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
import { Clock, DateTime, Duration, Effect, Option, Redacted, Schema } from "effect"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { Tokens } from "../auth/Tokens.ts"
import { ApiConfig } from "../Config.ts"
import { Projects } from "../db/Projects.ts"
import { toHex, utf8 } from "../lib/Bytes.ts"
import { Meter, type MeterEvent } from "../metering/Meter.ts"
import { ClientSecrets, WrappedPrefix } from "./ClientSecrets.ts"
import { type MeteredEndpoint, type Route, routeOf } from "./Endpoints.ts"
import { type ObjectKind, OpenAIObjects } from "./Objects.ts"
import { decodeJsonText, decodeValue, JsonObject } from "./Json.ts"
import { bridge, sessionMeter } from "./Realtime.ts"
import { AfterResponse, CallSideband, OpenAIUpstream } from "./Runtime.ts"
import { observe } from "./Sse.ts"
import {
  asImages,
  asSpeech,
  type Caller,
  createdResponseId,
  fromEvent,
  fromJson,
  imagesEstimate,
  speechEstimate,
  toEvent,
  transcriptionEstimate,
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
  "openai-safety-identifier",
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

const sha256 = (text: string) =>
  Effect.promise(async () => toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)))))

/**
 * The id OpenAI's abuse checks see for a call on Dream's key (`safety_identifier`, or the
 * `OpenAI-Safety-Identifier` header): always the project's, so no app can pick or rotate it. An app's own (one per
 * end user, say) is folded in after it, so its users stay apart inside the project but never cross into another.
 */
export const safetyIdentifier = (projectId: string, theirs?: string | undefined) =>
  Effect.gen(function* () {
    const project = (yield* sha256(`dream-openai:${projectId}`)).slice(0, 32)
    if (theirs === undefined || theirs === "") return project
    return `${project}:${(yield* sha256(`dream-openai-user:${theirs}`)).slice(0, 24)}`
  })

const decodeObjectText = decodeJsonText(JsonObject)

/**
 * The fields of a request body the gateway reads; the body itself goes on whole. Each is read on its own and
 * leniently, as OpenAI reads it (`null` or a value of another type means the default), so one odd field never
 * hides the others; a field the gateway has to check but can't understand is `unreadable`, and refused.
 */
export interface RequestFields {
  readonly model?: string | undefined
  readonly input?: unknown
  readonly stream: boolean
  /** OpenAI stores a response unless `store` is `false`. */
  readonly store: boolean
  readonly background: boolean
  readonly safety_identifier?: string | undefined
  readonly previous_response_id?: string | undefined
  readonly stream_options: JsonObject
  readonly n?: number | undefined
  readonly size?: string | undefined
  readonly quality?: string | undefined
  readonly transportType?: string | undefined
  readonly sessionModel?: string | undefined
  /** What the gateway couldn't make out of a field it checks. */
  readonly unreadable?: string | undefined
}

const asString = decodeValue(Schema.String)
const asNumber = decodeValue(Schema.Finite)
const asObject = decodeValue(JsonObject)
const string = (value: unknown) => Option.getOrUndefined(asString(value))
const absent = (value: unknown) => value === undefined || value === null

export const readFields = (json: JsonObject | undefined): RequestFields => {
  if (json === undefined) return { stream: false, store: true, background: false, stream_options: {} }
  const transport = asObject(json.transport)
  const session = asObject(json.session)
  const previous = json.previous_response_id
  const unreadable =
    !absent(previous) && string(previous) === undefined
      ? "previous_response_id must be a response id."
      : !absent(json.transport) &&
          (Option.isNone(transport) || (!absent(transport.value.type) && string(transport.value.type) === undefined))
        ? "transport must say its type."
        : undefined
  return {
    model: string(json.model),
    input: json.input,
    stream: json.stream === true,
    store: json.store !== false,
    background: json.background === true,
    safety_identifier: string(json.safety_identifier),
    previous_response_id: string(previous),
    stream_options: Option.getOrElse(asObject(json.stream_options), () => ({})),
    n: Option.getOrUndefined(asNumber(json.n)),
    size: string(json.size),
    quality: string(json.quality),
    transportType: Option.getOrUndefined(Option.map(transport, (t) => string(t.type))),
    sessionModel: Option.getOrUndefined(Option.map(session, (t) => string(t.model))),
    unreadable
  }
}

/** What OpenAI answers that the gateway reads. */
const AnswerFields = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
  expires_at: Schema.optionalKey(Schema.Finite),
  session: Schema.optionalKey(Schema.Struct({ model: Schema.optionalKey(Schema.String) }))
})
const decodeAnswer = decodeValue(AnswerFields)

const ChatChunk = Schema.Struct({ choices: Schema.Array(Schema.Unknown), usage: Schema.Unknown })
const decodeChatChunk = decodeValue(ChatChunk)

/**
 * What in a Responses request reaches what OpenAI stored for someone else: a conversation, an item by reference, a
 * file, a vector store or a container by id. The gateway lets none of these through, since nothing a project
 * makes through it is stored as any of them; `previous_response_id` is checked against the project's own.
 */
export const foreignReference = (body: JsonObject): string | undefined => {
  if (body.conversation !== undefined && body.conversation !== null)
    return "Conversations aren't shared through Dream, since one key serves many projects; use previous_response_id."
  const visit = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item)
        if (found !== undefined) return found
      }
      return undefined
    }
    const object = Option.getOrUndefined(decodeValue(JsonObject)(value))
    if (object === undefined) return undefined
    if (object.type === "item_reference")
      return "Items by reference aren't shared through Dream; send the item itself, or use previous_response_id."
    if (typeof object.file_id === "string") return "Files aren't shared through Dream; send the file's content inline."
    if (Array.isArray(object.vector_store_ids) && object.vector_store_ids.length > 0)
      return "Vector stores aren't shared through Dream."
    if (typeof object.container === "string") return 'Use a container of type "auto"; ids aren\'t shared through Dream.'
    for (const nested of Object.values(object)) {
      const found = visit(nested)
      if (found !== undefined) return found
    }
    return undefined
  }
  return storedItem(body.input) ?? visit(body.input) ?? visit(body.tools)
}

/** What an input item carries when it's the item itself, not a pointer to one OpenAI stored. */
const ItemContent = ["content", "output", "arguments", "encrypted_content", "action", "result", "code", "queries"]

/**
 * An input item that names an id but carries none of its content is a reference to a stored item, whatever its
 * `type` says (OpenAI lets `type` go unsaid): refused, since the gateway can't tell whose item it is.
 */
const storedItem = (input: unknown): string | undefined => {
  if (!Array.isArray(input)) return undefined
  for (const item of input) {
    const object = Option.getOrUndefined(asObject(item))
    if (object === undefined || string(object.id) === undefined) continue
    if (!ItemContent.some((key) => object[key] !== undefined && object[key] !== null))
      return "Items by reference aren't shared through Dream; send the item itself, or use previous_response_id."
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Who's calling
// ---------------------------------------------------------------------------

interface Authorized {
  readonly caller: Caller
  /** What OpenAI gets as the bearer: the key, or (a browser's call) OpenAI's client secret. */
  readonly auth: Redacted.Redacted<string>
  /** The model a client secret was minted for. */
  readonly model?: string | undefined
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
    const secrets = yield* ClientSecrets
    const bearer = bearerOf(raw.headers) ?? (route.kind === "realtime-socket" ? protocolKey(raw.headers) : undefined)
    if (bearer === undefined) return yield* Effect.fail(noCredential)

    if (bearer.startsWith(WrappedPrefix) && (route.kind === "realtime-call" || route.kind === "realtime-socket")) {
      const claims = yield* secrets
        .unwrap(bearer, yield* Clock.currentTimeMillis)
        .pipe(Effect.mapError(() => problem(401, "This client secret is invalid or expired.", "invalid_client_secret")))
      // A deleted project's secrets stop working with it.
      if ((yield* ownerOf(claims.projectId as ProjectId)) !== claims.userId)
        return yield* Effect.fail(problem(401, "This project no longer exists.", "project_gone"))
      return {
        caller: { projectId: claims.projectId, userId: claims.userId },
        auth: Redacted.make(claims.secret),
        model: claims.model
      } satisfies Authorized
    }

    const claims = yield* tokens.verifyOpenAIGateway(bearer).pipe(Effect.mapError(() => noCredential))
    if ((yield* ownerOf(claims.projectId)) !== claims.userId)
      return yield* Effect.fail(problem(401, "This project no longer exists.", "project_gone"))
    return {
      caller: { projectId: claims.projectId, userId: claims.userId },
      auth: yield* dreamKey
    } satisfies Authorized
  })

/** Who owns the project now, if it still exists (looked up at most once a minute per isolate). */
const ownerOf = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const projects = yield* Projects
    const now = yield* Clock.currentTimeMillis
    let cached = projectCache.get(projectId)
    if (cached === undefined || now - cached.atMs > ProjectCacheMs) {
      const project = yield* projects.find(projectId)
      cached = { ownerId: Option.match(project, { onNone: () => null, onSome: (p) => p.ownerId }), atMs: now }
      projectCache.set(projectId, cached)
    }
    return cached.ownerId
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
      toEvent(
        caller,
        endpoint,
        endpoint === "speech" ? asSpeech(usage) : endpoint === "images" ? asImages(usage) : usage,
        { ...fallback, at }
      )
    )
    yield* (yield* Meter).record(events)
    if (endpoint === "responses") {
      const objects = yield* OpenAIObjects
      for (const usage of usages) if (usage.id?.startsWith("resp_") === true) yield* objects.markMetered(usage.id)
    }
  })

const requestIdOf = (response: Response) =>
  response.headers.get("x-request-id") ?? `dream_${crypto.randomUUID().replaceAll("-", "")}`

/** How long after a stored response is made the sweep first looks for it, if nothing metered it by then. */
const FirstCheckMs = 120_000

/**
 * Records `id` as this project's. Never fails the call: if D1 refuses, the response still goes back, and at worst
 * the project's later reads of it are refused.
 */
const own = (caller: Caller, id: string, kind: ObjectKind, background: boolean) =>
  Effect.gen(function* () {
    const objects = yield* OpenAIObjects
    const nowMs = yield* Clock.currentTimeMillis
    yield* objects.record({
      id,
      projectId: caller.projectId,
      ownerId: caller.userId,
      kind,
      background,
      nowMs,
      firstCheckMs: nowMs + FirstCheckMs
    })
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("openai gateway: couldn't record what a project made", cause)))

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
    /** A body that isn't JSON or events (a transcription as text, srt or vtt), metered from its text. */
    readonly fromText?: ((text: string) => Usage) | undefined
    readonly onData?: (data: unknown, spawn: (effect: Effect.Effect<void, never, Services>) => void) => void
    readonly drop?: (data: unknown) => boolean
    readonly headers?: Record<string, string>
  } = {}
) =>
  Effect.gen(function* () {
    const headers = backHeaders(response.headers, options.headers)
    const type = response.headers.get("content-type") ?? ""
    const kind = type.includes("text/event-stream")
      ? "sse"
      : type.includes("json")
        ? "json"
        : options.fromText !== undefined && type.startsWith("text/")
          ? "text"
          : undefined
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
          const found =
            kind === "text"
              ? typeof data === "string" && options.fromText !== undefined
                ? [options.fromText(data)]
                : []
              : kind === "json"
                ? fromJson(data)
                : fromEvent(data)
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

/** The app hung up, or sent a body that can't be read: a typed answer, never a defect. */
const readRequest = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => problem(400, "The request body couldn't be read.", "invalid_body") })

/** OpenAI's answer, read whole (small ones the gateway changes or needs before answering). */
const readAnswer = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => problem(502, "OpenAI's answer was cut off.", "openai_unreachable") })

/** A JSON request's body: the object (to send on, with Dream's changes) and the fields the gateway reads. */
const jsonBody = (raw: Request) =>
  Effect.map(
    readRequest(() => raw.text()),
    (text) => {
      const json = Option.getOrUndefined(decodeObjectText(text))
      const fields = readFields(json)
      return { text, json, fields }
    }
  )

const withSafety = (caller: Caller, json: JsonObject, fields: RequestFields) =>
  Effect.map(safetyIdentifier(caller.projectId, fields.safety_identifier), (safety_identifier) => ({
    ...json,
    safety_identifier
  }))

const isTerminal = (status: unknown) =>
  status === "completed" || status === "incomplete" || status === "failed" || status === "cancelled"

/** Refuses what reaches another project's stored data; `previous_response_id` must be one this project made. */
const checkReferences = (caller: Caller, json: JsonObject, fields: RequestFields) =>
  Effect.gen(function* () {
    if (fields.unreadable !== undefined) return yield* Effect.fail(problem(400, fields.unreadable, "invalid_body"))
    const foreign = foreignReference(json)
    if (foreign !== undefined) return yield* Effect.fail(problem(400, foreign, "unsupported_by_dream"))
    const previous = fields.previous_response_id
    if (previous === undefined) return
    if (!(yield* madeBy(previous, caller)))
      return yield* Effect.fail(
        problem(404, `No ${previous} was made by this project through Dream.`, "previous_response_not_found")
      )
  })

/** Whether `id` was made by this project; a stream's id is recorded a moment after the app saw it, so ask twice. */
const madeBy = (id: string, caller: Caller) =>
  Effect.gen(function* () {
    const objects = yield* OpenAIObjects
    const look = objects
      .projectOf(id)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("openai gateway: couldn't look up an owner", cause).pipe(Effect.as(Option.none<string>()))
        )
      )
    let owner = yield* look
    if (Option.isNone(owner)) {
      yield* Effect.sleep(Duration.seconds(1))
      owner = yield* look
    }
    return Option.isSome(owner) && owner.value === caller.projectId
  })

const createResponse = (raw: Request, path: string, search: string, who: Authorized, count: boolean) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const { text, json, fields } = yield* jsonBody(raw)
    if (json !== undefined) yield* checkReferences(who.caller, json, fields)
    const body = json === undefined ? text : JSON.stringify(yield* withSafety(who.caller, json, fields))
    const request = new Request(upstreamUrl(config, path, search), {
      method: "POST",
      headers: forwardHeaders(raw.headers, who.auth, { "content-type": "application/json" }),
      body
    })
    const response = yield* send(request)
    if (count)
      return HttpServerResponse.raw(
        new Response(response.body, { status: response.status, headers: backHeaders(response.headers) })
      )
    const background = fields.background
    // Stored responses are this project's to read back, and the sweep's to meter if nobody saw them finish.
    const stored = fields.store || background
    const model = fields.model
    const type = response.headers.get("content-type") ?? ""
    if (response.ok && type.includes("json") && !type.includes("event-stream")) {
      // Small, and its id must be this project's before the app can ask for it again (a background poll).
      const answer = yield* readAnswer(() => response.text())
      const parsed = Option.flatMap(decodeObjectText(answer), decodeAnswer)
      const id = Option.getOrUndefined(Option.flatMap(parsed, (a) => Option.fromNullishOr(a.id)))
      if (id !== undefined && stored) yield* own(who.caller, id, "response", background)
      if (Option.isSome(parsed) && isTerminal(parsed.value.status))
        yield* later(
          meter(who.caller, "responses", fromJson(Option.getOrUndefined(decodeObjectText(answer))), {
            requestId: requestIdOf(response),
            model
          })
        )
      return HttpServerResponse.raw(
        new Response(answer, { status: response.status, headers: backHeaders(response.headers) })
      )
    }
    return yield* metered(response, who.caller, "responses", {
      model,
      onData: (data, spawn) => {
        const id = createdResponseId(data)
        if (id !== undefined && stored) spawn(own(who.caller, id, "response", background))
      }
    })
  })

const chat = (raw: Request, path: string, search: string, who: Authorized) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const { text, json, fields } = yield* jsonBody(raw)
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
    const stream = fields.stream
    const options = fields.stream_options
    const asked = options.include_usage === true
    // Never stored: the stored-completions list would show every project's to every other.
    const edited = {
      ...(yield* withSafety(who.caller, json, fields)),
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
      model: fields.model,
      // The usage chunk Dream asked for, which an app that didn't may not expect.
      ...(stream && !asked
        ? {
            drop: (data: unknown) =>
              Option.match(decodeChatChunk(data), {
                onNone: () => false,
                onSome: (chunk) => chunk.choices.length === 0 && chunk.usage != null
              })
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
      const field = (name: string) => {
        const value = form.get(name)
        return typeof value === "string" ? value : undefined
      }
      const model = field("model")
      const format = field("response_format") ?? "json"
      const response = yield* send(new Request(url, { method: "POST", headers, body: form }))
      return yield* metered(response, who.caller, route.endpoint, {
        model,
        ...(route.endpoint === "transcription"
          ? { fromText: (text: string) => transcriptionEstimate(model, format, text) }
          : route.endpoint === "images" && model?.startsWith("dall-e") === true
            ? { estimate: imagesEstimate(Number(field("n") ?? 1) || 1, field("size"), field("quality")) }
            : {})
      })
    }
    const { text, fields } = yield* jsonBody(raw)
    const model = fields.model
    const input = typeof fields.input === "string" ? fields.input : undefined
    const response = yield* send(
      new Request(url, { method: "POST", headers: forwardHeaders(raw.headers, who.auth), body: text })
    )
    return yield* metered(response, who.caller, route.endpoint, {
      model,
      ...(route.endpoint === "speech" && input !== undefined ? { estimate: speechEstimate(model, input) } : {}),
      ...(route.endpoint === "images" && model?.startsWith("dall-e") === true
        ? { estimate: imagesEstimate(fields.n ?? 1, fields.size, fields.quality) }
        : {})
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
    if (!(yield* madeBy(route.id, who.caller)))
      return problem(404, `No ${route.id} was made by this project through Dream.`, "not_found")
    const hasBody = raw.method === "POST"
    const response = yield* send(
      new Request(upstreamUrl(config, path, search), {
        method: raw.method,
        headers: forwardHeaders(raw.headers, who.auth),
        ...(hasBody ? { body: yield* readRequest(() => raw.text()) } : {})
      })
    )
    return yield* metered(response, who.caller, route.endpoint)
  })

const clientSecret = (raw: Request, path: string, search: string, who: Authorized) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const secrets = yield* ClientSecrets
    const { text } = yield* jsonBody(raw)
    const extra = {
      "openai-safety-identifier": yield* safetyIdentifier(
        who.caller.projectId,
        raw.headers.get("openai-safety-identifier") ?? undefined
      )
    }
    const response = yield* send(
      new Request(upstreamUrl(config, path, search), {
        method: "POST",
        headers: forwardHeaders(raw.headers, who.auth, extra),
        body: text
      })
    )
    const answer = yield* readAnswer(() => response.text())
    const whole = Option.getOrUndefined(decodeObjectText(answer))
    const parsed = whole === undefined ? undefined : Option.getOrUndefined(decodeAnswer(whole))
    const value = parsed?.value
    if (!response.ok || whole === undefined || value === undefined)
      return HttpServerResponse.raw(
        new Response(answer, { status: response.status, headers: backHeaders(response.headers) })
      )
    const expiresAt = parsed?.expires_at ?? (yield* Clock.currentTimeMillis) / 1000 + 600
    const model = parsed?.session?.model
    const wrapped = yield* secrets.wrap({
      secret: value,
      projectId: who.caller.projectId,
      userId: who.caller.userId,
      ...(model === undefined ? {} : { model }),
      expiresAt
    })
    return HttpServerResponse.jsonUnsafe({ ...whole, value: wrapped }, { status: response.status })
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

/** `OpenAI-Safety-Identifier` for a realtime mint, call or session: the project's, with the app's folded in. */
const safetyHeader = (raw: Request, who: Authorized) =>
  Effect.map(
    safetyIdentifier(who.caller.projectId, raw.headers.get("openai-safety-identifier") ?? undefined),
    (id): Record<string, string> => ({ "openai-safety-identifier": id })
  )

const realtimeCall = (raw: Request, path: string, search: string, who: Authorized) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const headers = forwardHeaders(raw.headers, who.auth, yield* safetyHeader(raw, who))
    const body = yield* readRequest(() => raw.arrayBuffer())
    const response = yield* send(new Request(upstreamUrl(config, path, search), { method: "POST", headers, body }))
    const answer = yield* readAnswer(() => response.arrayBuffer())
    const location = response.headers.get("location") ?? ""
    const callId = /\/(rtc_[A-Za-z0-9_-]+)/.exec(location)?.[1]
    if (response.ok && callId !== undefined)
      yield* later(
        attachSideband(who, "realtime", callId, who.model ?? new URL(raw.url).searchParams.get("model") ?? undefined)
      )
    return HttpServerResponse.raw(
      new Response(answer, { status: response.status, headers: backHeaders(response.headers, cors) })
    )
  })

const liveSession = (raw: Request, path: string, search: string, who: Authorized) =>
  Effect.gen(function* () {
    const config = yield* ApiConfig
    const { text, fields } = yield* jsonBody(raw)
    if (fields.unreadable !== undefined) return problem(400, fields.unreadable, "invalid_body")
    if (fields.transportType === "sip")
      return problem(400, "Dream's OpenAI gateway doesn't place phone calls (SIP) yet.", "unsupported_by_dream")
    const response = yield* send(
      new Request(upstreamUrl(config, path, search), {
        method: "POST",
        headers: forwardHeaders(raw.headers, who.auth, yield* safetyHeader(raw, who)),
        body: text
      })
    )
    const answer = yield* readAnswer(() => response.text())
    const id = Option.getOrUndefined(
      Option.flatMap(Option.flatMap(decodeObjectText(answer), decodeAnswer), (a) => Option.fromNullishOr(a.id))
    )
    if (response.ok && id !== undefined) yield* later(attachSideband(who, "live", id, fields.sessionModel))
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
      ...(kind === "realtime"
        ? {
            "openai-safety-identifier": yield* safetyIdentifier(
              who.caller.projectId,
              raw.headers.get("openai-safety-identifier") ?? undefined
            )
          }
        : {})
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

/** Model names and intents, in a strict set of characters. */
const QueryValue = /^[A-Za-z0-9._:-]{1,100}$/

/**
 * What a socket's query may say: the realtime model and intent, nothing for GPT-Live (its model is in
 * `session.start`). `call_id` would attach to someone's WebRTC call; Dream's sideband is the only one that does.
 */
const socketQuery = (url: URL, kind: "realtime-socket" | "live-socket") =>
  Effect.gen(function* () {
    const allowed = kind === "realtime-socket" ? ["model", "intent"] : []
    const kept = new URLSearchParams()
    for (const [name, value] of url.searchParams) {
      if (!allowed.includes(name) || !QueryValue.test(value))
        return yield* Effect.fail(
          problem(400, `Dream's gateway doesn't pass ?${name} on to OpenAI's WebSocket.`, "unsupported_by_dream")
        )
      kept.set(name, value)
    }
    const query = kept.toString()
    return query === "" ? "" : `?${query}`
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
    const search =
      route.kind === "realtime-socket" || route.kind === "live-socket"
        ? yield* socketQuery(url, route.kind)
        : url.search
    switch (route.kind) {
      case "forward":
        return yield* forward(raw, path, search, who, route)
      case "create-response":
        return yield* createResponse(raw, path, search, who, route.count)
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
    // A browser starting a call reads the answer, refusals included, only with CORS.
    Effect.map((answer) =>
      new URL(raw.url).pathname.replace(/\/+$/, "") === "/v1/realtime/calls"
        ? HttpServerResponse.setHeaders(answer, cors)
        : answer
    ),
    Effect.withSpan("openaiGateway")
  )

// ---------------------------------------------------------------------------
// Stored responses nobody saw finish
// ---------------------------------------------------------------------------

/** How long the sweep keeps looking for a response, and how far apart: two minutes, doubling, up to an hour. */
const SweepFor = Duration.days(1)
const nextLook = (attempts: number) => Math.min(60, 2 * 2 ** attempts) * 60_000

/**
 * Meters stored responses nobody watched finish through the gateway: background ones the app stopped polling, and
 * streams it hung up on before their last event. Each is looked up when due, later each time it isn't done, and
 * given up on after a day; ownership records stay for OpenAI's 30 days.
 */
export const sweepBackgroundResponses = Effect.gen(function* () {
  const config = yield* ApiConfig
  if (!config.aiGatewayEnabled) return
  const key = yield* dreamKey.pipe(Effect.option)
  if (Option.isNone(key)) return
  const objects = yield* OpenAIObjects
  const upstream = yield* OpenAIUpstream
  const now = yield* Clock.currentTimeMillis
  for (const row of yield* objects.due(now, 25)) {
    if (now - row.created_at_ms > Duration.toMillis(SweepFor)) {
      yield* Effect.logWarning("openai gateway: gave up metering a response", { id: row.id })
      yield* objects.giveUp(row.id)
      continue
    }
    const later = objects.checkLater(row.id, now + nextLook(row.attempts))
    const response = yield* upstream
      .fetch(
        new Request(upstreamUrl(config, `/responses/${row.id}`), {
          headers: { authorization: `Bearer ${Redacted.value(key.value)}` }
        })
      )
      .pipe(Effect.option)
    if (Option.isNone(response)) {
      yield* later
      continue
    }
    if (response.value.status === 404) {
      yield* objects.giveUp(row.id)
      continue
    }
    const text = yield* Effect.tryPromise(() => response.value.text()).pipe(Effect.option)
    const whole = Option.flatMap(text, decodeObjectText)
    const parsed = Option.flatMap(whole, decodeAnswer)
    if (Option.isNone(parsed) || !isTerminal(parsed.value.status)) {
      yield* later
      continue
    }
    const caller: Caller = { projectId: row.project_id, userId: row.owner_id }
    yield* meter(caller, "responses", fromJson(Option.getOrUndefined(whole)), {
      requestId: row.id,
      model: parsed.value.model
    })
    yield* objects.markMetered(row.id)
  }
  yield* objects.prune(now - Duration.toMillis(Duration.days(31)))
}).pipe(
  Effect.catchCause((cause) => Effect.logWarning("openai gateway: background sweep failed", cause)),
  Effect.withSpan("openaiGateway.sweep")
)
