/**
 * The progress line without a model: picked from what the turn's steps already say (`Steps.ts` gives each step a
 * phrase where it has one, `Phrase.ts` makes them).
 *
 * Newest first, over the last `freshFor`:
 * 1. a phrase worth 3 or more: the plan's current step (Claude Code's `TodoWrite`), a sentence of the agent's or a
 *    helper's summarized thinking or narration that says what it's doing, a helper's task, Claude Code's own helper
 *    summaries, publishing;
 * 2. else a command's description ("Run the scorer tests" → "Running the scorer tests");
 * 3. else the agent's own `dream status --now` sentence.
 *
 * A phrase is used only if it's presentable and fits the phone in one line (`Line.ts`), as it is or with trailing
 * phrases dropped ("Setting up unit tests for the realtime session" → "Setting up unit tests"). Nothing is ever
 * cut mid-phrase; with nothing usable there's no line, and the phone shows only that the agent is working.
 */
import { check } from "./Line.ts"
import { presentable, shorter } from "./Phrase.ts"
import type { Step } from "./Steps.ts"

/** Steps older than this say what the agent was doing, not what it's doing. */
export const freshFor = 8 * 60_000

/**
 * A line stays up at least this long, unless something bigger replaces it (a new plan step, a helper starting,
 * publishing): a line that changes every minute reads as noise.
 */
export const holdFor = 2 * 60_000

export interface DeriveInput {
  readonly steps: ReadonlyArray<Step>
  readonly now: number
  /** The agent's latest `dream status --now` (or workstream `--now`) sentence this turn. */
  readonly statusNow?: string | undefined
  /** The line on screen, when it went up, and what it was worth. */
  readonly shown?: Shown | undefined
}

export interface Shown {
  readonly line: string
  readonly at: number
  readonly score: number
}

export interface Derived {
  readonly line: string
  readonly score: number
  /** Where it came from, for logs and the evaluation. */
  readonly source: Step["kind"] | "status" | "held" | "model"
}

/** The phrase as it fits on the phone, if it can be made to without cutting it. */
export const fitted = (phrase: string): string | undefined => {
  for (const form of [phrase, ...shorter(phrase)]) {
    const verdict = check(form)
    if (verdict._tag === "Fits" && presentable(verdict.text)) return verdict.text
  }
  return undefined
}

export const derive = (input: DeriveInput): Derived | undefined => {
  const fresh = input.steps.filter((step) => input.now - step.at <= freshFor && step.phrase !== undefined)
  const candidates = fresh
    .map((step) => ({ step, line: fitted(step.phrase!) }))
    .filter((candidate): candidate is { step: Step; line: string } => candidate.line !== undefined)
    .reverse()
  const best =
    candidates.find(({ step }) => (step.score ?? 0) >= 3) ?? candidates.find(({ step }) => (step.score ?? 0) >= 2.5)
  const status = input.statusNow === undefined ? undefined : fitted(input.statusNow)
  const picked: Derived | undefined =
    best !== undefined
      ? { line: best.line, score: best.step.score ?? 0, source: best.step.kind }
      : status !== undefined
        ? { line: status, score: 2, source: "status" }
        : undefined
  const shown = input.shown
  if (picked !== undefined && shown !== undefined && input.now - shown.at < holdFor && picked.score <= shown.score) {
    return { line: shown.line, score: shown.score, source: "held" }
  }
  return picked
}

/**
 * The D liveness signal: when the harness last did anything, and, when one long step (a command or a helper) is
 * all that's going on, since when.
 */
export const liveness = (steps: ReadonlyArray<Step>, lastEventAt: number) => {
  const last = steps.at(-1)
  return {
    activeAt: lastEventAt,
    waitingSince: last !== undefined && last.running && !last.helper ? last.at : undefined
  }
}
