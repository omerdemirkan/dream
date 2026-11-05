/**
 * Replies typed into a notification: an answer to a question, or a message to the project.
 *
 * Nothing on screen holds that text, so it must not be lost when sending fails. A reply is retried a few times
 * while the failure is the connection's or a service's (the message carries a request id and the API ignores an
 * answer the question already has, so a retry can't post twice). If it still doesn't go through, the text is kept
 * on the phone as a draft, where the person finds it: in the project's Chat composer, or in the question's
 * "Something else…" field. Drafts are kept in the keychain, so they outlive the app being closed.
 */
import {
  type InvalidRequest,
  type MessageId,
  type NotFound,
  type ProjectId,
  QuestionAnswer,
  type QuestionMessage,
  RequestId,
  type TextMessage,
  type Unauthorized
} from "@dream/domain"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { AppClient } from "./AppClient.ts"
import type { RpcClientError } from "effect/rpc/RpcClientError"
import { type RequestTimedOut, withWriteTimeout } from "./errors.ts"
import { SecureStorage } from "./SecureStorage.ts"

/** Where a reply goes, and so where its draft is shown. */
export type ReplyTarget =
  | { readonly _tag: "Chat"; readonly projectId: ProjectId }
  | { readonly _tag: "Answer"; readonly projectId: ProjectId; readonly messageId: MessageId }

export type Reply = ReplyTarget & { readonly text: string; readonly requestId: RequestId }

export type ReplyError = NotFound | InvalidRequest | Unauthorized | RpcClientError | RequestTimedOut

export const draftKey = (target: ReplyTarget): string =>
  target._tag === "Chat" ? `chat:${target.projectId}` : `answer:${target.messageId}`

const DraftsKey = "dream.drafts"
/** A kept reply. A message keeps its request id, so sending it from Chat can't post it twice if it got through. */
export const Draft = Schema.Struct({ text: Schema.String, requestId: Schema.optionalKey(RequestId) })
export type Draft = typeof Draft.Type

const DraftsJson = Schema.fromJsonString(Schema.Record(Schema.String, Draft))
const decodeDrafts = Schema.decodeUnknownOption(DraftsJson)
const encodeDrafts = Schema.encodeSync(DraftsJson)

/** Failures worth trying again: the transport, or a timeout. */
const transient = (error: ReplyError): boolean => error._tag === "RpcClientError" || error._tag === "RequestTimedOut"

/** Waits between tries: 2 s, then 4 s, then 8 s. */
export const replyRetries = Schedule.exponential(Duration.seconds(2))
export const replyRetryTimes = 3

export class Replies extends Context.Service<
  Replies,
  {
    /** Sends a reply, retrying transient failures; when it still fails, the text is kept as its target's draft. */
    readonly send: (reply: Reply) => Effect.Effect<TextMessage | QuestionMessage, ReplyError>
    /** The draft kept under `draftKey(target)`. */
    readonly draft: (key: string) => Effect.Effect<Option.Option<Draft>>
    readonly keepDraft: (target: ReplyTarget, draft: Draft) => Effect.Effect<void>
    readonly clearDraft: (target: ReplyTarget) => Effect.Effect<void>
  }
>()("@dream/mobile/Replies") {
  static readonly layer = Layer.effect(
    Replies,
    Effect.gen(function* () {
      const app = yield* AppClient
      const storage = yield* SecureStorage

      const all = storage.get(DraftsKey).pipe(
        Effect.map((stored) =>
          Option.getOrElse(Option.flatMap(stored, decodeDrafts), (): Record<string, Draft> => ({}))
        ),
        Effect.orElseSucceed((): Record<string, Draft> => ({}))
      )
      const update = (f: (drafts: Record<string, Draft>) => Record<string, Draft>) =>
        Effect.flatMap(all, (drafts) => {
          const next = f(drafts)
          return Object.keys(next).length === 0 ? storage.remove(DraftsKey) : storage.set(DraftsKey, encodeDrafts(next))
        }).pipe(Effect.ignore)

      const keepDraft = (target: ReplyTarget, draft: Draft) =>
        update((drafts) => ({ ...drafts, [draftKey(target)]: draft }))
      const clearDraft = (target: ReplyTarget) =>
        update((drafts) => {
          const { [draftKey(target)]: _, ...rest } = drafts
          return rest
        })

      const attempt = (
        reply: Reply
      ): Effect.Effect<TextMessage | QuestionMessage, NotFound | InvalidRequest | Unauthorized | RpcClientError> =>
        reply._tag === "Chat"
          ? app.SendMessage({ projectId: reply.projectId, text: reply.text, requestId: reply.requestId })
          : app.AnswerQuestion({
              projectId: reply.projectId,
              messageId: reply.messageId,
              answer: QuestionAnswer.cases.Freeform.make({ text: reply.text })
            })

      const send = Effect.fn("Replies.send")(function* (reply: Reply) {
        return yield* attempt(reply).pipe(
          withWriteTimeout,
          Effect.retry({ schedule: replyRetries, times: replyRetryTimes, while: transient }),
          Effect.tapError(() =>
            keepDraft(
              reply,
              reply._tag === "Chat" ? { text: reply.text, requestId: reply.requestId } : { text: reply.text }
            )
          )
        )
      })

      return Replies.of({
        send,
        draft: (key) => Effect.map(all, (drafts) => Option.fromUndefinedOr(drafts[key])),
        keepDraft,
        clearDraft
      })
    })
  )
}
