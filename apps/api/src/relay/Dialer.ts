/**
 * Opening a relay's line: an outbound WebSocket from the RelayDO. In workerd that's a `fetch` with `Upgrade:
 * websocket`, whose response carries the socket; tests swap in a fake that speaks to an in-memory server.
 *
 * Messages and the close arrive on a queue, so a session reads its line as a sequence of events. Leaving the scope
 * closes the socket with `GoingAway` unless the session closed it itself: not 1000 or 1001, so a Discord session stays
 * resumable, and the other end sees an orderly close rather than a dropped connection.
 */
import { Context, Data, Effect, Layer, Queue, type Scope } from "effect"

export type LineEvent =
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Binary"; readonly data: Uint8Array }
  | { readonly _tag: "Closed"; readonly code: number; readonly reason: string }

export interface LineSocket {
  readonly send: (text: string) => Effect.Effect<void>
  /** Every message, then one `Closed`. */
  readonly events: Queue.Dequeue<LineEvent>
  readonly close: (code: number, reason: string) => Effect.Effect<void>
}

/** The close code a line gets when its scope ends without the session closing it: a reconnect, not a goodbye. */
export const GoingAway = 4000

export class DialFailed extends Data.TaggedError("DialFailed")<{
  readonly message: string
  /** The HTTP status the server answered the upgrade with, when it answered. */
  readonly status?: number
}> {}

/** Builds a `LineSocket` over a standard WebSocket that's already open. */
export const fromWebSocket = (ws: WebSocket): Effect.Effect<LineSocket> =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<LineEvent>()
    let closed = false
    const ended = (code: number, reason: string) => {
      if (closed) return
      closed = true
      Queue.offerUnsafe(events, { _tag: "Closed", code, reason })
    }
    ws.addEventListener("message", (event: MessageEvent) => {
      const data = event.data
      if (typeof data === "string") Queue.offerUnsafe(events, { _tag: "Text", text: data })
      else if (data instanceof ArrayBuffer) Queue.offerUnsafe(events, { _tag: "Binary", data: new Uint8Array(data) })
      else if (ArrayBuffer.isView(data)) {
        Queue.offerUnsafe(events, {
          _tag: "Binary",
          data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        })
      }
    })
    ws.addEventListener("close", (event: CloseEvent) => ended(event.code, event.reason))
    ws.addEventListener("error", () => ended(1006, "the connection failed"))
    return {
      send: (text) =>
        Effect.sync(() => {
          if (!closed) ws.send(text)
        }),
      events,
      close: (code, reason) =>
        Effect.sync(() => {
          if (closed) return
          try {
            ws.close(code, reason)
          } catch {
            // Already closing.
          }
          ended(code, reason)
        })
    }
  })

export class Dialer extends Context.Service<
  Dialer,
  {
    readonly open: (
      url: string,
      headers: Readonly<Record<string, string>>
    ) => Effect.Effect<LineSocket, DialFailed, Scope.Scope>
  }
>()("@dream/api/relay/Dialer") {
  /** workerd: `fetch` with `Upgrade: websocket`, then `accept()`. */
  static readonly layerFetch = Layer.succeed(
    Dialer,
    Dialer.of({
      open: (url, headers) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const response = yield* Effect.tryPromise({
              try: () =>
                fetch(url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:"), {
                  headers: { ...headers, Upgrade: "websocket" }
                }),
              catch: (cause) =>
                new DialFailed({ message: `couldn't connect: ${String((cause as Error)?.message ?? cause)}` })
            })
            const ws = (response as unknown as { webSocket?: WebSocket | null }).webSocket
            if (ws === undefined || ws === null) {
              const body = yield* Effect.promise(() => response.text().catch(() => ""))
              return yield* new DialFailed({
                status: response.status,
                message: `the server answered ${response.status}${body.trim().length > 0 ? `: ${body.trim().split("\n")[0]?.slice(0, 200)}` : ""} instead of opening the line`
              })
            }
            ;(ws as unknown as { accept: () => void }).accept()
            return yield* fromWebSocket(ws)
          }),
          (socket) => socket.close(GoingAway, "reconnecting")
        )
    })
  )
}
