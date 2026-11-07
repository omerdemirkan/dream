/**
 * The one-line limit. A progress line has to fit on one line in the two places it shows on the smallest iPhone Dream
 * supports (375 pt wide), at 14 pt:
 *
 * - Chat: the Working row widens to the full column when it has a line, leaving about 284 pt for text
 *   (375 − 2 × 20 gutter − 14 + 16 padding − 2 border − 8 dot − 11 gap).
 * - Home: the line sits under "Working · 35m" and spans the row past the progress bar, about 277 pt
 *   (375 − 2 × 20 gutter − 44 tile − 14 gap).
 *
 * So the budget is 276 pt, measured with Helvetica's advance widths scaled up 6% for SF Pro Text, which runs a
 * little wider. Plain prose fits about 42 characters in that. A character count alone
 * would pass a line of wide capitals and refuse a long one of narrow letters, so both count: at most
 * `ProgressLineMaxLength` characters, and at most `maxWidth` points.
 *
 * A phrase that's too wide is tried without its trailing phrases (`Derive.fitted`), and dropped if that doesn't do
 * it. It is never cut: a clipped line ("Testing the scorer on rec…") is the machine-sounding text this is meant to
 * avoid.
 */
import { ProgressLineMaxLength } from "@dream/domain"

export const fontSize = 14
export const maxWidth = 276
/** What a model is asked for (`scripts/progress-eval/prompt.ts`). */
export const targetChars = 40

/** Helvetica's advance widths for ASCII 32–126, in thousandths of an em. */
const advance = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584
]

const sfScale = 1.06

/** How wide `text` would be on the phone, in points. */
export const width = (text: string, size = fontSize) => {
  let units = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    units += code >= 32 && code <= 126 ? advance[code - 32]! : code === 0x2019 || code === 0x2018 ? 222 : 600
  }
  return (units / 1000) * size * sfScale
}

export type Verdict =
  | { readonly _tag: "Fits"; readonly text: string }
  | { readonly _tag: "TooLong"; readonly text: string; readonly chars: number; readonly width: number }
  | { readonly _tag: "Unusable"; readonly reason: string }

/**
 * Tidies what the model answered (the first line, without quotes, a label or a full stop) and says whether it fits.
 * Unusable: nothing left, more than one sentence, or a line that ends cut off.
 */
export const check = (answer: string): Verdict => {
  const first =
    answer
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  const text = first
    .replace(/^(line|progress|status|answer)\s*:\s*/i, "")
    .replace(/^["“'`]+|["”'`]+$/g, "")
    .replace(/^[-•*]\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?<![.])\.$/, "")
    .trim()
  if (text.length === 0) return { _tag: "Unusable", reason: "it was empty" }
  if (/(\.\.\.|…)$/.test(text)) return { _tag: "Unusable", reason: "it ends cut off" }
  if (/[.!?]\s+\S/.test(text)) return { _tag: "Unusable", reason: "it's more than one sentence" }
  const chars = [...text].length
  const points = width(text)
  if (chars > ProgressLineMaxLength || points > maxWidth) {
    return { _tag: "TooLong", text, chars, width: Math.round(points) }
  }
  return { _tag: "Fits", text }
}
