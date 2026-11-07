/**
 * A stand-in for the ChatGPT backend's Responses API, for running Codex turns
 * without a ChatGPT account. Every request gets the reply "hi there" with
 * rate-limit headers (five-hour window 42.5% used, weekly 12%), or, with
 * MODE=limit, a 429 usage-limit error with the five-hour window full. A prompt
 * containing `SPAWN: <json>` first gets a `spawn_agent` call with that input
 * (say `{"task_name":"check","message":"say hi","model":"gpt-6-luna","reasoning_effort":"low"}`),
 * which needs a model with Codex's multi-agent tools (the gpt-6 family), and
 * then a `wait_agent` call, so the subagent works within the turn.
 *
 * Every response reports usage that says who asked, so a turn's reported tokens show what was counted: the
 * agent's own requests 1,000 input (600 of it cached) and 10 output (4 reasoning); a subagent's (Codex told it
 * it isn't the root agent) 50,000 input (40,000 cached) and 5,000 output (2,000 reasoning).
 *
 *   MODE=ok|limit node packages/dreamd/scripts/fake-responses.ts [port]     (default 18788)
 *
 * Point dreamd at it with DREAM_CODEX_BASE_URL=http://127.0.0.1:<port>/backend-api/codex.
 * It prints each request's path, model and reasoning effort, whether the
 * Authorization header came, what the tool calls returned, and which of Dream's
 * system prompts the request carries (`persona`: "agent" or "task").
 */
import { createServer } from "node:http"

/** Which of Dream's system prompts the request carries, by its opening words: the agent's, or a scheduled task's. */
const personaOf = (raw: string): "agent" | "task" | undefined =>
  raw.includes("You're running one job for a project in Dream")
    ? "task"
    : raw.includes("You're the agent behind one project in Dream")
      ? "agent"
      : undefined

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
  readonly name?: string
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

const usageOf = {
  agent: {
    input_tokens: 1_000,
    input_tokens_details: { cached_tokens: 600 },
    output_tokens: 10,
    output_tokens_details: { reasoning_tokens: 4 },
    total_tokens: 1_010
  },
  subagent: {
    input_tokens: 50_000,
    input_tokens_details: { cached_tokens: 40_000 },
    output_tokens: 5_000,
    output_tokens_details: { reasoning_tokens: 2_000 },
    total_tokens: 55_000
  }
}

const reply = (item: Record<string, unknown>, usage: (typeof usageOf)[keyof typeof usageOf]) => {
  const id = `resp_${++counter}`
  return sse([
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    {
      type: "response.completed",
      response: {
        id,
        usage
      }
    }
  ])
}

createServer((request, response) => {
  const chunks: Array<Buffer> = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => {
    let raw = ""
    let body: {
      model?: string
      reasoning?: { effort?: string }
      input?: ReadonlyArray<Item>
      tools?: ReadonlyArray<Tool>
    } = {}
    try {
      raw = Buffer.concat(chunks).toString("utf8")
      body = JSON.parse(raw || "{}")
    } catch {
      // Not JSON (a GET); answered by path.
    }
    const input = body.input ?? []
    const prompt = input.flatMap((item) => (item.type === "message" ? (item.content ?? []) : [])).map((c) => c.text)
    const outputs = input.filter((item) => item.type === "function_call_output").map((item) => String(item.output))
    // A subagent is told it's a child (when it inherits its parent's conversation, which says it's `/root`), or
    // that it's an agent in a team, not `/root`.
    const said = (part: string) => prompt.some((text) => text?.includes(part))
    const role =
      said("newly spawned child agent") || (said("<multi_agent_role>") && !said("You are `/root`"))
        ? "subagent"
        : "agent"
    const spawn = outputs.length === 0 && role === "agent" ? /SPAWN: (\{.+\})/.exec(prompt.join("\n")) : null
    // Once its subagent started, the agent waits for it, so the subagent's requests fall inside the turn.
    const wait = role === "agent" && input.findLast((item) => item.type === "function_call")?.name === "spawn_agent"
    console.log(
      JSON.stringify({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization !== undefined,
        model: body.model,
        effort: body.reasoning?.effort,
        persona: personaOf(raw),
        tools: toolNames([...(body.tools ?? []), ...input.flatMap((item) => item.tools ?? [])]).join(" "),
        outputs,
        role,
        did: spawn !== null ? `spawn: ${spawn[1]}` : wait ? "wait" : "reply"
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
            : wait
              ? {
                  type: "function_call",
                  id: `fc_${counter + 1}`,
                  call_id: `call_${counter + 1}`,
                  namespace: "collaboration",
                  name: "wait_agent",
                  arguments: JSON.stringify({ timeout_ms: 30_000 })
                }
              : {
                  type: "message",
                  role: "assistant",
                  id: `msg_${counter + 1}`,
                  content: [{ type: "output_text", text: "hi there" }]
                },
          usageOf[role]
        )
      )
    }
  })
}).listen(port, "127.0.0.1", () => console.log(`fake Responses API (${mode}) on http://127.0.0.1:${port}`))
