/**
 * Replays the recorded turns (`test/fixtures/progress`) through dreamd's progress line, as someone watching the
 * whole time would have seen it, and scores every line (`criteria.ts`).
 *
 *   node packages/dreamd/scripts/progress-eval/eval.ts            the model-free lines, turn by turn
 *   node packages/dreamd/scripts/progress-eval/eval.ts --json     the same, as JSON
 *
 * `compare.ts` runs the same windows through real models, with an operator API key.
 */
import { scoreLine, scoreTurn } from "./criteria.ts"
import { loadTurns } from "./fixtures.ts"
import { type Pick, replay } from "./replay.ts"

export interface TurnResult {
  readonly project: string
  readonly startedAt: number
  readonly minutes: number
  readonly trigger: string | undefined
  readonly picks: ReadonlyArray<Pick>
}

export const evaluate = (): ReadonlyArray<TurnResult> =>
  loadTurns().map((turn) => ({
    project: turn.project,
    startedAt: turn.startedAt,
    minutes: Math.round((turn.endedAt - turn.startedAt) / 60_000),
    trigger: turn.trigger,
    picks: replay(turn)
  }))

export const summarize = (results: ReadonlyArray<TurnResult>) => {
  const lines = results.flatMap((turn) =>
    turn.picks.flatMap((pick) =>
      pick.line !== undefined && pick.line !== pick.previous
        ? [{ line: pick.line, score: scoreLine(pick.line, pick.window) }]
        : []
    )
  )
  const share = (f: (score: ReturnType<typeof scoreLine>) => boolean) =>
    lines.length === 0 ? 0 : lines.filter(({ score }) => f(score)).length / lines.length
  const turns = results.map((turn) => scoreTurn(turn.picks, turn.minutes * 60_000))
  return {
    lines: lines.length,
    fits: share((score) => score.fits),
    clean: share((score) => score.clean),
    voice: share((score) => score.voice),
    grounded: share((score) => score.grounded),
    withJargon: share((score) => score.jargon > 0),
    coverage: turns.reduce((sum, turn) => sum + turn.coverage, 0) / Math.max(1, turns.length),
    changesPer10Min: turns.reduce((sum, turn) => sum + turn.changesPer10Min, 0) / Math.max(1, turns.length)
  }
}

const percent = (value: number) => `${Math.round(value * 100)}%`

if (import.meta.main) {
  const results = evaluate()
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ summary: summarize(results), results }, null, 1))
  } else {
    for (const turn of results) {
      const score = scoreTurn(turn.picks, turn.minutes * 60_000)
      console.log(
        `\n${turn.project}, a ${turn.minutes}-minute turn${turn.trigger === undefined ? "" : ` after “${turn.trigger.slice(0, 60)}…”`}`
      )
      console.log(`  coverage ${percent(score.coverage)}, ${score.changesPer10Min.toFixed(1)} changes per 10 minutes`)
      for (const pick of turn.picks) {
        if (pick.line === pick.previous) continue
        const flags =
          pick.line === undefined
            ? ""
            : Object.entries(scoreLine(pick.line, pick.window))
                .filter(([key, value]) => (key === "jargon" ? value > 0 : value === false))
                .map(([key]) => key)
                .join(" ")
        console.log(
          `  ${String(Math.floor(pick.offset / 60_000)).padStart(3)}m  ${pick.line ?? "(no line)"}${flags === "" ? "" : `   ← ${flags}`}`
        )
      }
    }
    const summary = summarize(results)
    console.log(
      `\n${summary.lines} lines: fits ${percent(summary.fits)}, clean ${percent(summary.clean)}, voice ${percent(summary.voice)}, grounded ${percent(summary.grounded)}, with jargon ${percent(summary.withJargon)}; coverage ${percent(summary.coverage)}, ${summary.changesPer10Min.toFixed(1)} changes per 10 minutes`
    )
  }
}
