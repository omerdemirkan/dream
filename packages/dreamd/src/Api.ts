/**
 * What dreamd itself tells the API: when turns start and finish, and where the
 * subscription stands. These go to `Routes.sandbox` with the project token.
 * Reports are best effort: a few retries, then a log line. Losing one only
 * costs a stale "working" badge or usage bar until the next.
 *
 * It also speaks for the agent when the agent used a channel nobody sees
 * (see `PersonChannel.ts`): its harness's question tool, or a final reply
 * left in the session. Those fail with `ApiError` so the caller can say so.
 */
import {
  type EventId,
  HttpRpcSerialization,
  type InvalidRequest,
  type MessageId,
  Routes,
  SandboxAuth,
  SandboxRpcs,
  type UsageSnapshot
} from "@dream/domain"
import { Context, Data, Effect, Layer, Redacted, Ref, Schedule } from "effect"
import { FetchHttpClient, Headers } from "effect/http"
import { RpcClient, RpcMiddleware } from "effect/rpc"
import { DreamdConfig } from "./Config.ts"
import type { DreamQuestion } from "./harness/PersonChannel.ts"

export type Report =
  | { readonly _tag: "Turn"; readonly state: "started" | "finished"; readonly eventIds: ReadonlyArray<EventId> }
  | { readonly _tag: "Usage"; readonly usage: UsageSnapshot }
  | { readonly _tag: "Question"; readonly question: DreamQuestion }
  | { readonly _tag: "Message"; readonly text: string }
  | { readonly _tag: "Publish"; readonly port: number }

/** A call made for the agent didn't go through. */
export class ApiError extends Data.TaggedError("ApiError")<{ readonly message: string }> {}

/** An RPC client for `SandboxRpcs` on the Worker, authenticated with the project token. */
export const layerClient = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DreamdConfig
    const bearer = `Bearer ${Redacted.value(config.projectToken)}`
    return Layer.mergeAll(
      RpcClient.layerProtocolHttp({ url: `${config.apiUrl}${Routes.sandbox}` }).pipe(
        Layer.provide([FetchHttpClient.layer, HttpRpcSerialization])
      ),
      RpcMiddleware.layerClient(SandboxAuth, ({ request, next }) =>
        next({ ...request, headers: Headers.set(request.headers, "authorization", bearer) })
      )
    )
  })
)

export class Api extends Context.Service<
  Api,
  {
    readonly reportTurn: (state: "started" | "finished", eventIds: ReadonlyArray<EventId>) => Effect.Effect<void>
    readonly reportUsage: (usage: UsageSnapshot) => Effect.Effect<void>
    /** `dream ask` on the agent's behalf. */
    readonly askQuestion: (question: DreamQuestion) => Effect.Effect<MessageId, ApiError>
    /** `dream message` on the agent's behalf, without a notification. */
    readonly sendMessage: (text: string) => Effect.Effect<MessageId, ApiError>
    /**
     * The project's public URL, asking again for the port the agent published (`Publish` is idempotent).
     * `InvalidRequest` means the API won't publish that port.
     */
    readonly publishedUrl: (port: number) => Effect.Effect<string, ApiError | InvalidRequest>
  }
>()("@dream/dreamd/Api") {
  static readonly layer = Layer.effect(
    Api,
    Effect.gen(function* () {
      const client = yield* RpcClient.make(SandboxRpcs)
      const report = <E>(what: string, effect: Effect.Effect<void, E>) =>
        effect.pipe(
          Effect.retry({ schedule: Schedule.exponential("1 second"), times: 4 }),
          Effect.catchCause((cause) => Effect.logWarning(`Couldn't report ${what}`, cause))
        )
      const speak = <A extends { readonly id: MessageId }, E extends { readonly message: string }>(
        effect: Effect.Effect<A, E>
      ) =>
        effect.pipe(
          Effect.retry({ schedule: Schedule.exponential("1 second"), times: 2 }),
          Effect.map((message) => message.id),
          Effect.mapError((error) => new ApiError({ message: error.message }))
        )
      return Api.of({
        reportTurn: (state, eventIds) => report(`turn ${state}`, client.ReportTurn({ state, eventIds })),
        reportUsage: (usage) => report("usage", client.ReportUsage({ usage })),
        askQuestion: (question) => speak(client.AskQuestion(question)),
        sendMessage: (text) =>
          text.trim().length === 0
            ? Effect.fail(new ApiError({ message: "the message is empty" }))
            : speak(client.SendMessage({ text, media: [], notify: false })),
        publishedUrl: (port) =>
          client.Publish({ port }).pipe(
            Effect.map(({ url }) => url),
            Effect.catchTags({
              RpcClientError: (error) => Effect.fail(new ApiError({ message: error.message })),
              Unauthorized: (error) => Effect.fail(new ApiError({ message: error.message }))
            })
          )
      })
    })
  ).pipe(Layer.provide(layerClient))

  /** Records reports, questions and messages instead of sending them; each message gets the id `msg_<n>`. */
  static readonly layerTest = (reports: Ref.Ref<ReadonlyArray<Report>>) =>
    Layer.succeed(
      Api,
      Api.of({
        reportTurn: (state, eventIds) =>
          Ref.update(reports, (all): ReadonlyArray<Report> => [...all, { _tag: "Turn", state, eventIds }]),
        reportUsage: (usage) => Ref.update(reports, (all): ReadonlyArray<Report> => [...all, { _tag: "Usage", usage }]),
        askQuestion: (question) =>
          Ref.modify(reports, (all) => [
            `msg_${all.length + 1}` as MessageId,
            [...all, { _tag: "Question", question } satisfies Report]
          ]),
        sendMessage: (text) =>
          Ref.modify(reports, (all) => [
            `msg_${all.length + 1}` as MessageId,
            [...all, { _tag: "Message", text } satisfies Report]
          ]),
        publishedUrl: (port) =>
          Ref.update(reports, (all): ReadonlyArray<Report> => [...all, { _tag: "Publish", port }]).pipe(
            Effect.as(`https://port-${port}.dream.test`)
          )
      })
    )
}
