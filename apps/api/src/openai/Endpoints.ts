/**
 * What Dream's OpenAI gateway forwards, by method and path under `/v1`. One key serves every project that has no
 * key of its own, and anything OpenAI stores under a key is readable by whoever holds it, so the gateway forwards an
 * allowlist: the calls that produce something and keep nothing another project could read, plus reads of a stored
 * response or session only for the project that made it (`owned`). Everything else is refused with a message
 * saying what Dream supports. See docs/metering.md ("The OpenAI gateway").
 */

/** The `endpoint` dimension of an `model_request` meter event. */
export type MeteredEndpoint =
  | "responses"
  | "chat"
  | "embeddings"
  | "images"
  | "speech"
  | "transcription"
  | "realtime"
  | "live"

export type Route =
  /** Forwarded as it is; what comes back is metered as `endpoint`, or not at all (free calls). */
  | {
      readonly kind: "forward"
      readonly endpoint: MeteredEndpoint | undefined
      readonly body: "json" | "form" | "none"
    }
  /** `POST /responses`: forwarded, metered, and the response id recorded as this project's. */
  | { readonly kind: "create-response" }
  /** A call on a stored response or Live session: forwarded only for the project that made it. */
  | {
      readonly kind: "owned"
      readonly id: string
      readonly endpoint: MeteredEndpoint | undefined
      readonly method: string
    }
  /** `POST /chat/completions`, never stored. */
  | { readonly kind: "chat" }
  /** The realtime WebSocket (`GET /realtime` with an upgrade), proxied and metered. */
  | { readonly kind: "realtime-socket" }
  /** `POST /realtime/client_secrets`: minted with the real key and handed back wrapped. */
  | { readonly kind: "client-secret" }
  /** `POST /realtime/calls`: a WebRTC call's SDP offer; the call is metered by a sideband. */
  | { readonly kind: "realtime-call" }
  /** GPT-Live: `POST /live/sessions` (WebRTC) or its WebSocket. */
  | { readonly kind: "live-session" }
  | { readonly kind: "live-socket" }
  | { readonly kind: "refused"; readonly message: string }

const supported =
  "Dream's OpenAI gateway supports Responses, Chat Completions (not stored), embeddings, moderations, images, " +
  "speech, transcription and translation, models, Realtime (WebSocket, client secrets, WebRTC calls) and GPT-Live."

const refuse = (what: string): Route => ({ kind: "refused", message: `${what} ${supported}` })

/** Where `path` (after `/v1`) goes. `upgrade` is whether the request asks for a WebSocket. */
export const routeOf = (method: string, path: string, upgrade: boolean): Route => {
  const p = path.replace(/\/+$/, "") || "/"
  if (upgrade) {
    if (method === "GET" && p === "/realtime") return { kind: "realtime-socket" }
    if (method === "GET" && p === "/live/sessions") return { kind: "live-socket" }
    return refuse(`Dream doesn't forward a WebSocket to ${p}.`)
  }
  if (method === "POST") {
    switch (p) {
      case "/responses":
        return { kind: "create-response" }
      case "/responses/input_tokens":
        return { kind: "forward", endpoint: undefined, body: "json" }
      case "/chat/completions":
        return { kind: "chat" }
      case "/embeddings":
        return { kind: "forward", endpoint: "embeddings", body: "json" }
      case "/moderations":
        return { kind: "forward", endpoint: undefined, body: "json" }
      case "/images/generations":
        return { kind: "forward", endpoint: "images", body: "json" }
      case "/images/edits":
        return { kind: "forward", endpoint: "images", body: "form" }
      case "/audio/speech":
        return { kind: "forward", endpoint: "speech", body: "json" }
      case "/audio/transcriptions":
      case "/audio/translations":
        return { kind: "forward", endpoint: "transcription", body: "form" }
      case "/realtime/client_secrets":
        return { kind: "client-secret" }
      case "/realtime/calls":
        return { kind: "realtime-call" }
      case "/live/sessions":
        return { kind: "live-session" }
      case "/realtime/sessions":
      case "/realtime/transcription_sessions":
        return refuse("Mint a client secret with POST /v1/realtime/client_secrets instead.")
    }
  }
  if (method === "GET" && (p === "/models" || /^\/models\/[^/]+$/.test(p)))
    return { kind: "forward", endpoint: undefined, body: "none" }

  const response = /^\/responses\/(resp_[A-Za-z0-9_-]+)(\/cancel|\/input_items)?$/.exec(p)
  if (response !== null) {
    const [, id, tail] = response as unknown as [string, string, string | undefined]
    const allowed =
      tail === undefined
        ? method === "GET" || method === "DELETE"
        : tail === "/cancel"
          ? method === "POST"
          : method === "GET"
    if (allowed)
      return { kind: "owned", id, endpoint: tail === undefined && method === "GET" ? "responses" : undefined, method }
  }
  const call = /^\/realtime\/calls\/(rtc_[A-Za-z0-9_-]+)\/hangup$/.exec(p)
  if (call !== null && method === "POST") return { kind: "owned", id: call[1]!, endpoint: undefined, method }
  const live = /^\/live\/sessions\/([A-Za-z0-9_-]+)\/(hangup|content)$/.exec(p)
  if (live !== null && ((live[2] === "hangup" && method === "POST") || (live[2] === "content" && method === "GET")))
    return { kind: "owned", id: live[1]!, endpoint: undefined, method }

  if (method === "GET" && p === "/chat/completions")
    return refuse("Stored chat completions aren't shared through Dream, since one key serves many projects.")
  const first = p.split("/")[1] ?? ""
  if (
    [
      "files",
      "uploads",
      "vector_stores",
      "conversations",
      "batches",
      "fine_tuning",
      "containers",
      "assistants",
      "threads",
      "evals",
      "audio",
      "videos",
      "organization",
      "chat",
      "responses",
      "realtime",
      "live"
    ].includes(first)
  )
    return refuse(`Dream doesn't forward ${method} /v1${p}: what OpenAI keeps there would be shared by every project.`)
  return refuse(`Dream doesn't forward ${method} /v1${p}.`)
}
