/**
 * The New idea page: where a dictation take lands in what's already written.
 *
 * A take goes in at the cursor, or replaces the selection, rather than at the
 * end. While it's being heard the page shows the text before the selection,
 * the settled words, the words still being recognized, and the text after;
 * when it ends (or they send) those join into the text, with the cursor after
 * what was said.
 */
import { type Transcript, transcriptText } from "./transcript.ts"

export interface Selection {
  readonly start: number
  readonly end: number
}

export const caretAt = (offset: number): Selection => ({ start: offset, end: offset })

/** A take placed at a selection, in the pieces the page draws. */
export interface Placed {
  /** The text before the selection, with a space if the take needs one after it. */
  readonly before: string
  /** Words the recognizer has finished. */
  readonly settled: string
  /** Words it's still recognizing, with a space before them if they follow settled ones. */
  readonly interim: string
  /** The text after the selection, with a space if the take needs one before it. */
  readonly after: string
  /** The whole text, as it would be if the take ended now. */
  readonly text: string
  /** Where the cursor goes: right after what was said. */
  readonly caret: number
}

const clamp = (n: number, max: number) => Math.min(Math.max(0, n), max)

/** Starts a word after text that doesn't already end in a space or an opening bracket. */
const needsSpaceAfter = (before: string) => before.length > 0 && !/[\s([{“‘"']$/.test(before)
/** Keeps the next word apart, unless it starts with a space or closing punctuation. */
const needsSpaceBefore = (after: string) => after.length > 0 && !/^[\s.,;:!?)\]}”’"']/.test(after)

export const placeTake = (text: string, selection: Selection, transcript: Transcript): Placed => {
  const start = clamp(Math.min(selection.start, selection.end), text.length)
  const end = clamp(Math.max(selection.start, selection.end), text.length)
  const settled = transcript.kept.trim()
  const current = transcript.current.trim()
  const interim = settled && current ? ` ${current}` : current
  const heard = settled + interim
  const head = text.slice(0, start)
  // A selection stays until the first words replace it, so a take that hears nothing changes nothing.
  const tail = text.slice(heard ? end : start)
  const before = heard && needsSpaceAfter(head) ? `${head} ` : head
  const after = heard && needsSpaceBefore(tail) ? ` ${tail}` : tail
  const caret = before.length + heard.length
  return { before, settled, interim, after, text: before + heard + after, caret }
}

/** The text with a finished take (say, one that ended) placed at the selection. */
export const insertAt = (text: string, selection: Selection, heard: string): Placed =>
  placeTake(text, selection, { kept: heard, current: "" })

/** What Send sends: everything on the page, the take being heard included. */
export const ideaToSend = (text: string, selection: Selection, transcript: Transcript | undefined): string =>
  (transcript && transcriptText(transcript) ? placeTake(text, selection, transcript).text : text).trim()

export const wordCount = (text: string) => text.match(/\S+/g)?.length ?? 0

/** Shown under a long brain dump, as reassurance rather than a limit. */
export const wordCountLabel = (text: string) => {
  const n = wordCount(text)
  return n > 40 ? `${n} words` : ""
}
