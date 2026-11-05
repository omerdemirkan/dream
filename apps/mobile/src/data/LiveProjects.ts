/**
 * The live stream of one project (`ProjectLiveRpcs.Subscribe`), over a
 * WebSocket to its ProjectDO.
 *
 * Each connection gets a fresh ticket URL from `GetLiveUrl`. The DO closes
 * sockets when it is evicted, and iOS drops them in the background, so any
 * close or failure means: wait a little, fetch a new URL, subscribe again. The
 * first event of every subscription is a `Snapshot`, which replaces what the
 * phone holds.
 */
import { type ProjectEvent, type ProjectId, ProjectLiveRpcs, SocketRpcSerialization } from "@dream/domain"
import { Context, Effect, Layer, Schedule, Stream } from "effect"
import { RpcClient } from "effect/rpc"
import { Socket } from "effect/socket"
import { AppClient } from "./AppClient.ts"

export class LiveProjects extends Context.Service<
  LiveProjects,
  {
    /** Never fails: it reconnects until the stream is no longer consumed. */
    readonly subscribe: (projectId: ProjectId) => Stream.Stream<ProjectEvent>
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
            const client = yield* RpcClient.make(ProjectLiveRpcs).pipe(Effect.provide(services))
            return client.Subscribe()
          })
        )

      return LiveProjects.of({
        subscribe: (projectId) =>
          connectOnce(projectId).pipe(
            // A clean end (the DO finished the stream) is treated like a drop.
            Stream.concat(Stream.fail("ended" as const)),
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
