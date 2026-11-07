/**
 * A small model's instructions for a progress line, and the follow-up when a line comes back too long, for
 * `compare.ts` (and a later Worker-side summariser on Dream's own key, if the founder wants one). The window
 * (`src/progress/Window.ts`) is the only other thing it sees.
 */
import { targetChars } from "../../src/progress/Line.ts"

/** Marks the request, so the fake model servers know what's being asked (`scripts/fake-*.ts`). */
export const marker = "dream-progress-line"

export const system = `You write the one line a person sees under "Working" while an AI agent builds something for them (${marker}). The agent is in the middle of a long stretch of work and hasn't messaged them for a while. Your line tells them what it is doing right now, in the agent's own voice, so they can see it's making progress.

How to write it:
- Start with what's happening, as an -ing verb, with the "I'm" left out: "Testing the scorer on recordings of pero and perro".
- Name the real thing in their words (the slip detector, Monday's digest, the sign-in page), not files, commands, tools or code. Never mention helpers, subagents, models or reasoning.
- Say what this moment is about, from the latest steps. When tests or a build are running, say what they check. When something failed and the agent is fixing it, it's fine to say so plainly.
- Only what the steps show. Don't guess at results, promise, or cheer.
- One whole phrase, not clipped: no colon, no list, no quotes, no emoji, no "…", no full stop.
- At most ${targetChars} characters.

If the line on their screen still says what the agent is doing, answer with exactly that line.

Answer with the line only.`

export interface Turn {
  readonly role: "user" | "assistant"
  readonly text: string
}

export const firstAsk = (window: string): ReadonlyArray<Turn> => [{ role: "user", text: window }]

/** The second and last try, after a line that didn't fit. */
export const retryAsk = (
  window: string,
  answer: string,
  problem: { readonly chars: number } | { readonly reason: string }
): ReadonlyArray<Turn> => [
  ...firstAsk(window),
  { role: "assistant", text: answer },
  {
    role: "user",
    text:
      "chars" in problem
        ? `That's ${problem.chars} characters, too long for one line on the phone. Say it in at most ${targetChars - 6} characters, still as a whole phrase.`
        : `That can't be used: ${problem.reason}. Answer with one short phrase, at most ${targetChars} characters.`
  }
]
