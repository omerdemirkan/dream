/**
 * Answering questions. Answers go out at once (the API ignores an answer the
 * question already has, so a retry is safe), and a question can be changed
 * later.
 */
import type { MessageId, ProjectId, QuestionAnswer, QuestionMessage } from "@dream/domain"
import { Context, Effect, Layer } from "effect"
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

/** Reactivity keys refreshed after anything that changes what needs them (Home's rows count it). */
export const asksChanged = ["projects"] as const

export class Answers extends Context.Service<
  Answers,
  {
    readonly answerNow: (input: AnswerInput) => Effect.Effect<QuestionMessage, AnswerFailure>
  }
>()("@dream/mobile/Answers") {
  static readonly layer = Layer.effect(
    Answers,
    Effect.gen(function* () {
      const app = yield* AppClient
      const reactivity = yield* Reactivity.Reactivity
      return Answers.of({
        answerNow: Effect.fn("Answers.answerNow")(function* (input: AnswerInput) {
          const result = yield* app.AnswerQuestion(input).pipe(
            withWriteTimeout,
            Effect.mapError((error): AnswerFailure => ({ input, message: describeError(error) }))
          )
          yield* reactivity.invalidate(asksChanged)
          return result
        })
      })
    })
  )
}
