/**
 * What the gateway needs of the platform it runs on, as services, so it runs in Node tests against fakes: the
 * HTTP and WebSocket connection to OpenAI, work that outlives the response (metering a stream once it ended), and
 * the sideband that watches a WebRTC call (`OpenAICallDO`).
 */
import { UpstreamFailure } from "@dream/domain"
import { Context, Effect, Layer, Schema } from "effect"
import type { Socket } from "./Realtime.ts"

/** The two ends of a WebSocket the Worker serves: `response` answers the upgrade, `socket` is the Worker's end. */
export interface ServedSocket {
  readonly socket: Socket
  readonly response: (protocol: string | undefined) => Response
}

export class OpenAIUpstream extends Context.Service<
  OpenAIUpstream,
  {
    readonly fetch: (request: Request) => Effect.Effect<Response, UpstreamFailure>
    /** Opens a WebSocket to `url` (https) with `headers`; the protocol OpenAI picked, if any. */
    readonly connect: (
      url: string,
      headers: Record<string, string>
    ) => Effect.Effect<{ readonly socket: Socket; readonly protocol: string | undefined }, UpstreamFailure>
    /** A WebSocket for the app's upgrade request. */
    readonly serve: Effect.Effect<ServedSocket>
  }
>()("@dream/api/openai/OpenAIUpstream") {
  /** workerd's fetch, outbound WebSockets (`fetch` with `Upgrade`) and `WebSocketPair`. */
  static readonly layer = Layer.succeed(
    OpenAIUpstream,
    OpenAIUpstream.of({
      fetch: (request) =>
        Effect.tryPromise({
          try: () => fetch(request),
          catch: (cause) =>
            new UpstreamFailure({ service: "OpenAI", message: `couldn't reach OpenAI: ${String(cause)}` })
        }),
      connect: (url, headers) =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: () => fetch(url, { headers: { ...headers, Upgrade: "websocket" } }),
            catch: (cause) =>
              new UpstreamFailure({ service: "OpenAI", message: `couldn't reach OpenAI: ${String(cause)}` })
          })
          const socket = (response as unknown as { webSocket?: (Socket & { accept: () => void }) | null }).webSocket
          if (socket === undefined || socket === null) {
            const detail = yield* Effect.promise(() => response.text().catch(() => ""))
            return yield* new UpstreamFailure({
              service: "OpenAI",
              message: `OpenAI refused the WebSocket (${response.status}): ${detail.slice(0, 500)}`
            })
          }
          socket.accept()
          return { socket, protocol: response.headers.get("sec-websocket-protocol") ?? undefined }
        }),
      serve: Effect.sync(() => {
        const Pair = (
          globalThis as unknown as { WebSocketPair: new () => Record<0 | 1, Socket & { accept: () => void }> }
        ).WebSocketPair
        const pair = new Pair()
        const client = pair[0]
        const server = pair[1]
        server.accept()
        return {
          socket: server,
          response: (protocol) =>
            new Response(null, {
              status: 101,
              webSocket: client,
              headers: protocol === undefined ? {} : { "sec-websocket-protocol": protocol }
            } as unknown as ResponseInit)
        }
      })
    })
  )
}

/** Work that has to finish after the response went out (workerd's `waitUntil`). */
export class AfterResponse extends Context.Service<
  AfterResponse,
  { readonly run: (effect: Effect.Effect<void>) => Effect.Effect<void> }
>()("@dream/api/openai/AfterResponse") {
  /** Forked, for tests and anywhere the runtime outlives the request. */
  static readonly layerFork = Layer.succeed(
    AfterResponse,
    AfterResponse.of({ run: (effect) => Effect.asVoid(Effect.forkDetach(effect)) })
  )
}

/** What the gateway hands the sideband for a call or Live session it started. */
export const SidebandRequest = Schema.Struct({
  kind: Schema.Literals(["realtime", "live"]),
  /** `rtc_…` for a realtime call, the Live session's id. */
  id: Schema.String,
  projectId: Schema.String,
  userId: Schema.String,
  model: Schema.optionalKey(Schema.String)
})
export type SidebandRequest = typeof SidebandRequest.Type

export class CallSideband extends Context.Service<
  CallSideband,
  { readonly attach: (request: SidebandRequest) => Effect.Effect<void, UpstreamFailure> }
>()("@dream/api/openai/CallSideband") {
  static readonly layerNone = Layer.succeed(
    CallSideband,
    CallSideband.of({
      attach: () => Effect.fail(new UpstreamFailure({ service: "Dream", message: "no sideband on this runtime" }))
    })
  )
}
