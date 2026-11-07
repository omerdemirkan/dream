/**
 * Deliver an event to dreamd the way the ProjectDO does, for testing.
 *
 *   node packages/dreamd/scripts/deliver.ts <daemon-url> <daemon-token> message "text"
 *   node packages/dreamd/scripts/deliver.ts <daemon-url> <daemon-token> reply "text" <message-id> text|question|access "excerpt" [open]
 *   node packages/dreamd/scripts/deliver.ts <daemon-url> <daemon-token> wake "why" "command"
 *   node packages/dreamd/scripts/deliver.ts <daemon-url> <daemon-token> task "why" "brief" [model] [effort]
 *   node packages/dreamd/scripts/deliver.ts <daemon-url> <daemon-token> reset fiveHour|weekly
 *   node packages/dreamd/scripts/deliver.ts <daemon-url> <daemon-token> health
 *
 * `<daemon-url>` is the origin of dreamd's port, e.g. http://127.0.0.1:4747 or
 * https://4747-<sandbox>.e2b.app. Set E2B_TRAFFIC_TOKEN to send the
 * `e2b-traffic-access-token` header.
 */
import {
  AgentEvent,
  DaemonAuth,
  DaemonRpcs,
  EventId,
  HttpRpcSerialization,
  MessageId,
  ReasoningEffort,
  Routes,
  ThreadKind,
  WakeId
} from "@dream/domain"
import { NodeRuntime } from "@effect/platform-node"
import { Console, DateTime, Effect, Layer, Schema } from "effect"
import { FetchHttpClient, Headers, HttpClient, HttpClientRequest } from "effect/http"
import { RpcClient, RpcMiddleware } from "effect/rpc"

const [url, token, kind = "health", text = "", command, model = "haiku", effort = "low", open] = process.argv.slice(2)
if (url === undefined || token === undefined) {
  console.error("usage: deliver.ts <daemon-url> <daemon-token> message|wake|task|reset|health [text] [command|brief]")
  process.exit(2)
}
const trafficToken = process.env.E2B_TRAFFIC_TOKEN

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(DaemonRpcs)
  if (kind === "health") return yield* Console.log(JSON.stringify(yield* client.Health()))
  const at = yield* DateTime.now
  const n = Date.now().toString(36)
  const event =
    kind === "reset"
      ? AgentEvent.cases.UsageReset.make({
          id: EventId.make(`evt_${n}`),
          at,
          window: text === "weekly" ? "weekly" : "fiveHour"
        })
      : kind === "wake" || kind === "task"
        ? AgentEvent.cases.WakeDue.make({
            id: EventId.make(`evt_${n}`),
            at,
            wakeId: WakeId.make(`wak_${n}`),
            why: text,
            ...(command === undefined
              ? {}
              : kind === "task"
                ? { task: { brief: command, model, effort: Schema.decodeUnknownSync(ReasoningEffort)(effort) } }
                : { run: { command } })
          })
        : AgentEvent.cases.UserMessage.make({
            id: EventId.make(`evt_${n}`),
            at,
            messageId: MessageId.make(`msg_${n}`),
            text,
            // `reply`: written in the thread on <message-id>, an agent's message of that kind.
            ...(kind === "reply" && command !== undefined
              ? {
                  thread: {
                    messageId: MessageId.make(command),
                    from: "agent" as const,
                    kind: Schema.decodeUnknownSync(ThreadKind)(model),
                    excerpt: effort,
                    ...(model === "text" ? {} : { open: open === "open" })
                  }
                }
              : {})
          })
  const result = yield* client.Deliver({ events: [event], timeZone: "America/Los_Angeles" })
  yield* Console.log(JSON.stringify(result))
})

program.pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      RpcClient.layerProtocolHttp({
        url: `${url}${Routes.daemon}`,
        transformClient: (client) =>
          trafficToken === undefined
            ? client
            : HttpClient.mapRequest(client, HttpClientRequest.setHeader("e2b-traffic-access-token", trafficToken))
      }).pipe(Layer.provide([FetchHttpClient.layer, HttpRpcSerialization])),
      RpcMiddleware.layerClient(DaemonAuth, ({ request, next }) =>
        next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) })
      )
    )
  ),
  NodeRuntime.runMain
)
