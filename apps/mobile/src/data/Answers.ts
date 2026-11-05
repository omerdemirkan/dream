/**
 * Answering questions, with Undo.
 *
 * On Home an answer leaves the deck at once, and a toast offers Undo for a few
 * seconds. The answer is held on the phone for that window and only then sent,
 * so Undo never has to take anything back from the agent. Everywhere else
 * (Chat, the expanded view) answers go out immediately, and a question can
 * still be changed later.
 */
import type { MessageId, ProjectId, QuestionAnswer, QuestionMessage } from "@dream/domain"
import { Context, Duration, Effect, FiberMap, Layer, PubSub, Stream, SubscriptionRef } from "effect"
import { Reactivity } from "effect/reactivity"
import { AppClient } from "./AppClient.ts"
import { describeError, withWriteTimeout } from "./errors.ts"

export interface AnswerInput {
  readonly projectId: ProjectId
  readonly messageId: MessageId
  readonly answer: QuestionAnswer
}

export interface AnswerFailure {
  readonly input: AnswerInput
  readonly message: string
}

/** How long Undo is offered (the toast's lifetime in the mock). */
export const undoWindow = Duration.millis(4200)

/** Reactivity keys refreshed after anything that changes what needs them. */
export const asksChanged = ["asks", "projects"] as const

export class Answers extends Context.Service<
  Answers,
  {
    /** Answers held for the undo window, by question. The UI treats them as answered. */
    readonly pending: SubscriptionRef.SubscriptionRef<ReadonlyMap<MessageId, AnswerInput>>
    readonly failures: Stream.Stream<AnswerFailure>
    readonly answerNow: (input: AnswerInput) => Effect.Effect<QuestionMessage, AnswerFailure>
    readonly answerUndoable: (input: AnswerInput) => Effect.Effect<void>
    /** Takes back a held answer. False if it was already sent. */
    readonly undo: (messageId: MessageId) => Effect.Effect<boolean>
    /** Sends every held answer now, e.g. when the app goes to the background. */
    readonly flush: Effect.Effect<void>
  }
>()("@dream/mobile/Answers") {
  static readonly layer = Layer.effect(
    Answers,
    Effect.gen(function* () {
      const app = yield* AppClient
      const reactivity = yield* Reactivity.Reactivity
      const pending = yield* SubscriptionRef.make<ReadonlyMap<MessageId, AnswerInput>>(new Map())
      const failures = yield* PubSub.unbounded<AnswerFailure>()
      const timers = yield* FiberMap.make<MessageId>()
      /** Answers whose undo window has closed: they're being sent and can't be taken back. */
      const sending = new Set<MessageId>()

      const forget = (messageId: MessageId) =>
        SubscriptionRef.update(pending, (map) => {
          const next = new Map(map)
          next.delete(messageId)
          return next
        })

      const answerNow = Effect.fn("Answers.answerNow")(function* (input: AnswerInput) {
        // The API ignores an answer the question already has, so a retry after a timeout is safe.
        const result = yield* app.AnswerQuestion(input).pipe(
          withWriteTimeout,
          Effect.mapError((error): AnswerFailure => ({ input, message: describeError(error) }))
        )
        yield* reactivity.invalidate(asksChanged)
        return result
      })

      const commit = (input: AnswerInput) =>
        Effect.sync(() => sending.add(input.messageId)).pipe(
          Effect.andThen(answerNow(input)),
          Effect.catch((failure) => PubSub.publish(failures, failure)),
          Effect.ensuring(
            forget(input.messageId).pipe(Effect.andThen(Effect.sync(() => sending.delete(input.messageId))))
          ),
          Effect.asVoid
        )

      return Answers.of({
        pending,
        failures: Stream.fromPubSub(failures),
        answerNow,
        answerUndoable: Effect.fn("Answers.answerUndoable")(function* (input: AnswerInput) {
          yield* SubscriptionRef.update(pending, (map) => new Map(map).set(input.messageId, input))
          yield* FiberMap.run(timers, input.messageId, Effect.sleep(undoWindow).pipe(Effect.andThen(commit(input))))
        }),
        undo: Effect.fn("Answers.undo")(function* (messageId: MessageId) {
          const held = (yield* SubscriptionRef.get(pending)).has(messageId)
          if (!held || sending.has(messageId)) return false
          yield* FiberMap.remove(timers, messageId)
          yield* forget(messageId)
          return true
        }),
        flush: Effect.gen(function* () {
          for (const input of (yield* SubscriptionRef.get(pending)).values()) {
            if (!sending.has(input.messageId)) yield* FiberMap.run(timers, input.messageId, commit(input))
          }
        })
      })
    })
  )
}
