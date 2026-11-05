/**
 * A stand-in for the ChatGPT backend's Responses API, for running Codex turns
 * without a ChatGPT account. Every request gets the reply "hi there" with
 * rate-limit headers (five-hour window 42.5% used, weekly 12%), or, with
 * MODE=limit, a 429 usage-limit error with the five-hour window full. A prompt
 * containing `SPAWN: <json>` first gets a `spawn_agent` call with that input
 * (say `{"task_name":"check","message":"say hi","model":"gpt-6-luna","reasoning_effort":"low"}`),
 * which needs a model with Codex's multi-agent tools (the gpt-6 family).
 *
 *   MODE=ok|limit node packages/dreamd/scripts/fake-responses.ts [port]     (default 18788)
 *
 * Point dreamd at it with DREAM_CODEX_BASE_URL=http://127.0.0.1:<port>/backend-api/codex.
 * It prints each request's path, model and reasoning effort, whether the
 * Authorization header came, and what the tool calls returned.
 */
import { createServer } from "node:http"

const port = Number(process.argv[2] ?? 18788)
const mode = process.env.MODE === "limit" ? "limit" : "ok"

const rateLimits = () => {
  const now = Math.floor(Date.now() / 1000)
  return {
    "x-codex-primary-used-percent": mode === "limit" ? "100" : "42.5",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": String(now + 3600),
    "x-codex-secondary-used-percent": "12",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(now + 5 * 86400)
  }
}

const sse = (events: ReadonlyArray<{ readonly type: string; readonly [key: string]: unknown }>) =>
  events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")

type Tool = { readonly type?: string; readonly name?: string; readonly tools?: ReadonlyArray<Tool> }
type Item = {
  readonly type: string
  readonly content?: ReadonlyArray<{ readonly text?: string }>
  readonly output?: unknown
  readonly tools?: ReadonlyArray<Tool>
}

/** Tool names, namespaced ones as `namespace.name`: top-level, or (Responses Lite) in an `additional_tools` item. */
const toolNames = (tools: ReadonlyArray<Tool>, prefix = ""): ReadonlyArray<string> =>
  tools.flatMap((tool) =>
    tool.type === "namespace" ? toolNames(tool.tools ?? [], `${tool.name}.`) : [`${prefix}${tool.name ?? tool.type}`]
  )

let counter = 0

const reply = (item: Record<string, unknown>) => {
  const id = `resp_${++counter}`
  return sse([
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id,
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 12
        }
      }
    }
  ])
}

createServer((request, response) => {
  const chunks: Array<Buffer> = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => {
    let body: {
      model?: string
      reasoning?: { effort?: string }
      input?: ReadonlyArray<Item>
      tools?: ReadonlyArray<Tool>
    } = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
    } catch {
      // Not JSON (a GET); answered by path.
    }
    const input = body.input ?? []
    const prompt = input.flatMap((item) => (item.type === "message" ? (item.content ?? []) : [])).map((c) => c.text)
    const outputs = input.filter((item) => item.type === "function_call_output").map((item) => String(item.output))
    const spawn = outputs.length === 0 ? /SPAWN: (\{.+\})/.exec(prompt.join("\n")) : null
    console.log(
      JSON.stringify({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization !== undefined,
        model: body.model,
        effort: body.reasoning?.effort,
        tools: toolNames([...(body.tools ?? []), ...input.flatMap((item) => item.tools ?? [])]).join(" "),
        outputs,
        did: spawn !== null ? `spawn: ${spawn[1]}` : "reply"
      })
    )
    if (request.url?.endsWith("/responses") !== true) {
      response.writeHead(404).end()
    } else if (mode === "limit") {
      response.writeHead(429, { "content-type": "application/json", ...rateLimits() })
      response.end(
        JSON.stringify({
          error: {
            type: "usage_limit_reached",
            message: "limit",
            plan_type: "pro",
            resets_at: Math.floor(Date.now() / 1000) + 3600
          }
        })
      )
    } else {
      response.writeHead(200, { "content-type": "text/event-stream", ...rateLimits() })
      response.end(
        reply(
          spawn !== null
            ? {
                type: "function_call",
                id: `fc_${counter + 1}`,
                call_id: `call_${counter + 1}`,
                namespace: "collaboration",
                name: "spawn_agent",
                arguments: spawn[1]
              }
            : {
                type: "message",
                role: "assistant",
                id: `msg_${counter + 1}`,
                content: [{ type: "output_text", text: "hi there" }]
              }
        )
      )
    }
  })
}).listen(port, "127.0.0.1", () => console.log(`fake Responses API (${mode}) on http://127.0.0.1:${port}`))
