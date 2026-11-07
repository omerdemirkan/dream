/**
 * A stand-in for Anthropic's Messages API, for running Claude Code turns without a Claude account, with a script:
 *
 *   - a prompt containing `RUN: <command>` gets a Bash tool call running it (`RUN_BG: <command>` runs it with
 *     `run_in_background`), then, once the result comes back, a reply saying so;
 *   - a prompt containing `SKILL: <name>` gets a Skill tool call loading that skill;
 *   - a prompt containing `AGENT: <json>` gets an Agent tool call with that input (say
 *     `{"description":"check","prompt":"say hi","model":"haiku","effort":"low"}`), to start a subagent;
 *   - a progress-line request (`scripts/progress-eval/compare.ts`) gets a line too long for the phone, then, asked
 *     again, one that fits;
 *   - any other prompt gets a reply listing every `REMEMBER: <word>` the conversation holds, and how many user
 *     messages it has, so a resumed session shows its history.
 *
 * `AGENT: {…,"run_in_background":true}` starts a background subagent; give it `"prompt":"SUBAGENT: RUN: sleep 30"`
 * to keep it working past the reply, and `RUN_BG:` does the same for a command. Each logged request says whether it's
 * Claude Code's own turn for background work that reported back (`notified`) and whether its prompt tells the agent
 * background work was stopped (`stoppedNote`).
 *
 * Every response reports usage that says who asked, so a turn's reported tokens show what was counted:
 *
 *   the agent's own requests        input 100, cache write 1,000, cache read 10,000, output 10
 *   a subagent's (its conversation  input 3, cache write 30,000, cache read 300,000, output 3,000
 *     mentions SUBAGENT, no AGENT:)
 *   side requests (no tools)        input 7, output 70
 *
 *   node packages/dreamd/scripts/fake-anthropic.ts [port]     (default 18789)
 *
 * Point Claude Code at it with ANTHROPIC_BASE_URL=http://127.0.0.1:<port> (in dreamd's sandbox, through the `env`
 * of ~/.claude/settings.json). It prints one JSON line per request, with the model and effort asked for, never the
 * Authorization header. `persona` says which of Dream's system prompts the request carries ("agent" or "task"), and
 * `system` and `systemMarks` which version of it (see `systemOf`).
 * Node built-ins only, so it runs from anywhere.
 */
import { createHash } from "node:crypto"
import { createServer } from "node:http"

/** Which of Dream's system prompts the request carries, by its opening words: the agent's, or a scheduled task's. */
const personaOf = (raw: string): "agent" | "task" | undefined =>
  raw.includes("You're running one job for a project in Dream")
    ? "task"
    : raw.includes("You're the agent behind one project in Dream")
      ? "agent"
      : undefined

/**
 * What the request's system prompt is, apart from the conversation: a short hash of it, and every
 * `PROMPT-MARK: <word>` it holds, so a test can plant a word in Dream's prompt and see which version a request carries.
 */
const systemOf = (system: unknown) => {
  const all =
    typeof system === "string"
      ? system
      : Array.isArray(system)
        ? (system as ReadonlyArray<Block>).map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n")
        : ""
  return {
    system: createHash("sha256").update(all).digest("hex").slice(0, 12),
    systemMarks: [...all.matchAll(/PROMPT-MARK: (\w+)/g)].map((m) => m[1])
  }
}

const port = Number(process.argv[2] ?? 18789)

type Block = { readonly type: string; readonly text?: string; readonly content?: unknown }
type Message = { readonly role: string; readonly content: string | ReadonlyArray<Block> }

const textOf = (message: Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n")

/** The start of a user message's own text, past the reminders Claude Code puts in it. */
const openingOf = (message: Message | undefined): string =>
  (message === undefined
    ? []
    : typeof message.content === "string"
      ? [message.content]
      : message.content.map((b) => b.text ?? "")
  )
    .map((text) => text.trim())
    .find((text) => text !== "" && !text.startsWith("<"))
    ?.slice(0, 80) ?? ""

const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("")

let counter = 0

type Reply = { readonly block: Record<string, unknown>; readonly stop: string }

type Usage = {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_creation_input_tokens: number
  readonly cache_read_input_tokens: number
}

const usageOf = {
  agent: { input_tokens: 100, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 10_000, output_tokens: 10 },
  subagent: {
    input_tokens: 3,
    cache_creation_input_tokens: 30_000,
    cache_read_input_tokens: 300_000,
    output_tokens: 3_000
  },
  side: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 70 }
} satisfies Record<string, Usage>

/** The reply as a Messages API stream, or as one JSON message for a request that didn't ask to stream. */
const render = (model: string, { block, stop }: Reply, stream: boolean, usage: Usage) => {
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
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage },
    { type: "message_stop" }
  ])
}

const text = (body: string): Reply => ({ block: { type: "text", text: body }, stop: "end_turn" })

const agent = (input: unknown): Reply => ({
  block: { type: "tool_use", id: `toolu_fake_${counter + 1}`, name: "Agent", input },
  stop: "tool_use"
})

const useSkill = (skill: string): Reply => ({
  block: { type: "tool_use", id: `toolu_fake_${counter + 1}`, name: "Skill", input: { skill } },
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
    let raw = ""
    let body: {
      model?: string
      system?: unknown
      messages?: ReadonlyArray<Message>
      tools?: ReadonlyArray<unknown>
      stream?: boolean
      output_config?: { effort?: string }
    } = {}
    try {
      raw = Buffer.concat(chunks).toString("utf8")
      body = JSON.parse(raw || "{}")
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
    // A progress line (`scripts/progress-eval`): too long the first time, so the retry is exercised, then one that fits.
    // Claude Code sends its system prompt as blocks; the API takes a string too.
    const system =
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system.map((block: { text?: string }) => block.text ?? "").join("\n")
          : ""
    if (system.includes("dream-progress-line")) {
      const retry = (body.messages ?? []).length > 1
      const messageChars = (body.messages ?? []).reduce((n, m) => n + textOf(m).length, 0)
      console.log(
        JSON.stringify({
          at: new Date().toISOString(),
          path,
          client: request.headers["user-agent"],
          model: body.model,
          did: retry ? "progress-line retry" : "progress-line",
          // What one summary costs to send: the CLI's own additions show up here.
          systemChars: system.length,
          messageChars,
          tools: body.tools?.length ?? 0,
          bodyBytes: Buffer.concat(chunks).length,
          thinking: (body as { thinking?: unknown }).thinking,
          effort: body.output_config?.effort
        })
      )
      const stream = body.stream === true
      response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" })
      response.end(
        render(
          body.model ?? "claude-fake",
          text(
            retry ? "Checking the progress line" : "Checking every progress line the fake server was asked for today"
          ),
          stream,
          usageOf.side
        )
      )
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
    const skill = withTools ? /SKILL: ([\w-]+)$/m.exec(lastText) : null
    const role = !withTools
      ? "side"
      : userTexts.some((t) => t.includes("SUBAGENT")) && !userTexts.some((t) => /AGENT: \{/.test(t))
        ? "subagent"
        : "agent"
    const remembered = userTexts.flatMap((t) => [...t.matchAll(/REMEMBER: (\w+)/g)].map((m) => m[1]))
    const answer = toolResult
      ? text("The command ran.")
      : spawn !== null
        ? agent(JSON.parse(spawn[1]!))
        : skill !== null
          ? useSkill(skill[1]!)
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
        persona: personaOf(raw),
        ...systemOf(body.system),
        messages: messages.length,
        roles: messages.map((m) => m.role[0]).join(""),
        tools: body.tools?.length ?? 0,
        stream: body.stream === true,
        role,
        usage: usageOf[role],
        userMessages: userTexts.length,
        // What the last user message opens with, so a check can see what the turn's prompt started with.
        opening: openingOf(last),
        // Every line of the last user message that says what they wrote and where (a thread), for checks.
        wrote: lastText.split("\n").filter((line) => /They (wrote|sent) \(/.test(line)),
        // Claude Code's own turn for background work that reported back.
        notified: lastText.includes("<task-notification>"),
        // A turn prompt telling the agent its background work was stopped (`BackgroundStopped`).
        stoppedNote:
          /Dream stopped it|Dream stopped what was still running|Dream restarted during your last turn|which stopped it|stopped with it before it reported back/.test(
            lastText
          ),
        remembered,
        // Every `SKILL-MARK: <word>` in the conversation, oldest first: which skill listings and bodies it saw.
        skillMarks: messages.flatMap((m) =>
          [...JSON.stringify(m.content).matchAll(/SKILL-MARK: (\w+)/g)].map((found) => found[1])
        ),
        did: toolResult
          ? "after-tool"
          : spawn !== null
            ? `agent: ${spawn[1]}`
            : skill !== null
              ? `skill: ${skill[1]}`
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
    response.end(render(model, answer, stream, usageOf[role]))
  })
}).listen(port, "127.0.0.1", () => console.log(`fake Messages API on http://127.0.0.1:${port}`))
