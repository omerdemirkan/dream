/**
 * The same recorded windows through real small models, next to the model-free lines, scored the same way. For
 * deciding whether a model is worth adding (see `src/progress/Summarizer.ts`); nothing in dreamd uses this.
 *
 * Only with Dream's own operator API keys, never a person's subscription (docs/proposals/sidecar-terms.html):
 *
 *   ANTHROPIC_API_KEY=… OPENAI_API_KEY=… node packages/dreamd/scripts/progress-eval/compare.ts [--out report.json]
 *
 * Either key alone runs that provider only. Models: claude-haiku-5-5 and gpt-6-luna (effort low), or
 * PROGRESS_CLAUDE_MODEL / PROGRESS_OPENAI_MODEL. ANTHROPIC_BASE_URL / OPENAI_BASE_URL point it elsewhere, e.g. at
 * the fake servers in `scripts/` (any key works there):
 *
 *   node packages/dreamd/scripts/fake-anthropic.ts 18789 & node packages/dreamd/scripts/fake-responses.ts 18788 &
 *   ANTHROPIC_API_KEY=fake OPENAI_API_KEY=fake ANTHROPIC_BASE_URL=http://127.0.0.1:18789 \
 *     OPENAI_BASE_URL=http://127.0.0.1:18788/v1 node packages/dreamd/scripts/progress-eval/compare.ts
 */
import { writeFileSync } from "node:fs"
import { check } from "../../src/progress/Line.ts"
import { scoreLine } from "./criteria.ts"
import { evaluate } from "./eval.ts"
import { firstAsk, retryAsk, system, type Turn } from "./prompt.ts"

const claudeKey = process.env.ANTHROPIC_API_KEY
const openaiKey = process.env.OPENAI_API_KEY
for (const key of [claudeKey, openaiKey]) {
  // A Claude subscription token, or a ChatGPT login's JWT: never.
  if (key !== undefined && (key.startsWith("sk-ant-oat") || key.startsWith("eyJ"))) {
    console.error("That's a subscription token. Use Dream's own API keys.")
    process.exit(2)
  }
}
if (claudeKey === undefined && openaiKey === undefined) {
  console.error("Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY (Dream's own operator keys).")
  process.exit(2)
}

const claudeModel = process.env.PROGRESS_CLAUDE_MODEL ?? "claude-haiku-5-5"
const openaiModel = process.env.PROGRESS_OPENAI_MODEL ?? "gpt-6-luna"
const anthropicBase = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "")
const openaiBase = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "")

interface Answer {
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
}

const askClaude = async (turns: ReadonlyArray<Turn>): Promise<Answer> => {
  const response = await fetch(`${anthropicBase}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": claudeKey ?? "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: claudeModel,
      max_tokens: 60,
      system,
      messages: turns.map((turn) => ({ role: turn.role, content: turn.text }))
    })
  })
  const body = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
    error?: { message?: string }
  }
  if (!response.ok) throw new Error(`Claude answered ${response.status}: ${body.error?.message ?? ""}`)
  return {
    text: (body.content ?? []).flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join(""),
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0
  }
}

const askOpenAI = async (turns: ReadonlyArray<Turn>): Promise<Answer> => {
  const response = await fetch(`${openaiBase}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${openaiKey ?? ""}`,
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify({
      model: openaiModel,
      instructions: system,
      input: turns.map((turn) => ({
        type: "message",
        role: turn.role,
        content: [{ type: turn.role === "user" ? "input_text" : "output_text", text: turn.text }]
      })),
      reasoning: { effort: "low" },
      store: false,
      stream: true
    })
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`OpenAI answered ${response.status}: ${text.slice(0, 200)}`)
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line.slice(5)) as Record<string, any>]
      } catch {
        return []
      }
    })
  const deltas = events
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => String(event.delta))
  const items = events
    .filter((event) => event.type === "response.output_item.done" && event.item?.type === "message")
    .flatMap((event) => (event.item.content ?? []).map((part: { text?: string }) => part.text ?? ""))
  const usage = events.findLast((event) => event.type === "response.completed")?.response?.usage ?? {}
  return {
    text: deltas.length > 0 ? deltas.join("") : items.join(""),
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0
  }
}

/** A line, asked again once if it doesn't fit; `undefined` when it still doesn't. */
const lineFrom = async (ask: (turns: ReadonlyArray<Turn>) => Promise<Answer>, window: string) => {
  const first = await ask(firstAsk(window))
  let verdict = check(first.text)
  let tokens = { input: first.inputTokens, output: first.outputTokens }
  if (verdict._tag !== "Fits") {
    const problem = verdict._tag === "TooLong" ? { chars: verdict.chars } : { reason: verdict.reason }
    const second = await ask(retryAsk(window, first.text, problem))
    verdict = check(second.text)
    tokens = { input: tokens.input + second.inputTokens, output: tokens.output + second.outputTokens }
  }
  return {
    line: verdict._tag === "Fits" ? verdict.text : undefined,
    retried: first.text !== "" && check(first.text)._tag !== "Fits",
    tokens
  }
}

const providers = [
  ...(claudeKey === undefined ? [] : [{ name: claudeModel, ask: askClaude }]),
  ...(openaiKey === undefined ? [] : [{ name: openaiModel, ask: askOpenAI }])
]

const rows: Array<Record<string, unknown>> = []
const totals = new Map<
  string,
  {
    lines: number
    fits: number
    clean: number
    voice: number
    grounded: number
    jargon: number
    input: number
    output: number
    dropped: number
  }
>()
for (const turn of evaluate()) {
  console.log(`\n${turn.project}, a ${turn.minutes}-minute turn`)
  for (const pick of turn.picks) {
    const row: Record<string, unknown> = {
      project: turn.project,
      minute: Math.floor(pick.offset / 60_000),
      modelFree: pick.line
    }
    const shown = [`${String(row.minute).padStart(3)}m  model-free: ${pick.line ?? "(none)"}`]
    for (const provider of providers) {
      const total = totals.get(provider.name) ?? {
        lines: 0,
        fits: 0,
        clean: 0,
        voice: 0,
        grounded: 0,
        jargon: 0,
        input: 0,
        output: 0,
        dropped: 0
      }
      try {
        const result = await lineFrom(provider.ask, pick.window)
        total.input += result.tokens.input
        total.output += result.tokens.output
        if (result.line === undefined) total.dropped++
        else {
          const score = scoreLine(result.line, pick.window)
          total.lines++
          total.fits += score.fits ? 1 : 0
          total.clean += score.clean ? 1 : 0
          total.voice += score.voice ? 1 : 0
          total.grounded += score.grounded ? 1 : 0
          total.jargon += score.jargon > 0 ? 1 : 0
        }
        row[provider.name] = result.line
        shown.push(`       ${provider.name}: ${result.line ?? "(dropped)"}${result.retried ? " (asked twice)" : ""}`)
      } catch (error) {
        row[provider.name] = { error: String(error) }
        shown.push(`       ${provider.name}: failed, ${String(error).slice(0, 120)}`)
      }
      totals.set(provider.name, total)
    }
    rows.push(row)
    console.log(shown.join("\n"))
  }
}
console.log("")
for (const [name, total] of totals) {
  const pct = (n: number) => `${Math.round((100 * n) / Math.max(1, total.lines))}%`
  console.log(
    `${name}: ${total.lines} lines, ${total.dropped} dropped; fits ${pct(total.fits)}, clean ${pct(total.clean)}, voice ${pct(total.voice)}, grounded ${pct(total.grounded)}, with jargon ${pct(total.jargon)}; ${total.input} input and ${total.output} output tokens`
  )
}
const out = process.argv.indexOf("--out")
if (out > 0 && process.argv[out + 1] !== undefined) {
  writeFileSync(process.argv[out + 1]!, `${JSON.stringify({ rows, totals: Object.fromEntries(totals) }, null, 1)}\n`)
}
