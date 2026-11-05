/**
 * One turn's stream of harness events, start to end. The harness pauses a
 * turn when the model calls the question tool (Claude Code's
 * `AskUserQuestion`) and waits for the host to answer; nobody here can, so
 * each question goes to the person's phone through `ask`, and the turn
 * continues with a tool result saying so. Along the way it keeps the text of
 * the last step, the turn's final words.
 */
import type { ToolResultPart, ToolSet } from "@ai-sdk/provider-utils"
import type { TextStreamPart } from "ai"
import { Effect, Option, Ref, Schema, Stream } from "effect"
import {
  type DreamQuestion,
  type QuestionOutcome,
  QuestionsInput,
  questionsToolName,
  questionsToolOutput,
  toDreamQuestion
} from "./PersonChannel.ts"

export type Part = TextStreamPart<ToolSet>

export interface TurnStreams<E> {
  /** The turn as the prompt started it. */
  readonly start: Stream.Stream<Part, E>
  /** The paused turn, continued with results for the question calls it was waiting on. */
  readonly answer: (results: ReadonlyArray<ToolResultPart>) => Stream.Stream<Part, E>
}

export interface TurnHandlers {
  /** Put a question in front of the person (`dream ask`). */
  readonly ask: (question: DreamQuestion) => Effect.Effect<QuestionOutcome>
}

/** Questions one turn may send; past that the model is told to use `dream ask`, which it can pace itself. */
const maxQuestionsPerTurn = 8
/** A model that keeps calling the tool after that is stopped here. */
const maxRounds = 20

type Pending = { readonly toolCallId: string; readonly toolName: string; readonly input: unknown }

const decodeQuestions = Schema.decodeUnknownOption(QuestionsInput)

/** Send a question call's questions and build its tool result. */
const answerCall = (call: Pending, ask: TurnHandlers["ask"]) =>
  Effect.gen(function* () {
    const input = decodeQuestions(call.input)
    if (Option.isNone(input)) {
      yield* Effect.logWarning("The agent's question call had no questions Dream could read", { input: call.input })
    }
    const questions = Option.match(input, { onNone: () => [], onSome: (input) => input.questions })
    const outcomes = yield* Effect.forEach(questions, (question) =>
      Option.match(toDreamQuestion(question), {
        onNone: () => Effect.succeed<QuestionOutcome>({ _tag: "NotSent", reason: "it had no question text" }),
        onSome: ask
      })
    )
    yield* Effect.logInfo("Sent the agent's questions to the person", { questions: outcomes.length })
    const output = Option.match(input, {
      onNone: () => ({ action: "answered" as const, answers: {} }),
      onSome: (input) => questionsToolOutput(input, outcomes)
    })
    return {
      type: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: { type: "json", value: output }
    } satisfies ToolResultPart
  })

/**
 * Run the turn to its end, answering question calls as they come. Every part
 * also goes to `onPart`. Returns the final step's text.
 */
export const drive = <E, R>(
  streams: TurnStreams<E>,
  handlers: TurnHandlers,
  onPart: (part: Part) => Effect.Effect<void, never, R>
): Effect.Effect<{ readonly finalText: string }, E, R> =>
  Effect.gen(function* () {
    const finalText = yield* Ref.make("")
    const pending = yield* Ref.make<ReadonlyArray<Pending>>([])
    const consume = (stream: Stream.Stream<Part, E>) =>
      stream.pipe(
        Stream.runForEach((part) =>
          Effect.gen(function* () {
            switch (part.type) {
              case "start-step":
              case "tool-result":
                yield* Ref.set(finalText, "")
                break
              case "tool-call":
                yield* Ref.set(finalText, "")
                if (part.toolName === questionsToolName && part.providerExecuted !== true) {
                  const call = { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input }
                  yield* Ref.update(pending, (all) => [...all, call])
                }
                break
              case "text-delta":
                yield* Ref.update(finalText, (text) => text + part.text)
                break
            }
            yield* onPart(part)
          })
        )
      )

    const sent = yield* Ref.make(0)
    const ask = (question: DreamQuestion) =>
      Ref.getAndUpdate(sent, (n) => n + 1).pipe(
        Effect.flatMap((n) =>
          n < maxQuestionsPerTurn
            ? handlers.ask(question)
            : Effect.succeed<QuestionOutcome>({
                _tag: "NotSent",
                reason: `Dream already sent ${maxQuestionsPerTurn} questions from this turn`
              })
        )
      )

    yield* consume(streams.start)
    for (let round = 1; ; round++) {
      const calls = yield* Ref.getAndSet(pending, [])
      if (calls.length === 0) break
      if (round > maxRounds) {
        yield* Effect.logWarning("The agent kept calling its harness's question tool; leaving the turn paused")
        break
      }
      const results = yield* Effect.forEach(calls, (call) => answerCall(call, ask))
      yield* consume(streams.answer(results))
    }
    return { finalText: yield* Ref.get(finalText) }
  })
