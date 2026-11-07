/**
 * What turns a running turn's steps into a progress line. Today it's `modelFree` (`Derive.ts`): no model, no cost,
 * no terms question.
 *
 * A model can come later, behind this same interface, if the founder wants one: dreamd would send the rendered
 * window (`Window.ts`, never the conversation) to the Worker, which calls a small model with Dream's own API key
 * (the key never enters the sandbox) and answers with the line, checked against the same one-line limit. It must
 * never run on the person's subscription (docs/proposals/sidecar-terms.html).
 */
import { Context, Effect, Layer, Option } from "effect"
import { type Derived, derive, type Shown } from "./Derive.ts"
import type { Step } from "./Steps.ts"

export interface SummaryInput {
  readonly steps: ReadonlyArray<Step>
  readonly trigger: string | undefined
  readonly startedAt: number
  readonly now: number
  /** The line on their screen now, when it went up and what it was worth. */
  readonly shown: Shown | undefined
  readonly statusNow: string | undefined
}

export class Summarizer extends Context.Service<
  Summarizer,
  {
    readonly name: string
    readonly summarize: (input: SummaryInput) => Effect.Effect<Option.Option<Derived>>
  }
>()("@dream/dreamd/Summarizer") {
  static readonly modelFree = Layer.succeed(
    Summarizer,
    Summarizer.of({
      name: "model-free",
      summarize: (input) => Effect.succeed(Option.fromNullishOr(derive(input)))
    })
  )
}
