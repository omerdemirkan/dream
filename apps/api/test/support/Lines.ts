/**
 * In-memory lines for relay tests: a `Dialer` that connects to fake servers instead of the network, a fake WebSocket
 * feed, and an HttpClient that answers Discord's `GET /gateway/bot` from a `FakeDiscord`.
 */
import { Effect, Layer, Queue } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { DialFailed, Dialer, GoingAway, type LineEvent, type LineSocket } from "../../src/relay/Dialer.ts"
import type { FakeDiscord, GatewayConnection } from "./FakeDiscord.ts"

export interface FakeServer {
  /** A client connects; `refuse` answers the upgrade with that status instead. */
  readonly open: (
    connection: GatewayConnection,
    request: { readonly url: string; readonly headers: Readonly<Record<string, string>> }
  ) => { readonly receive: (text: string) => void; readonly closed: () => void } | { readonly refuse: number }
}

/** A Dialer whose `open` goes to whichever fake `route` picks for the URL; none means nothing answers. */
export const fakeDialer = (route: (url: string) => FakeServer | undefined) =>
  Layer.succeed(
    Dialer,
    Dialer.of({
      open: (url, headers) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const server = route(url)
            if (server === undefined)
              return yield* new DialFailed({ message: "couldn't connect: nothing listens there" })
            const events = yield* Queue.unbounded<LineEvent>()
            let closed = false
            const connection: GatewayConnection = {
              send: (text) => {
                if (!closed) Queue.offerUnsafe(events, { _tag: "Text", text })
              },
              close: (code, reason) => {
                if (closed) return
                closed = true
                Queue.offerUnsafe(events, { _tag: "Closed", code, reason })
              }
            }
            const opened = server.open(connection, { url, headers })
            if ("refuse" in opened) {
              return yield* new DialFailed({ status: opened.refuse, message: `the server answered ${opened.refuse}` })
            }
            const socket: LineSocket = {
              send: (text) =>
                Effect.sync(() => {
                  if (!closed) opened.receive(text)
                }),
              events,
              close: (code, reason) =>
                Effect.sync(() => {
                  if (closed) return
                  closed = true
                  opened.closed()
                  Queue.offerUnsafe(events, { _tag: "Closed", code, reason })
                })
            }
            return socket
          }),
          (socket) => socket.close(GoingAway, "reconnecting")
        )
    })
  )

/** A Discord fake on `wss://*.discord.test`. */
export const discordServer = (discord: FakeDiscord): FakeServer => ({
  open: (connection) => discord.open(connection)
})

/** Discord's REST API as the fake answers it, for `GET /gateway/bot`; everything else is a 404. */
export const discordRest = (discord: FakeDiscord, calls?: Array<string>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        calls?.push(`${request.method} ${request.url}`)
        const answer = request.url.endsWith("/gateway/bot")
          ? discord.gatewayBot(request.headers.authorization)
          : { status: 404, body: { message: "404" } }
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(answer.body), {
            status: answer.status,
            headers: { "content-type": "application/json" }
          })
        )
      })
    )
  )

/** A WebSocket feed: records who connects with what headers and what they send; tests push messages. */
export class FakeFeed implements FakeServer {
  readonly connections: Array<{
    readonly headers: Readonly<Record<string, string>>
    readonly received: Array<string>
    readonly connection: GatewayConnection
    open: boolean
  }> = []
  /** Answer the upgrade with this status instead, while set. */
  refuse: number | undefined = undefined

  open(connection: GatewayConnection, request: { readonly headers: Readonly<Record<string, string>> }) {
    if (this.refuse !== undefined) return { refuse: this.refuse }
    const entry = { headers: request.headers, received: [] as Array<string>, connection, open: true }
    this.connections.push(entry)
    return {
      receive: (text: string) => void entry.received.push(text),
      closed: () => {
        entry.open = false
      }
    }
  }

  get current() {
    return this.connections.filter((entry) => entry.open).at(-1)
  }

  push(text: string): void {
    this.current?.connection.send(text)
  }

  drop(code = 1006, reason = ""): void {
    const current = this.current
    if (current === undefined) return
    current.open = false
    current.connection.close(code, reason)
  }
}
