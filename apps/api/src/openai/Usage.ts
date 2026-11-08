/**
 * What an OpenAI call used, read from what came back: a JSON body's `usage`, a stream's final event, a realtime
 * session's `response.done`. Quantities are as OpenAI counts them: `input_tokens` includes the cached, audio and
 * image input it breaks out (`cached_input_tokens`, `input_audio_tokens`, …), and `output_tokens` includes the
 * reasoning and audio output. Everything here is decoded loosely on purpose: a field OpenAI drops or renames
 * leaves a quantity out, never the call unmetered. See docs/metering.md for the names.
 */
import { DateTime, Option, Schema } from "effect"
import type { MeterEvent } from "../metering/Meter.ts"
import type { MeteredEndpoint } from "./Endpoints.ts"

/** Who a call through the gateway is for. Dream's key always pays. */
export interface Caller {
  readonly projectId: string
  readonly userId: string
}

/** One billable thing, before it becomes a `MeterEvent`. */
export interface Usage {
  /** OpenAI's id for it (response, completion, call, session), the idempotency key; else the request's id. */
  readonly id?: string | undefined
  readonly model?: string | undefined
  readonly serviceTier?: string | undefined
  readonly quantities: Readonly<Record<string, number>>
  /** A quantity was inferred rather than reported (speech without usage). */
  readonly estimated?: boolean | undefined
  /** More to group or price it by (an image's `size` and `quality`). */
  readonly dimensions?: Readonly<Record<string, string>> | undefined
}

const Num = Schema.optionalKey(Schema.Finite)
const Str = Schema.optionalKey(Schema.String)

const TokenDetails = Schema.optionalKey(
  Schema.Struct({
    cached_tokens: Num,
    audio_tokens: Num,
    image_tokens: Num,
    text_tokens: Num,
    reasoning_tokens: Num,
    cached_tokens_details: Schema.optionalKey(Schema.Struct({ audio_tokens: Num, image_tokens: Num }))
  })
)

/** Every usage shape OpenAI returns, as one loose struct: Responses, Chat, images, audio, realtime. */
const AnyUsage = Schema.Struct({
  type: Str,
  input_tokens: Num,
  output_tokens: Num,
  prompt_tokens: Num,
  completion_tokens: Num,
  seconds: Num,
  input_tokens_details: TokenDetails,
  output_tokens_details: TokenDetails,
  prompt_tokens_details: TokenDetails,
  completion_tokens_details: TokenDetails,
  input_token_details: TokenDetails,
  output_token_details: TokenDetails
})
type AnyUsage = typeof AnyUsage.Type

const Body = Schema.Struct({
  id: Str,
  model: Str,
  service_tier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  usage: Schema.optionalKey(Schema.NullOr(AnyUsage)),
  tool_usage: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        web_search: Schema.optionalKey(Schema.NullOr(Schema.Struct({ num_requests: Num }))),
        image_gen: Schema.optionalKey(Schema.NullOr(AnyUsage))
      })
    )
  )
})
type Body = typeof Body.Type

const decodeBody = Schema.decodeUnknownOption(Body)

const put = (into: Record<string, number>, name: string, value: number | undefined) => {
  if (value !== undefined && value > 0) into[name] = value
}

/** The quantities in one `usage` object, whichever endpoint's shape it has. */
export const quantitiesOf = (usage: AnyUsage): Record<string, number> => {
  const q: Record<string, number> = {}
  const input = usage.input_tokens_details ?? usage.prompt_tokens_details ?? usage.input_token_details
  const output = usage.output_tokens_details ?? usage.completion_tokens_details ?? usage.output_token_details
  if (usage.type === "duration") {
    put(q, "audio_ms", usage.seconds === undefined ? undefined : Math.round(usage.seconds * 1000))
    return q
  }
  put(q, "input_tokens", usage.input_tokens ?? usage.prompt_tokens)
  put(q, "cached_input_tokens", input?.cached_tokens)
  put(q, "input_audio_tokens", input?.audio_tokens)
  put(q, "cached_audio_tokens", input?.cached_tokens_details?.audio_tokens)
  put(q, "cached_image_tokens", input?.cached_tokens_details?.image_tokens)
  put(q, "input_image_tokens", input?.image_tokens)
  put(q, "output_tokens", usage.output_tokens ?? usage.completion_tokens)
  put(q, "reasoning_tokens", output?.reasoning_tokens)
  put(q, "output_audio_tokens", output?.audio_tokens)
  put(q, "output_image_tokens", output?.image_tokens)
  return q
}

const fromBody = (body: Body): ReadonlyArray<Usage> => {
  if (body.usage === undefined || body.usage === null) return []
  const quantities = quantitiesOf(body.usage)
  put(quantities, "web_search_calls", body.tool_usage?.web_search?.num_requests)
  const usage: Usage = {
    id: body.id,
    model: body.model,
    serviceTier: body.service_tier ?? undefined,
    quantities
  }
  const image = body.tool_usage?.image_gen
  // The image generation tool is billed at its image model's rates, so it's an event of its own.
  return image === undefined || image === null
    ? [usage]
    : [
        usage,
        {
          id: body.id === undefined ? undefined : `${body.id}:image_gen`,
          model: "gpt-image (tool)",
          quantities: quantitiesOf(image)
        }
      ]
}

/** A JSON response body (Responses, Chat, embeddings, images, transcription). */
export const fromJson = (json: unknown): ReadonlyArray<Usage> =>
  Option.match(decodeBody(json), { onNone: () => [], onSome: fromBody })

const StreamEvent = Schema.Struct({
  type: Str,
  response: Schema.optionalKey(Schema.Unknown),
  usage: Schema.optionalKey(Schema.NullOr(AnyUsage)),
  id: Str,
  model: Str,
  service_tier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  item_id: Str,
  session: Schema.optionalKey(Schema.Unknown)
})
const decodeEvent = Schema.decodeUnknownOption(StreamEvent)

/**
 * A server-sent event's data, or a realtime message: the usage it carries, if it's an event that does. Responses
 * end with `response.completed` (or `.incomplete`, `.failed`), whose `response` has it all; Chat's last chunk has
 * `usage` (and `choices: []`); speech ends with `speech.audio.done`, transcription with `transcript.text.done`,
 * image streams with `image_generation.completed` (or `image_edit.completed`); a realtime response with
 * `response.done`.
 */
export const fromEvent = (data: unknown): ReadonlyArray<Usage> =>
  Option.match(decodeEvent(data), {
    onNone: () => [],
    onSome: (event) => {
      switch (event.type) {
        case "response.completed":
        case "response.incomplete":
        case "response.failed":
        case "response.done":
          return fromJson(event.response)
        case "speech.audio.done":
        case "transcript.text.done":
        case "image_generation.completed":
        case "image_edit.completed":
          return event.usage === undefined || event.usage === null ? [] : [{ quantities: quantitiesOf(event.usage) }]
        case undefined:
          // Chat Completions chunks have no `type`; only the last one has usage.
          return event.usage === undefined || event.usage === null
            ? []
            : [
                {
                  id: event.id,
                  model: event.model,
                  serviceTier: event.service_tier ?? undefined,
                  quantities: quantitiesOf(event.usage)
                }
              ]
        default:
          return []
      }
    }
  })

const Created = Schema.Struct({
  type: Schema.Literal("response.created"),
  response: Schema.Struct({ id: Schema.String })
})
const decodeCreated = Schema.decodeUnknownOption(Created)

/** The response id a Responses stream announces first (`response.created`), for ownership. */
export const createdResponseId = (data: unknown): string | undefined =>
  Option.getOrUndefined(Option.map(decodeCreated(data), (event) => event.response.id))

/**
 * Speech without usage (binary audio): its characters, which tts-1 and tts-1-hd are priced by, and for the
 * token-priced voices tokens estimated from them: about four characters a text token in, and about 1,250 audio tokens
 * a minute out (OpenAI's ~$0.015 a minute for gpt-4o-mini-tts) at about 900 characters a minute.
 */
export const speechEstimate = (model: string | undefined, input: string): Usage => {
  const characters = input.length
  if (model === undefined || model.startsWith("tts-1")) return { quantities: { characters }, estimated: true }
  const audio = Math.round(characters * (1250 / 900))
  return {
    quantities: {
      characters,
      input_tokens: Math.ceil(characters / 4),
      output_tokens: audio,
      output_audio_tokens: audio
    },
    estimated: true
  }
}

/** Speech's reported output tokens are audio, which its usage doesn't break out. */
export const asSpeech = (usage: Usage): Usage =>
  usage.quantities.output_tokens === undefined || usage.quantities.output_audio_tokens !== undefined
    ? usage
    : { ...usage, quantities: { ...usage.quantities, output_audio_tokens: usage.quantities.output_tokens } }

/** An image model's output is image tokens, which its usage breaks out only sometimes. */
export const asImages = (usage: Usage): Usage =>
  usage.quantities.output_tokens === undefined || usage.quantities.output_image_tokens !== undefined
    ? usage
    : { ...usage, quantities: { ...usage.quantities, output_image_tokens: usage.quantities.output_tokens } }

/** dall-e-2 and dall-e-3 report no usage: they're priced per image, by size and quality. */
export const imagesEstimate = (count: number, size: string | undefined, quality: string | undefined): Usage => ({
  quantities: { images: count },
  dimensions: { size: size ?? "1024x1024", quality: quality === "hd" ? "hd" : "standard" }
})

/**
 * A transcription in a format without usage (`text`, `srt`, `vtt`): how long the audio was, from the subtitles' last
 * timestamp, or from the words at about 150 a minute; and for the token-priced models, tokens from that, at OpenAI's
 * one audio token per 100 ms in and about four characters a token out. Always `estimated`.
 */
export const transcriptionEstimate = (model: string | undefined, format: string, text: string): Usage => {
  const stamps = [...text.matchAll(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g)].map(
    ([, h, m, sec, ms]) => ((Number(h) * 60 + Number(m)) * 60 + Number(sec)) * 1000 + Number(ms)
  )
  const words = text.split(/\s+/).filter((word) => word.length > 0).length
  const audioMs = Math.max(
    1000,
    Math.round(format !== "text" && stamps.length > 0 ? Math.max(...stamps) : (words / 150) * 60_000)
  )
  if (model === undefined || model === "whisper-1") return { quantities: { audio_ms: audioMs }, estimated: true }
  const audio = Math.round(audioMs / 100)
  return {
    quantities: {
      audio_ms: audioMs,
      input_tokens: audio,
      input_audio_tokens: audio,
      output_tokens: Math.ceil(text.length / 4)
    },
    estimated: true
  }
}

export const toEvent = (
  caller: Caller,
  endpoint: MeteredEndpoint,
  usage: Usage,
  fallback: { readonly requestId: string; readonly model?: string | undefined; readonly at: DateTime.Utc }
): MeterEvent => {
  const model = usage.model ?? fallback.model
  return {
    id: `openai:${usage.id ?? fallback.requestId}`,
    owner: caller.userId,
    meter: "model_request",
    at: fallback.at,
    quantities: usage.quantities,
    dimensions: {
      project: caller.projectId,
      payer: "dream",
      provider: "openai",
      endpoint,
      ...(model === undefined ? {} : { model }),
      ...(usage.serviceTier === undefined ? {} : { service_tier: usage.serviceTier }),
      ...(usage.estimated === true ? { estimated: "true" } : {}),
      ...usage.dimensions
    }
  }
}
