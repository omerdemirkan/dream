/**
 * Realtime and GPT-Live sessions, metered from the events OpenAI sends: the gateway proxies an app's WebSocket
 * message by message, and a WebRTC call is watched by a sideband (`OpenAICallDO`), so both feed what the server
 * says through `sessionMeter`.
 *
 * - Realtime bills per response: each `response.done` carries its usage, and each input transcription
 *   (`conversation.item.input_audio_transcription.completed`) is billed apart, on the transcription model.
 * - GPT-Live bills by the second: `session.usage.updated` is cumulative, and `session.closed` has the final count,
 *   so the session is one event when it ends (with the last count seen, if it never said it closed).
 */
import { Option } from "effect"
import type { MeteredEndpoint } from "./Endpoints.ts"
import { decodeJsonText, decodeValue, JsonObject } from "./Json.ts"
import { fromEvent, quantitiesOf, type Usage } from "./Usage.ts"

type Json = Record<string, unknown>

const decodeObject = decodeJsonText(JsonObject)

const decodeRecord = decodeValue(JsonObject)
const record = (value: unknown): Json | undefined => Option.getOrUndefined(decodeRecord(value))
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

/** The transcription model a realtime session config names (GA `audio.input.transcription`, or beta's). */
const transcriptionModel = (session: Json): string | undefined =>
  text(record(record(record(session.audio)?.input)?.transcription)?.model) ??
  text(record(session.input_audio_transcription)?.model)

export interface SessionMeter {
  /** What one server event says to meter now. */
  readonly onMessage: (data: string) => ReadonlyArray<{ readonly endpoint: MeteredEndpoint; readonly usage: Usage }>
  /** What's left to meter when the session ends after `elapsedMs`. */
  readonly onEnd: (elapsedMs: number) => ReadonlyArray<{ readonly endpoint: MeteredEndpoint; readonly usage: Usage }>
}

/**
 * Meters one session. `estimateDuration`: a session that ends having reported no usage at all is recorded as its
 * length (`session_ms`, estimated), as a WebRTC sideband might if OpenAI didn't pass usage on to it.
 */
export const sessionMeter = (
  kind: "realtime" | "live",
  options: {
    readonly model?: string | undefined
    readonly id?: string | undefined
    readonly estimateDuration?: boolean
  }
): SessionMeter => {
  let model = options.model
  let transcription: string | undefined
  let sessionId = options.id
  let liveSeconds: number | undefined
  let metered = false
  let ended = false

  const onMessage = (data: string) => {
    const event = Option.getOrUndefined(decodeObject(data))
    if (event === undefined) return []
    const type = text(event.type)
    const session = record(event.session)
    if (session !== undefined) {
      model = text(session.model) ?? model
      transcription = transcriptionModel(session) ?? transcription
      if (kind === "live") sessionId = text(session.id) ?? sessionId
    }
    if (kind === "live") {
      const seconds = record(event.usage)?.seconds
      if ((type === "session.usage.updated" || type === "session.closed") && typeof seconds === "number")
        liveSeconds = Math.max(liveSeconds ?? 0, seconds)
      if (type === "session.closed") return onEnd(0)
      return []
    }
    if (type === "response.done") {
      const found = fromEvent(event)
      if (found.length > 0) metered = true
      return found.map((usage) => ({ endpoint: "realtime" as const, usage: { ...usage, model: usage.model ?? model } }))
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      const usage = record(event.usage)
      const itemId = text(event.item_id)
      if (usage === undefined || itemId === undefined) return []
      metered = true
      return [
        {
          endpoint: "realtime" as const,
          usage: {
            id: `${itemId}:transcription`,
            model: transcription ?? "realtime-transcription",
            quantities: quantitiesOf(usage)
          }
        }
      ]
    }
    return []
  }

  const onEnd = (elapsedMs: number) => {
    if (ended) return []
    ended = true
    if (kind === "live") {
      if (liveSeconds === undefined && !options.estimateDuration) return []
      return [
        {
          endpoint: "live" as const,
          usage: {
            id: sessionId,
            model: model ?? "gpt-live-1",
            quantities: { session_ms: Math.round(liveSeconds === undefined ? elapsedMs : liveSeconds * 1000) },
            estimated: liveSeconds === undefined
          }
        }
      ]
    }
    if (metered || options.estimateDuration !== true || sessionId === undefined) return []
    return [
      {
        endpoint: "realtime" as const,
        usage: { id: sessionId, model, quantities: { session_ms: Math.round(elapsedMs) }, estimated: true }
      }
    ]
  }

  return { onMessage, onEnd }
}

/** What the gateway needs of a WebSocket: workerd's, or a fake in tests. */
export interface Socket {
  readonly send: (data: string | ArrayBuffer) => void
  readonly close: (code?: number, reason?: string) => void
  readonly addEventListener: (type: "message" | "close" | "error", listener: (event: never) => void) => void
}

/** Close codes a socket may be closed with (1005 and 1006 can only be received). */
const sendableCode = (code: number | undefined) =>
  code !== undefined && (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1000

/**
 * Joins the app's socket to OpenAI's, message for message, showing `onServerMessage` what OpenAI says; `onEnd`
 * once, when either side closes.
 */
export const bridge = (
  client: Socket,
  upstream: Socket,
  hooks: { readonly onServerMessage: (data: string) => void; readonly onEnd: () => void }
) => {
  let open = true
  const end = (to: Socket) => (event: { readonly code?: number; readonly reason?: string }) => {
    if (!open) return
    open = false
    try {
      to.close(sendableCode(event.code), event.reason ?? "")
    } catch {
      // Already closed.
    }
    hooks.onEnd()
  }
  client.addEventListener("message", (event: { readonly data: string | ArrayBuffer }) => {
    if (open) upstream.send(event.data)
  })
  upstream.addEventListener("message", (event: { readonly data: string | ArrayBuffer }) => {
    if (!open) return
    client.send(event.data)
    if (typeof event.data === "string") hooks.onServerMessage(event.data)
  })
  client.addEventListener("close", end(upstream))
  upstream.addEventListener("close", end(client))
  client.addEventListener("error", () => end(upstream)({ code: 1011 }))
  upstream.addEventListener("error", () => end(client)({ code: 1011 }))
}
