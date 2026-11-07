/**
 * What dreamd itself tells the API: when turns start and finish, where the
 * subscription stands, and that the sandbox should stay awake or may go back to sleep. These go to `Routes.sandbox`
 * with the project token.
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
  type TaskReport,
  type TurnUsage,
  type UsageSnapshot
} from "@dream/domain"
import { Cause, Context, Data, type DateTime, Effect, Layer, Redacted, Ref, Schedule } from "effect"
import { FetchHttpClient, Headers } from "effect/http"
import { RpcClient, RpcMiddleware } from "effect/rpc"
import { DreamdConfig } from "./Config.ts"
import type { DreamQuestion } from "./harness/PersonChannel.ts"

export type Report =
  | {
      readonly _tag: "Turn"
      readonly state: "started" | "finished"
      readonly eventIds: ReadonlyArray<EventId>
      readonly usage?: TurnUsage
    }
  | { readonly _tag: "Usage"; readonly usage: UsageSnapshot }
  | { readonly _tag: "Task"; readonly task: TaskReport }
  | { readonly _tag: "Question"; readonly question: DreamQuestion }
  | { readonly _tag: "Message"; readonly text: string }
  | { readonly _tag: "Publish"; readonly port: number }
  | { readonly _tag: "StayAwake"; readonly reason: AwakeReason }
  | { readonly _tag: "Sleep"; readonly reason: SleepReason; readonly checkedAt: DateTime.Utc }
  | { readonly _tag: "Progress"; readonly progress: ProgressReport }

/** `ReportProgress`'s payload. */
export interface ProgressReport {
  readonly line?: string
  readonly activeAt: DateTime.Utc
  readonly waitingSince?: DateTime.Utc
}

/** Why dreamd asks to keep the sandbox up. */
export type AwakeReason = "command" | "app" | "relay"
/** What dreamd woke for and has finished, when it asks to sleep. */
export type SleepReason = "command" | "relay"

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
    /** `usage`, with "finished", is what the turn used of the model. */
    readonly reportTurn: (
      state: "started" | "finished",
      eventIds: ReadonlyArray<EventId>,
      usage?: TurnUsage
    ) => Effect.Effect<void>
    readonly reportUsage: (usage: UsageSnapshot) => Effect.Effect<void>
    /** A scheduled task's session finished (`dream wake --task`). */
    readonly reportTask: (report: TaskReport) => Effect.Effect<void>
    /** What the running turn is doing. Once, with no retries: a lost report is replaced by the next. */
    readonly reportProgress: (progress: ProgressReport) => Effect.Effect<void>
    /** Once, with no retries: the caller asks again a minute later. A Worker older than `StayAwake` fails it. */
    readonly stayAwake: (reason: AwakeReason) => Effect.Effect<void, ApiError>
    /** Once, with no retries. A Worker older than `Sleep` fails it, and the sandbox sleeps on its timeout. */
    readonly sleep: (reason: SleepReason, checkedAt: DateTime.Utc) => Effect.Effect<void, ApiError>
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
        reportTurn: (state, eventIds, usage) =>
          report(`turn ${state}`, client.ReportTurn({ state, eventIds, ...(usage === undefined ? {} : { usage }) })),
        reportUsage: (usage) => report("usage", client.ReportUsage({ usage })),
        reportTask: (task) => report("a task's run", client.ReportTask(task)),
        reportProgress: (progress) =>
          client.ReportProgress(progress).pipe(
            Effect.timeout("15 seconds"),
            Effect.catchCause((cause) => Effect.logWarning("Couldn't report the progress line", cause))
          ),
        stayAwake: (reason) =>
          client.StayAwake({ reason }).pipe(
            Effect.timeout("30 seconds"),
            Effect.catchCause((cause) =>
              Effect.fail(new ApiError({ message: Cause.pretty(cause).split("\n")[0] ?? "failed" }))
            )
          ),
        sleep: (reason, checkedAt) =>
          client.Sleep({ reason, checkedAt }).pipe(
            Effect.timeout("30 seconds"),
            Effect.catchCause((cause) =>
              Effect.fail(new ApiError({ message: Cause.pretty(cause).split("\n")[0] ?? "failed" }))
            )
          ),
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
        reportTurn: (state, eventIds, usage) =>
          Ref.update(
            reports,
            (all): ReadonlyArray<Report> => [
              ...all,
              { _tag: "Turn", state, eventIds, ...(usage === undefined ? {} : { usage }) }
            ]
          ),
        reportUsage: (usage) => Ref.update(reports, (all): ReadonlyArray<Report> => [...all, { _tag: "Usage", usage }]),
        reportTask: (task) => Ref.update(reports, (all): ReadonlyArray<Report> => [...all, { _tag: "Task", task }]),
        reportProgress: (progress) =>
          Ref.update(reports, (all): ReadonlyArray<Report> => [...all, { _tag: "Progress", progress }]),
        stayAwake: (reason) =>
          Ref.update(reports, (all): ReadonlyArray<Report> => [...all, { _tag: "StayAwake", reason }]),
        sleep: (reason, checkedAt) =>
          Ref.update(reports, (all): ReadonlyArray<Report> => [...all, { _tag: "Sleep", reason, checkedAt }]),
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
