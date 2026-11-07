/**
 * What a good progress line is, as far as a script can tell. The rest is for a person to judge (see README.md):
 * whether it's accurate, specific, plain and calm.
 *
 * Checked on every line:
 * - fits: one line on the smallest iPhone (`Line.ts`: at most 276 pt at 14 pt, 60 characters);
 * - clean: no code, file names, paths, flags or identifiers, nothing about the machinery (agents, sessions, tokens),
 *   nobody unclear ("them"), nothing cut off (`Phrase.presentable`);
 * - voice: starts with an -ing verb, no "I", no full stop, no quotes;
 * - grounded: shares a content word with the window's steps (a model's line could invent; a derived one can't);
 * - jargon: words a non-developer wouldn't use (all-caps abbreviations, digits glued to words), counted, not failed.
 *
 * And over each turn:
 * - coverage: how much of the turn, after its first minute, had a line on screen;
 * - churn: how often the line changed, per ten minutes (more than about five reads as noise).
 */
import { check } from "../../src/progress/Line.ts"
import { presentable } from "../../src/progress/Phrase.ts"

const stop = new Set(
  "the a an and or of to for in on at by with from into up out it its is are be this that your my their now next new first".split(
    " "
  )
)

const contentWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stop.has(word))
    .map((word) => word.replace(/(ing|ed|es|s)$/, ""))

export interface LineScore {
  readonly fits: boolean
  readonly clean: boolean
  readonly voice: boolean
  readonly grounded: boolean
  readonly jargon: number
}

export const scoreLine = (line: string, window: string): LineScore => {
  const verdict = check(line)
  const fits = verdict._tag === "Fits" && verdict.text === line
  const words = new Set(contentWords(window))
  const lead = line.split(" ")[0] ?? ""
  return {
    fits,
    clean: presentable(line),
    voice: /^[A-Z][a-z]+ing$/.test(lead) && !/\b(I|I'm|I'll)\b/.test(line) && !/[.!?"“”]$/.test(line),
    grounded: contentWords(line.split(" ").slice(1).join(" ")).some((word) => words.has(word)),
    jargon: line.split(" ").filter((word) => /^[A-Z]{2,}s?$/.test(word) || /\d/.test(word)).length
  }
}

export interface TurnScore {
  readonly coverage: number
  readonly changesPer10Min: number
}

export const scoreTurn = (
  picks: ReadonlyArray<{
    readonly offset: number
    readonly line: string | undefined
    readonly previous: string | undefined
  }>,
  durationMs: number
): TurnScore => {
  const firstMinute = 60_000
  let covered = 0
  for (let i = 0; i < picks.length; i++) {
    const pick = picks[i]!
    if (pick.line === undefined) continue
    const from = Math.max(pick.offset, firstMinute)
    const to = picks[i + 1]?.offset ?? durationMs
    if (to > from) covered += to - from
  }
  const changes = picks.filter((pick) => pick.line !== undefined && pick.line !== pick.previous).length
  return {
    coverage: durationMs > firstMinute ? Math.min(1, covered / (durationMs - firstMinute)) : 0,
    changesPer10Min: changes / (durationMs / 600_000)
  }
}
