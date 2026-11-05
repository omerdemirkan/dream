/**
 * Joins the pieces of one dictation take into the whole of what was said.
 *
 * With continuous recognition, iOS ends a segment at each pause: the result
 * for that segment comes `isFinal`, and the next result starts over with only
 * the new speech. Keeping just the latest result would leave the last sentence,
 * so final segments are kept and the current one is shown after them. Where a
 * recognizer reports the whole take each time instead, the part already kept is
 * recognized as a prefix and not repeated.
 */
export interface Transcript {
  /** Segments the recognizer has finished. */
  readonly kept: string
  /** The segment still being heard. */
  readonly current: string
}

export const emptyTranscript: Transcript = { kept: "", current: "" }

const join = (a: string, b: string) => (a && b ? `${a} ${b}` : a || b)

export const addResult = (transcript: Transcript, result: { readonly text: string; readonly isFinal: boolean }) => {
  let text = result.text.trim()
  if (transcript.kept && text.toLowerCase().startsWith(transcript.kept.toLowerCase())) {
    text = text.slice(transcript.kept.length).trim()
  }
  return result.isFinal ? { kept: join(transcript.kept, text), current: "" } : { kept: transcript.kept, current: text }
}

/** Everything heard so far in the take. */
export const transcriptText = (transcript: Transcript) => join(transcript.kept, transcript.current)
