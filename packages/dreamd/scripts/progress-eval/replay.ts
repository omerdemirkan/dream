/**
 * Replays a recorded turn the way dreamd's `Progress` would run it with someone watching the whole time: the parts
 * arrive at their recorded times, and every 10 seconds a line is picked if the work moved on and a minute has
 * passed since the last pick (10 seconds into the turn for the first). Returns every pick, with the window a model
 * would have seen at that moment.
 */
import { derive } from "../../src/progress/Derive.ts"
import * as Steps from "../../src/progress/Steps.ts"
import { render } from "../../src/progress/Window.ts"
import type { RecordedTurn } from "./transcript.ts"

export interface Pick {
  /** Milliseconds into the turn. */
  readonly offset: number
  /** The rendered window, as a model summariser would get it. */
  readonly window: string
  /** The model-free line at this moment, if there was one, and where it came from. */
  readonly line: string | undefined
  readonly source: string | undefined
  /** What the line on screen was before this pick. */
  readonly previous: string | undefined
  /** The steps the window shows, as rendered lines (for judging accuracy). */
  readonly recent: ReadonlyArray<string>
}

const tick = 10_000
const minInterval = 60_000
const firstAfter = 10_000

export const replay = (turn: RecordedTurn): ReadonlyArray<Pick> => {
  const picks: Array<Pick> = []
  let state = Steps.empty
  let next = 0
  let pickedVersion = 0
  let pickedAt = 0
  let line: string | undefined
  let shown: { line: string; at: number; score: number } | undefined
  for (let now = turn.startedAt; now <= turn.endedAt + tick; now += tick) {
    while (next < turn.parts.length && turn.parts[next]!.at <= now) {
      state = Steps.observe(state, turn.parts[next]!.part, turn.parts[next]!.at)
      next++
    }
    if (now - turn.startedAt < firstAfter || state.version === pickedVersion) continue
    if (pickedAt !== 0 && now - pickedAt < minInterval) continue
    const steps = Steps.current(state, now)
    const derived = derive({ steps, now, shown })
    const window = render({ trigger: turn.trigger, startedAt: turn.startedAt, now, previous: line, steps })
    picks.push({
      offset: now - turn.startedAt,
      window,
      line: derived?.line ?? line,
      source: derived?.source,
      previous: line,
      recent: window.split("\n").filter((row) => row.startsWith("- "))
    })
    pickedVersion = state.version
    pickedAt = now
    if (derived !== undefined && derived.line !== line) shown = { line: derived.line, at: now, score: derived.score }
    line = derived?.line ?? line
  }
  return picks
}
