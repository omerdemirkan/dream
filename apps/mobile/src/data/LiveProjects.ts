/**
 * The live stream of one project (`ProjectLiveRpcs.Subscribe`), over a
 * WebSocket to its ProjectDO.
 *
 * Each connection gets a fresh ticket URL from `GetLiveUrl`. The DO closes
 * sockets when it is evicted, and iOS drops them in the background, so any
 * close or failure means: wait a little, fetch a new URL, subscribe again. The
 * first event of every subscription is a `Snapshot`, which replaces what the
 * phone holds. Events this build doesn't know are skipped (`Tolerant.ts`).
 * Each drop is passed on as `Dropped`, so the screen can tell a connection
 * that keeps failing from one on its way.
 */
import { type ProjectEvent, type ProjectId, SocketRpcSerialization } from "@dream/domain"
import { Context, Effect, Layer, Schedule, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { Socket } from "effect/socket"
import { AppClient } from "./AppClient.ts"
import { PhoneProjectLiveRpcs } from "./Tolerant.ts"

/** A connection that failed or ended; the stream connects again after it. */
export const Dropped = { _tag: "Dropped" } as const

/** What a project's live stream carries: its events, and the drops between connections. */
export type LiveSignal = ProjectEvent | typeof Dropped

export class LiveProjects extends Context.Service<
  LiveProjects,
  {
    /** Never fails: it reconnects until the stream is no longer consumed. */
    readonly subscribe: (projectId: ProjectId) => Stream.Stream<LiveSignal>
  }
>()("@dream/mobile/LiveProjects") {
  static readonly layerSocket = Layer.effect(
    LiveProjects,
    Effect.gen(function* () {
      const app = yield* AppClient
      const constructor = yield* Socket.WebSocketConstructor

      const connectOnce = (projectId: ProjectId) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const { url } = yield* app.GetLiveUrl({ projectId })
            const protocol = RpcClient.layerProtocolSocket({
              pingInterval: "10 seconds",
              // Allow two intervals: a Pong that beats the timer's own drift would otherwise miss.
              pingTimeout: "20 seconds"
            }).pipe(
              Layer.provide(Socket.layerWebSocket(url)),
              Layer.provide(SocketRpcSerialization),
              Layer.provide(Layer.succeed(Socket.WebSocketConstructor, constructor))
            )
            // Built into the stream's scope: the socket lives exactly as long as this subscription.
            const services = yield* Layer.build(protocol)
            const client = yield* RpcClient.make(PhoneProjectLiveRpcs).pipe(Effect.provide(services))
            return client.Subscribe().pipe(Stream.filter((event): event is ProjectEvent => event !== null))
          })
        )

      return LiveProjects.of({
        subscribe: (projectId) =>
          connectOnce(projectId).pipe(
            Stream.map((event): LiveSignal => event),
            // A clean end (the DO finished the stream) is treated like a drop.
            Stream.concat(Stream.fail("ended" as const)),
            Stream.catchCause(() => Stream.succeed(Dropped).pipe(Stream.concat(Stream.fail("dropped" as const)))),
            Stream.retry(
              Schedule.min([Schedule.exponential("500 millis", 2), Schedule.spaced("15 seconds")]).pipe(
                Schedule.jittered
              )
            ),
            Stream.catchCause(() => Stream.empty)
          )
      })
    })
  )
}
