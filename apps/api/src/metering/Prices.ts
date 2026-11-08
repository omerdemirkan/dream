/**
 * The price book: Dream's estimate of what each meter event cost, at the providers' list prices, for the app to
 * show. Prices live here and never in the events, so a change of price never rewrites history: the D1 sink prices
 * an event once, as it records it, and keeps the book's date beside the estimate (`PriceBook`).
 *
 * Plan fees and what plans include (E2B Pro's $150 a month, Browserbase's 100 hours, R2's 10 GB, Email Service's
 * 3,000 messages) are left out: every quantity is priced as if past the included amount, so a project's estimate
 * doesn't depend on what the others used first.
 *
 * Sources, fetched 2026-11-08 (docs/research/metering.md):
 * - E2B: e2b.dev/pricing, $0.000014 per vCPU-second and $0.0000045 per GiB-second of RAM.
 * - Browserbase: browserbase.com/pricing, $0.12 per browser hour with a one-minute minimum, proxies $12 per GB.
 * - Namespace: namespace.so/pricing, macOS pay-as-you-go per minute by shape; the last 15 seconds of a minute
 *   round down.
 * - Cloudflare: R2 $0.015 per GB-month; Email Service $0.35 per 1,000 messages
 *   (developers.cloudflare.com/email-service/platform/pricing).
 * - OpenAI: developers.openai.com/api/docs/pricing.md, Standard tier, per million tokens; `service_tier` scales it.
 */
import type { CostCenter, CostPayer, CostUnit } from "@dream/domain"
import { DateTime } from "effect"
import type { MeterEvent, MeterName } from "./Meter.ts"

/** The date of the prices below, kept with each estimate. */
export const PriceBook = "2026-11-08"

export const E2BPrices = { vcpuSecond: 0.000014, gibSecond: 0.0000045 } as const
export const BrowserbasePrices = { hour: 0.12, minimumMinutes: 1, proxyGb: 12 } as const
/** Per minute, by vCPU count; another shape is priced per vCPU at the smallest one's rate. */
export const NamespaceMacPerMinute: Readonly<Record<number, number>> = { 4: 0.06, 6: 0.09, 8: 0.12 }
export const R2Prices = { gbMonth: 0.015 } as const
export const EmailPrices = { message: 0.35 / 1000 } as const

/**
 * One model's list prices, in dollars per million tokens, or per unit for the models billed otherwise. A modality
 * without its own price is billed at the text price (transcription models list one input price for audio).
 */
export interface ModelPrice {
  readonly input?: number
  readonly cachedInput?: number
  readonly output?: number
  readonly audioInput?: number
  readonly cachedAudioInput?: number
  readonly audioOutput?: number
  readonly imageInput?: number
  readonly cachedImageInput?: number
  readonly imageOutput?: number
  /** Per million characters of input (tts-1). */
  readonly characters?: number
  /** Per minute of audio (whisper-1, gpt-transcribe). */
  readonly audioMinute?: number
  /** Per minute of a session (GPT-Live). */
  readonly sessionMinute?: number
}

const text = (input: number, cachedInput: number, output: number): ModelPrice => ({ input, cachedInput, output })

export const OpenAIModels: Readonly<Record<string, ModelPrice>> = {
  "gpt-6-astra": text(10, 1, 50),
  "gpt-6.1-sol": text(2, 0.1, 10),
  "gpt-6.1-terra": text(1, 0.05, 5),
  "gpt-6-luna": text(0.1, 0.01, 0.5),
  "gpt-6-sol": text(2, 0.2, 10),
  "gpt-5.6-sol": text(4, 0.4, 20),
  "gpt-5.6-terra": text(2, 0.2, 12),
  "gpt-5.6-luna": text(0.2, 0.02, 1.2),
  "gpt-5.5": text(5, 0.5, 30),
  "gpt-5.4-mini": text(0.75, 0.075, 4.5),
  "gpt-5.4-nano": text(0.2, 0.02, 1.25),
  "gpt-5-mini": text(0.25, 0.025, 2),
  "gpt-5-nano": text(0.05, 0.005, 0.4),
  "gpt-4o-mini": text(0.15, 0.075, 0.6),
  "text-embedding-3-small": { input: 0.02 },
  "text-embedding-3-large": { input: 0.13 },
  "gpt-image-2": { input: 5, cachedInput: 1.25, imageInput: 8, cachedImageInput: 2, output: 30, imageOutput: 30 },
  "gpt-image-1.5": { input: 5, cachedInput: 1.25, imageInput: 8, cachedImageInput: 2, output: 10, imageOutput: 32 },
  "gpt-image-1-mini": {
    input: 2,
    cachedInput: 0.2,
    imageInput: 2.5,
    cachedImageInput: 0.25,
    output: 8,
    imageOutput: 8
  },
  "gpt-realtime-2.1": {
    input: 4,
    cachedInput: 0.4,
    output: 24,
    audioInput: 32,
    cachedAudioInput: 0.4,
    audioOutput: 64,
    imageInput: 5
  },
  "gpt-realtime-2.1-mini": {
    input: 0.6,
    cachedInput: 0.06,
    output: 2.4,
    audioInput: 10,
    cachedAudioInput: 0.3,
    audioOutput: 20
  },
  "gpt-realtime-1.5": {
    input: 4,
    cachedInput: 0.4,
    output: 16,
    audioInput: 32,
    cachedAudioInput: 0.4,
    audioOutput: 64
  },
  "gpt-4o-mini-tts": { input: 0.6, audioOutput: 12 },
  "gpt-4o-transcribe": { input: 2.5, output: 10 },
  "gpt-4o-mini-transcribe": { input: 1.25, output: 5 },
  "tts-1": { characters: 15 },
  "tts-1-hd": { characters: 30 },
  "whisper-1": { audioMinute: 0.006 },
  "gpt-transcribe": { audioMinute: 0.0045 },
  "gpt-realtime-whisper": { audioMinute: 0.017 },
  "gpt-live-1": { sessionMinute: 0.05 },
  // Moderation is free.
  "omni-moderation-latest": {}
}

/** $10 per 1,000 web search calls (Responses' `tool_usage.web_search`). */
export const WebSearchCall = 10 / 1000

/** Flex and batch are about half the Standard price, priority about twice. */
const tierFactor = (tier: string | undefined): number =>
  tier === "flex" || tier === "batch" ? 0.5 : tier === "priority" || tier === "fast" ? 2 : 1

/** The book's entry for `model`, also for a dated snapshot (`gpt-6.1-sol-2026-10-01`). */
export const modelPrice = (model: string | undefined): ModelPrice | undefined => {
  if (model === undefined) return undefined
  const name = model.toLowerCase()
  return OpenAIModels[name] ?? OpenAIModels[name.replace(/-\d{4}-\d{2}-\d{2}$/, "")]
}

/** What a meter counts toward in the app. */
export const centerOf: Record<MeterName, CostCenter> = {
  sandbox_run: "sandbox",
  browser_session: "browser",
  mac_session: "mac",
  openai_request: "openai",
  storage_day: "storage",
  email_sent: "email"
}

export const unitOf: Record<CostCenter, CostUnit> = {
  sandbox: "hour",
  browser: "minute",
  mac: "minute",
  openai: "request",
  storage: "gbMonth",
  email: "message"
}

/** An event's estimate: dollars, and its amount in its center's unit (billed minutes, hours, GB-months, …). */
export interface Priced {
  readonly center: CostCenter
  readonly payer: CostPayer
  readonly usd: number
  readonly units: number
  /** An OpenAI model the book doesn't know: recorded at 0 with its tokens. */
  readonly unknownModel?: string | undefined
}

const perMillion = (tokens: number, price: number | undefined) => (tokens * (price ?? 0)) / 1_000_000

/**
 * An OpenAI call's cost from its quantities. Token counts nest the way OpenAI reports them: `input_tokens` is every
 * input token (cached, audio and image ones included), `cached_input_tokens` the cached ones of every modality
 * (`cached_audio_tokens` the audio ones among them), `output_tokens` every output token (`reasoning_tokens`,
 * `output_audio_tokens` and `output_image_tokens` among them).
 */
export const openaiUsd = (price: ModelPrice, q: Readonly<Record<string, number>>, tier?: string): number => {
  const get = (key: string) => q[key] ?? 0
  const cachedAudio = get("cached_audio_tokens")
  const cached = Math.max(0, get("cached_input_tokens") - cachedAudio)
  const audioIn = Math.max(0, get("input_audio_tokens") - cachedAudio)
  const imageIn = get("input_image_tokens")
  const textIn = Math.max(0, get("input_tokens") - get("input_audio_tokens") - imageIn - cached)
  const audioOut = get("output_audio_tokens")
  const imageOut = get("output_image_tokens")
  const textOut = Math.max(0, get("output_tokens") - audioOut - imageOut)
  const tokens =
    perMillion(textIn, price.input) +
    perMillion(cached, price.cachedInput ?? price.input) +
    perMillion(audioIn, price.audioInput ?? price.input) +
    perMillion(cachedAudio, price.cachedAudioInput ?? price.cachedInput ?? price.audioInput ?? price.input) +
    perMillion(imageIn, price.imageInput ?? price.input) +
    perMillion(textOut, price.output) +
    perMillion(audioOut, price.audioOutput ?? price.output) +
    perMillion(imageOut, price.imageOutput ?? price.output)
  const units =
    perMillion(get("characters"), price.characters) +
    (get("audio_ms") / 60_000) * (price.audioMinute ?? 0) +
    (get("session_ms") / 60_000) * (price.sessionMinute ?? 0)
  return (tokens + units) * tierFactor(tier) + get("web_search_calls") * WebSearchCall
}

/** Namespace's billed minutes: started minutes, but the last 15 seconds of one round down; at least one. */
export const macMinutes = (ms: number) => Math.max(1, Math.ceil((ms / 1000 - 15) / 60))

/** Browserbase's billed minutes: started minutes, at least one. */
export const browserMinutes = (ms: number) => Math.max(BrowserbasePrices.minimumMinutes, Math.ceil(ms / 60_000))

const daysInMonth = (at: DateTime.Utc) => {
  const start = DateTime.startOf(at, "month")
  return Math.round(
    (DateTime.toEpochMillis(DateTime.add(start, { months: 1 })) - DateTime.toEpochMillis(start)) / 86_400_000
  )
}

/**
 * What the provider itself said the event cost, in dollars (`ReportedCost` in its quantities), when it says: OpenRouter
 * reports each request's charge. That's a fact about the event, not Dream's pricing, so it wins over the book.
 */
export const ReportedCost = "cost_usd"

/** Prices one event: the provider's reported cost when the event has one, else the book. Never fails. */
export const price = (event: MeterEvent): Priced => {
  const book = priceFromBook(event)
  const reported = event.quantities[ReportedCost]
  if (reported === undefined) return book
  const { unknownModel: _, ...rest } = book
  return { ...rest, usd: reported }
}

/** The book's estimate; what it can't price is 0. */
const priceFromBook = (event: MeterEvent): Priced => {
  const q = event.quantities
  const get = (key: string) => q[key] ?? 0
  const center = centerOf[event.meter]
  const payer: CostPayer = event.dimensions.payer === "person" ? "person" : "dream"
  switch (event.meter) {
    case "sandbox_run": {
      const seconds = get("ms") / 1000
      const usd = seconds * (get("vcpus") * E2BPrices.vcpuSecond + (get("memory_mb") / 1024) * E2BPrices.gibSecond)
      return { center, payer, usd, units: seconds / 3600 }
    }
    case "browser_session": {
      const minutes = browserMinutes(get("ms"))
      const usd = (minutes / 60) * BrowserbasePrices.hour + (get("proxy_bytes") / 1e9) * BrowserbasePrices.proxyGb
      return { center, payer, usd, units: minutes }
    }
    case "mac_session": {
      const minutes = macMinutes(get("ms"))
      const vcpus = get("vcpus") || 4
      const perMinute = NamespaceMacPerMinute[vcpus] ?? vcpus * (NamespaceMacPerMinute[4]! / 4)
      return { center, payer, usd: minutes * perMinute, units: minutes }
    }
    case "storage_day": {
      const gbMonths = get("bytes") / 1e9 / daysInMonth(event.at)
      return { center, payer, usd: gbMonths * R2Prices.gbMonth, units: gbMonths }
    }
    case "email_sent": {
      const messages = get("recipients") || 1
      return { center, payer, usd: messages * EmailPrices.message, units: messages }
    }
    case "openai_request": {
      const model = event.dimensions.model
      const known = modelPrice(model)
      if (known === undefined) return { center, payer, usd: 0, units: 1, unknownModel: model ?? "(none)" }
      return { center, payer, usd: openaiUsd(known, q, event.dimensions.service_tier), units: 1 }
    }
  }
}
