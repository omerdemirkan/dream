/**
 * What the small model sees when it writes a progress line: what started the turn, how long it has run, the line on
 * their screen now, and the turn's last few steps. Never the conversation: only this turn, and only its tail.
 *
 * The window is the last `windowSteps` steps, oldest first, each with how long ago it began. The two newest thoughts
 * keep up to 600 characters (they say best what the agent is up to and why); older ones shrink to 160. If it's still
 * over `windowChars`, the oldest steps go first.
 */
import { clip, filesText, type Step } from "./Steps.ts"

/** Steps in a window. Twelve covers a few minutes of busy work, or the whole stretch since a long command started. */
export const windowSteps = 12
/** The most a window renders to, about 1,000 tokens. */
export const windowChars = 4000

export interface WindowInput {
  /** What started the turn, as one short line ("They wrote: …"). */
  readonly trigger?: string | undefined
  readonly startedAt: number
  readonly now: number
  /** The line on their screen now, if one was written this turn. */
  readonly previous?: string | undefined
  readonly steps: ReadonlyArray<Step>
}

/** "now", "40s ago", "4m ago". */
export const ago = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 10) return "now"
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.round(seconds / 60)}m ago`
}

/** "40 seconds", "35 minutes", "1 hour 5 minutes". */
export const duration = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))} seconds`
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const h = hours === 1 ? "1 hour" : `${hours} hours`
  return rest === 0 ? h : `${h} ${rest === 1 ? "1 minute" : `${rest} minutes`}`
}

const label: Record<Step["kind"], string> = {
  command: "ran",
  files: "",
  web: "",
  helper: "",
  plan: "",
  thought: "thought",
  said: "wrote",
  dream: "",
  other: ""
}

export const renderStep = (step: Step, now: number, thoughtMax: number) => {
  const body =
    step.kind === "files" ? filesText(step) : step.kind === "thought" ? clip(step.text, thoughtMax) : step.text
  const head = label[step.kind]
  const notes = [
    step.count > 1 ? `×${step.count}` : undefined,
    step.failed ? "(failed)" : undefined,
    step.running ? `(still running, ${duration(now - step.at)} so far)` : undefined
  ].filter((note) => note !== undefined)
  return `- ${ago(now - step.at)} · ${head === "" ? "" : `${head}: `}${body}${notes.length === 0 ? "" : ` ${notes.join(" ")}`}`
}

const renderSteps = (steps: ReadonlyArray<Step>, now: number) => {
  const thoughts = steps.flatMap((step, index) => (step.kind === "thought" ? [index] : []))
  const recent = new Set(thoughts.slice(-2))
  return steps.map((step, index) => renderStep(step, now, recent.has(index) ? 600 : 160))
}

export const render = (input: WindowInput): string => {
  let steps = input.steps.slice(-windowSteps)
  const head = [
    `What started this turn: ${input.trigger ?? "something the agent scheduled for itself"}`,
    `The turn has run ${duration(input.now - input.startedAt)}.`,
    `The line on their screen now: ${input.previous === undefined ? "none yet" : `“${input.previous}”`}`,
    "",
    steps.length === 0 ? "The agent hasn't done anything yet this turn." : "The agent's latest steps, oldest first:"
  ]
  let lines = renderSteps(steps, input.now)
  while (steps.length > 1 && [...head, ...lines].join("\n").length > windowChars) {
    steps = steps.slice(1)
    lines = renderSteps(steps, input.now)
  }
  return [...head, ...lines].join("\n")
}
