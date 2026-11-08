/**
 * Watching a response body go by on its way to the app, without holding it: each chunk passes on as it came, and
 * a copy is read for what it says (server-sent events, or a JSON body once it's all there). Only Chat streams
 * whose usage chunk the gateway asked for are rewritten, event by event, so an app that didn't ask never sees it.
 */
import { Option } from "effect"
import { parseAny } from "./Json.ts"

/** Splits a server-sent event stream into events' `data`, across chunk boundaries. */
export const sseParser = () => {
  let buffer = ""
  return {
    /** The complete events in `text` and what came before it, as their joined `data` lines. */
    push: (text: string): ReadonlyArray<{ readonly raw: string; readonly data: string }> => {
      buffer += text
      const events: Array<{ raw: string; data: string }> = []
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer)
        if (match === null) break
        const raw = buffer.slice(0, match.index + match[0].length)
        buffer = buffer.slice(match.index + match[0].length)
        const data = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n")
        events.push({ raw, data })
      }
      return events
    },
    /** What's left: an unterminated last event. */
    rest: () => buffer
  }
}

const parse = (data: string): unknown => Option.getOrUndefined(parseAny(data))

export interface Observer {
  /** Each event's parsed data (SSE), the whole body parsed (JSON), or the whole body as text, as it completes. */
  readonly onData: (data: unknown) => void
  /** Called once, when the body ended or was cut off (`complete` false). */
  readonly onEnd: (complete: boolean) => void
}

/**
 * `body` passed through unchanged while `observer` sees what it says. `drop` (SSE only) leaves an event out of
 * what the app gets, after the observer has seen it.
 */
export const observe = (
  body: ReadableStream<Uint8Array>,
  kind: "sse" | "json" | "text",
  observer: Observer,
  drop?: (data: unknown) => boolean
): ReadableStream<Uint8Array> => {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const parser = sseParser()
  const chunks: Array<string> = []
  let ended = false
  const end = (complete: boolean) => {
    if (ended) return
    ended = true
    observer.onEnd(complete)
  }
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform: (chunk, controller) => {
      const text = decoder.decode(chunk, { stream: true })
      if (kind !== "sse") {
        chunks.push(text)
        controller.enqueue(chunk)
        return
      }
      const events = parser.push(text)
      if (drop === undefined) controller.enqueue(chunk)
      for (const event of events) {
        const data = event.data === "[DONE]" ? undefined : parse(event.data)
        if (data !== undefined) observer.onData(data)
        if (drop !== undefined && !(data !== undefined && drop(data))) controller.enqueue(encoder.encode(event.raw))
      }
    },
    flush: (controller) => {
      const tail = decoder.decode()
      if (kind === "json") {
        const data = parse(chunks.join("") + tail)
        if (data !== undefined) observer.onData(data)
      } else if (kind === "text") {
        observer.onData(chunks.join("") + tail)
      } else {
        const events = parser.push(tail)
        for (const event of events) {
          const data = parse(event.data)
          if (data !== undefined) observer.onData(data)
          if (drop !== undefined && !(data !== undefined && drop(data))) controller.enqueue(encoder.encode(event.raw))
        }
        if (drop !== undefined && parser.rest().length > 0) controller.enqueue(encoder.encode(parser.rest()))
      }
      end(true)
    }
  })
  // The app hanging up cancels the readable side, which fails the pipe (and cancels the upstream body).
  body.pipeTo(transform.writable).catch(() => end(false))
  return transform.readable
}
