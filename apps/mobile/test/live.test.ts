/**
 * The live project stream over a real Effect RPC socket protocol (JSON, the
 * transport alchemy's RpcDurableObject speaks), with WebSockets faked in
 * memory: snapshot then changes, and a fresh ticket and snapshot after the
 * server drops the connection (as a ProjectDO does when it is evicted).
 */
import { type ProjectEvent, type ProjectId, ProjectLiveRpcs, SocketRpcSerialization } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { type Duration, Effect, Fiber, Layer, Queue, Redacted, Stream } from "effect"
import { NetAddress } from "effect/net"
import { RpcServer } from "effect/rpc"
import { Socket, SocketServer } from "effect/socket"
import { TestClock } from "effect/testing"
import { AppClient } from "../src/data/AppClient.ts"
import { LiveProjects } from "../src/data/LiveProjects.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"
import { FakeBackend } from "../src/fake/FakeBackend.ts"
import { AppClientFake } from "../src/fake/layers.ts"

type Listener = (event: Socket.WebSocketEvent) => void

/** One end of an in-memory WebSocket; `peer` is the other end. */
class FakeWebSocket implements Socket.WebSocketLike {
  readyState = 0
  peer: FakeWebSocket | undefined
  private listeners = new Map<string, Set<Listener>>()
  /** Frames that arrived before anyone listened (a real socket buffers them too). */
  private unread: Array<Record<string, unknown>> = []
  readonly url: string
  constructor(url: string) {
    this.url = url
  }
  addEventListener(type: string, listener: Listener, options?: { readonly once?: boolean }) {
    const wrapped: Listener = options?.once
      ? (event) => {
          this.removeEventListener(type, wrapped)
          listener(event)
        }
      : listener
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)?.add(wrapped)
    if (type === "message" && this.unread.length > 0) {
      const frames = this.unread
      this.unread = []
      queueMicrotask(() => frames.forEach((frame) => this.emit("message", frame)))
    }
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener)
  }
  emit(type: string, event: Record<string, unknown>) {
    if (type === "message" && (this.listeners.get("message")?.size ?? 0) === 0) {
      this.unread.push(event)
      return
    }
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event as Socket.WebSocketEvent)
  }
  open() {
    this.readyState = 1
    this.emit("open", {})
  }
  send(data: string | Uint8Array<ArrayBuffer>) {
    const peer = this.peer
    if (this.readyState !== 1 || !peer) return
    queueMicrotask(() => peer.emit("message", { data }))
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => {
      this.emit("close", { code, reason })
      this.peer?.close(code, reason)
    })
  }
}

const projectId = "prj_liftlog" as ProjectId

/** Lets in-memory sockets deliver (they use microtasks), then moves the test clock. */
const settle = (duration: Duration.Input) =>
  Effect.gen(function* () {
    for (let i = 0; i < 5; i++) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
      yield* TestClock.adjust(duration)
    }
  })

describe("LiveProjects over a WebSocket", () => {
  it.effect("streams snapshot then changes, and resubscribes with a fresh ticket after a drop", () =>
    Effect.gen(function* () {
      const urls: Array<string> = []
      const servers: Array<FakeWebSocket> = []
      const incoming = yield* Queue.unbounded<FakeWebSocket>()

      // The client dials through this constructor; the server side of each pair goes to the server.
      const constructor = Layer.succeed(Socket.WebSocketConstructor, (url: string) => {
        urls.push(url)
        const client = new FakeWebSocket(url)
        const server = new FakeWebSocket(url)
        client.peer = server
        server.peer = client
        server.readyState = 1
        servers.push(server)
        Queue.offerUnsafe(incoming, server)
        queueMicrotask(() => client.open())
        return client
      })

      const socketServer = Layer.succeed(SocketServer.SocketServer, {
        address: NetAddress.unixPathAddress("memory"),
        run: (handler) =>
          Effect.forever(
            Queue.take(incoming).pipe(
              Effect.flatMap((ws) => Socket.fromWebSocket(Effect.succeed(ws))),
              Effect.flatMap((socket) => Effect.forkDetach(Effect.scoped(handler(socket))))
            )
          )
      })

      const data = Layer.mergeAll(AppClientFake).pipe(
        Layer.provideMerge(FakeBackend.layer),
        Layer.provideMerge(Session.layer),
        Layer.provideMerge(SecureStorage.layerMemory())
      )

      // The ProjectDO's side: Subscribe for one project, over the socket protocol with JSON.
      const server = RpcServer.layer(ProjectLiveRpcs).pipe(
        Layer.provide(
          ProjectLiveRpcs.toLayer(
            Effect.gen(function* () {
              const backend = yield* FakeBackend
              return { Subscribe: () => backend.subscribe(projectId) }
            })
          )
        ),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(Layer.mergeAll(SocketRpcSerialization, socketServer))
      )

      const layer = Layer.mergeAll(LiveProjects.layerSocket, server).pipe(
        Layer.provide(constructor),
        Layer.provideMerge(data)
      )

      yield* Effect.gen(function* () {
        const app = yield* AppClient
        const session = yield* Session
        const backend = yield* FakeBackend
        const signedIn = yield* app.DevSignIn({ email: "ada@example.com", secret: Redacted.make("x") })
        yield* session.signIn({ token: signedIn.sessionToken, user: signedIn.user })

        const live = yield* LiveProjects
        const events: Array<ProjectEvent["_tag"]> = []
        const fiber = yield* live.subscribe(projectId).pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event._tag))),
          Effect.forkChild
        )
        yield* settle("10 millis")
        assert.deepStrictEqual(events, ["Snapshot"])

        yield* backend.scenario("paused")
        yield* settle("10 millis")
        assert.deepStrictEqual(events, ["Snapshot", "StatusChanged", "WorkingChanged"])

        // The DO is evicted: it closes the socket.
        servers[0]?.close(1012, "evicted")
        yield* settle("1 second")
        assert.strictEqual(urls.length, 2)
        assert.notStrictEqual(urls[0], urls[1])
        assert.deepStrictEqual(events, ["Snapshot", "StatusChanged", "WorkingChanged", "Snapshot"])
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(layer))
    })
  )
})
