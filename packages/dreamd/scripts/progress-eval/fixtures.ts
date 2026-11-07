/** The evaluation's recorded turns (`test/fixtures/progress/*.json`, made by `extract.ts`), ready to replay. */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Part } from "../../src/harness/Turn.ts"
import type { RecordedTurn } from "./transcript.ts"

export const fixturesDir = join(import.meta.dirname, "../../test/fixtures/progress")

type Fixture = {
  readonly turns: ReadonlyArray<{
    readonly project: string
    readonly startedAt: number
    readonly endedAt: number
    readonly trigger?: string
    readonly parts: ReadonlyArray<{ readonly at: number; readonly part: unknown }>
  }>
}

export const loadTurns = (dir = fixturesDir): ReadonlyArray<RecordedTurn> =>
  readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => (JSON.parse(readFileSync(join(dir, name), "utf8")) as Fixture).turns)
    .map((turn) => ({
      project: turn.project,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      trigger: turn.trigger,
      parts: turn.parts.map(({ at, part }) => ({ at: turn.startedAt + at, part: part as Part }))
    }))
