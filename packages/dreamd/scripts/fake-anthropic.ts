/**
 * A stand-in for Anthropic's Messages API, for running Claude Code turns without a Claude account, with a script:
 *
 *   - a prompt containing `RUN: <command>` gets a Bash tool call running it (`RUN_BG: <command>` runs it with
 *     `run_in_background`), then, once the result comes back, a reply saying so;
 *   - a prompt containing `AGENT: <json>` gets an Agent tool call with that input (say
 *     `{"description":"check","prompt":"say hi","model":"haiku","effort":"low"}`), to start a subagent;
 *   - any other prompt gets a reply listing every `REMEMBER: <word>` the conversation holds, and how many user
 *     messages it has, so a resumed session shows its history.
 *
 *   node packages/dreamd/scripts/fake-anthropic.ts [port]     (default 18789)
 *
 * Point Claude Code at it with ANTHROPIC_BASE_URL=http://127.0.0.1:<port> (in dreamd's sandbox, through the `env`
 * of ~/.claude/settings.json). It prints one JSON line per request, with the model and effort asked for, never the
 * Authorization header.
 * Node built-ins only, so it runs from anywhere.
 */
import { createServer } from "node:http"

const port = Number(process.argv[2] ?? 18789)

type Block = { readonly type: string; readonly text?: string; readonly content?: unknown }
type Message = { readonly role: string; readonly content: string | ReadonlyArray<Block> }

const textOf = (message: Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n")

const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")

let counter = 0

type Reply = { readonly block: Record<string, unknown>; readonly stop: string }

const usage = { input_tokens: 10, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

/** The reply as a Messages API stream, or as one JSON message for a request that didn't ask to stream. */
const render = (model: string, { block, stop }: Reply, stream: boolean) => {
  const id = `msg_fake_${++counter}`
  const message = { id, type: "message", role: "assistant", model, stop_sequence: null }
  if (!stream) return JSON.stringify({ ...message, content: [block], stop_reason: stop, usage })
  const { text: body, input, ...start } = block as { text?: string; input?: unknown }
  const delta =
    block.type === "text"
      ? { type: "text_delta", text: body ?? "" }
      : { type: "input_json_delta", partial_json: JSON.stringify(input) }
  return sse([
    {
      type: "message_start",
      message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } }
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: block.type === "text" ? { type: "text", text: "" } : { ...start, input: {} }
    },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 12 } },
    { type: "message_stop" }
  ])
}

const text = (body: string): Reply => ({ block: { type: "text", text: body }, stop: "end_turn" })

const agent = (input: unknown): Reply => ({
  block: { type: "tool_use", id: `toolu_fake_${counter + 1}`, name: "Agent", input },
  stop: "tool_use"
})

const bash = (command: string, background: boolean): Reply => ({
  block: {
    type: "tool_use",
    id: `toolu_fake_${counter + 1}`,
    name: "Bash",
    input: { command, description: "Run what the test asked for", ...(background ? { run_in_background: true } : {}) }
  },
  stop: "tool_use"
})

createServer((request, response) => {
  const chunks: Array<Buffer> = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => {
    const path = (request.url ?? "").split("?")[0] ?? ""
    let body: {
      model?: string
      messages?: ReadonlyArray<Message>
      tools?: ReadonlyArray<unknown>
      stream?: boolean
      output_config?: { effort?: string }
    } = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
    } catch {
      // Not JSON; answered below by path.
    }
    if (path.endsWith("/v1/messages/count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 10 }))
      return
    }
    if (!path.endsWith("/v1/messages")) {
      console.log(JSON.stringify({ at: new Date().toISOString(), method: request.method, path, answered: 404 }))
      response
        .writeHead(404, { "content-type": "application/json" })
        .end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fake" } }))
      return
    }
    const model = body.model ?? "claude-fake"
    const messages = body.messages ?? []
    // Claude Code may end the list with other roles (its reminders); what counts is the last user message.
    const last = messages.filter((m) => m.role === "user").at(-1)
    const userTexts = messages.filter((m) => m.role === "user").map(textOf)
    const lastText = last === undefined ? "" : textOf(last)
    const toolResult =
      last !== undefined && typeof last.content !== "string" && last.content.some((b) => b.type === "tool_result")
    // Only the agent's own requests carry tools; Claude Code's side requests (titles, summaries) get plain text.
    const withTools = (body.tools?.length ?? 0) > 0
    const run = withTools ? /RUN(_BG)?: (.+)$/m.exec(lastText) : null
    const spawn = withTools ? /AGENT: (\{.+\})$/m.exec(lastText) : null
    const remembered = userTexts.flatMap((t) => [...t.matchAll(/REMEMBER: (\w+)/g)].map((m) => m[1]))
    const answer = toolResult
      ? text("The command ran.")
      : spawn !== null
        ? agent(JSON.parse(spawn[1]!))
        : run !== null
          ? bash(run[2]!.trim(), run[1] !== undefined)
          : text(`I remember: ${remembered.join(", ") || "nothing"}. User messages so far: ${userTexts.length}.`)
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        path,
        client: request.headers["user-agent"],
        model,
        effort: body.output_config?.effort,
        messages: messages.length,
        roles: messages.map((m) => m.role[0]).join(""),
        tools: body.tools?.length ?? 0,
        stream: body.stream === true,
        userMessages: userTexts.length,
        remembered,
        did: toolResult
          ? "after-tool"
          : spawn !== null
            ? `agent: ${spawn[1]}`
            : run !== null
              ? `bash${run[1] ?? ""}: ${run[2]}`
              : "reply"
      })
    )
    const stream = body.stream === true
    response.writeHead(200, {
      "content-type": stream ? "text/event-stream" : "application/json",
      "request-id": `req_fake_${counter}`
    })
    response.end(render(model, answer, stream))
  })
}).listen(port, "127.0.0.1", () => console.log(`fake Messages API on http://127.0.0.1:${port}`))
