/**
 * A stand-in for the ChatGPT backend's Responses API, for running Codex turns
 * without a ChatGPT account. Every request gets the reply "hi there" with
 * rate-limit headers (five-hour window 42.5% used, weekly 12%), or, with
 * MODE=limit, a 429 usage-limit error with the five-hour window full. A prompt
 * containing `SPAWN: <json>` first gets a `spawn_agent` call with that input
 * (say `{"task_name":"check","message":"say hi","model":"gpt-6-luna","reasoning_effort":"low"}`),
 * which needs a model with Codex's multi-agent tools (the gpt-6 family), and
 * then a `wait_agent` call, so the subagent works within the turn. `SPAWN_BG: <json>` spawns it the same way but
 * then ends the turn ("I'll wait for its result") without waiting, as an agent that leaves a subagent running does.
 * A subagent whose message holds `SLEEP: <ms>` first calls `clock.sleep` for that long, so it outlives the turn.
 * A prompt containing `RUN: <command>` first gets a call to Codex's shell tool running it (code mode's `exec`
 * calling `tools.exec_command`, or whichever of `exec_command`, `shell_command` or `shell` the request offers), and
 * its output is logged with the next request.
 *
 * A progress-line request (`scripts/progress-eval/compare.ts`) gets a line too long for the phone, then, asked
 * again, one that fits.
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
 * system prompts the request carries (`persona`: "agent" or "task"), and which version of it (`promptOf`).
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
  readonly role?: string
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

const marks = (text: string) => [...text.matchAll(/PROMPT-MARK: (\w+)/g)].map((m) => m[1])
const textsOf = (input: ReadonlyArray<Item>, role: string) =>
  input
    .filter((item) => item.type === "message" && item.role === role)
    .map((item) => (item.content ?? []).map((c) => c.text ?? "").join("\n"))

/**
 * Which version of Dream's prompt the request carries: `PROMPT-MARK: <word>`s in the base instructions, and in each
 * developer message of the conversation, oldest first (Codex puts its `developer_instructions` there, so a resumed
 * thread shows both the old and the new one); the user messages so far, and every `REMEMBER: <word>` in them, so a
 * fresh thread shows as one with no history.
 */
const promptOf = (instructions: string | undefined, input: ReadonlyArray<Item>) => {
  const users = textsOf(input, "user")
  return {
    instructionMarks: marks(instructions ?? ""),
    developerMarks: textsOf(input, "developer")
      .map(marks)
      .filter((found) => found.length > 0),
    userMessages: users.length,
    // What the last user message opens with, so a check can see what the turn's prompt started with.
    opening: (users.at(-1) ?? "").trim().slice(0, 80),
    remembered: users.flatMap((text) => [...text.matchAll(/REMEMBER: (\w+)/g)].map((m) => m[1]))
  }
}

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
      instructions?: string
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
    const outputs = input
      .filter((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output")
      .map((item) => (typeof item.output === "string" ? item.output : JSON.stringify(item.output)))
    // A subagent is told it's a child (when it inherits its parent's conversation, which says it's `/root`), or
    // that it's an agent in a team, not `/root`.
    const said = (part: string) => prompt.some((text) => text?.includes(part))
    const role =
      said("newly spawned child agent") || (said("<multi_agent_role>") && !said("You are `/root`"))
        ? "subagent"
        : "agent"
    const spawn = outputs.length === 0 && role === "agent" ? /SPAWN(_BG)?: (\{.+\})/.exec(prompt.join("\n")) : null
    const lastCall = input.findLast((item) => item.type === "function_call")?.name
    // Once its subagent started, the agent waits for it, so the subagent's requests fall inside the turn; unless it
    // was told to leave it running (`SPAWN_BG`).
    const lastUser = textsOf(input, "user").at(-1) ?? ""
    const wait =
      role === "agent" &&
      ((lastCall === "spawn_agent" && !said("SPAWN_BG:")) ||
        (lastUser.includes("WAIT_AGENT") && input.at(-1)?.type === "message"))
    const slept = input.some((item) => item.type === "function_call" && item.name === "sleep")
    const sleep = role === "subagent" && !slept ? /SLEEP: (\d+)/.exec(prompt.join("\n")) : null
    const offered = toolNames([...(body.tools ?? []), ...input.flatMap((item) => item.tools ?? [])])
    const run = outputs.length === 0 && role === "agent" && spawn === null ? /RUN: (.+)/.exec(prompt.join("\n")) : null
    // Codex's code mode offers `functions.exec` (JavaScript that calls `tools.exec_command`); otherwise a shell tool.
    const shell = ["functions.exec", "exec_command", "shell_command", "shell"].find((name) => offered.includes(name))
    console.log(
      JSON.stringify({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization !== undefined,
        model: body.model,
        effort: body.reasoning?.effort,
        persona: personaOf(raw),
        ...promptOf(body.instructions, input),
        tools: toolNames([...(body.tools ?? []), ...input.flatMap((item) => item.tools ?? [])]).join(" "),
        outputs,
        // The newest input items in brief, so a check can see what reached the model (a subagent's report, say).
        recent: input
          .slice(-4)
          .map((item) => `${item.type}: ${JSON.stringify(item.content ?? item.output ?? "").slice(0, 160)}`),
        role,
        did:
          spawn !== null
            ? `spawn${spawn[1] ?? ""}: ${spawn[2]}`
            : run !== null
              ? `run (${shell ?? "no shell tool"}): ${run[1]}`
              : wait
                ? "wait"
                : sleep !== null
                  ? `sleep: ${sleep[1]}`
                  : "reply"
      })
    )
    if (raw.includes("dream-progress-line") && request.url?.endsWith("/responses") === true) {
      // A progress line (`scripts/progress-eval`): too long the first time, so the retry is exercised, then one that fits.
      const retry = input.length > 1
      // What one summary costs to send: `codex exec`'s own additions (tools, instructions) show up here.
      console.log(
        JSON.stringify({
          did: "progress-line",
          model: body.model,
          effort: body.reasoning?.effort,
          bodyBytes: raw.length,
          toolBytes: JSON.stringify(input.filter((item) => item.type === "additional_tools")).length,
          items: input.map((item) => `${item.type}:${JSON.stringify(item).length}`).join(" ")
        })
      )
      response.writeHead(200, { "content-type": "text/event-stream", ...rateLimits() })
      response.end(
        reply(
          {
            type: "message",
            role: "assistant",
            id: `msg_${counter + 1}`,
            content: [
              {
                type: "output_text",
                text: retry
                  ? "Checking the progress line"
                  : "Checking every progress line the fake server was asked for today"
              }
            ]
          },
          usageOf.agent
        )
      )
    } else if (request.url?.endsWith("/responses") !== true) {
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
                arguments: spawn[2]
              }
            : run !== null && shell === "functions.exec"
              ? {
                  type: "custom_tool_call",
                  id: `ctc_${counter + 1}`,
                  call_id: `call_${counter + 1}`,
                  namespace: "functions",
                  name: "exec",
                  input: `const result = await tools.exec_command({ cmd: ${JSON.stringify(run[1])} })\ntext(JSON.stringify(result))`
                }
              : run !== null && shell !== undefined
                ? {
                    type: "function_call",
                    id: `fc_${counter + 1}`,
                    call_id: `call_${counter + 1}`,
                    name: shell,
                    arguments: JSON.stringify(
                      shell === "exec_command"
                        ? { cmd: run[1] }
                        : shell === "shell_command"
                          ? { command: run[1] }
                          : { command: ["bash", "-lc", run[1]] }
                    )
                  }
                : sleep !== null
                  ? {
                      type: "function_call",
                      id: `fc_${counter + 1}`,
                      call_id: `call_${counter + 1}`,
                      namespace: "clock",
                      name: "sleep",
                      arguments: JSON.stringify({ duration_ms: Number(sleep[1]) })
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
                        content: [
                          {
                            type: "output_text",
                            text:
                              role === "agent" && lastCall === "spawn_agent" ? "I'll wait for its result." : "hi there"
                          }
                        ]
                      },
          usageOf[role]
        )
      )
    }
  })
}).listen(port, "127.0.0.1", () => console.log(`fake Responses API (${mode}) on http://127.0.0.1:${port}`))
