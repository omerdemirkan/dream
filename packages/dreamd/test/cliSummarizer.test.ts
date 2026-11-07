import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { DaemonEnv } from "@dream/domain"
import { Effect, Layer, Option } from "effect"
import * as Cli from "../src/progress/CliSummarizer.ts"
import { marker, system } from "../src/progress/Prompt.ts"
import * as Steps from "../src/progress/Steps.ts"
import { Summarizer, type SummaryInput } from "../src/progress/Summarizer.ts"
import { baseLayer, tempDir } from "./support.ts"

/**
 * A stand-in for a pinned CLI at the path `dreamd bootstrap` installs it to: it records its arguments, stdin and
 * environment, and prints what `answer` says, the way `claude -p --output-format json` or `codex exec --json` would.
 */
const fakeCli = (home: string, harness: "claude-code" | "codex", answer: string, delaySeconds = 0) => {
  const bin = join(Cli.binDir(home), harness, "node_modules", ".bin")
  mkdirSync(bin, { recursive: true })
  const file = join(bin, harness === "claude-code" ? "claude" : "codex")
  const record = join(home, `${harness}-call.json`)
  writeFileSync(
    file,
    `#!/usr/bin/env node
let stdin = ""
process.stdin.on("data", (d) => (stdin += d))
process.stdin.on("end", () => {
  require("fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), stdin, env: process.env }))
  setTimeout(() => process.stdout.write(${JSON.stringify(answer)}), ${delaySeconds * 1000})
})
`
  )
  chmodSync(file, 0o755)
  return () =>
    JSON.parse(readFileSync(record, "utf8")) as { args: Array<string>; stdin: string; env: Record<string, string> }
}

const claudeAnswer = (result: string) =>
  JSON.stringify({
    type: "result",
    is_error: false,
    result,
    total_cost_usd: 0.0003,
    usage: { input_tokens: 40, cache_creation_input_tokens: 300, cache_read_input_tokens: 1200, output_tokens: 9 }
  })

const codexAnswer = (text: string) =>
  [
    { type: "thread.started", thread_id: "t" },
    { type: "item.completed", item: { id: "i", type: "agent_message", text } },
    {
      type: "turn.completed",
      usage: { input_tokens: 6200, cached_input_tokens: 5100, output_tokens: 9, reasoning_output_tokens: 20 }
    }
  ]
    .map((event) => JSON.stringify(event))
    .join("\n")

const thought = (text: string) =>
  [
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", text },
    { type: "reasoning-end", id: "r" }
  ].reduce((state, part) => Steps.observe(state, part as never, 0), Steps.empty)

const input = (now = 60_000): SummaryInput => ({
  steps: Steps.current(thought("I'm checking the font, since the intro looked off."), now),
  trigger: "They wrote: “Make it nicer”",
  startedAt: 0,
  now,
  shown: undefined,
  statusNow: undefined
})

const summarizer = (home: string, harness: "claude-code" | "codex") =>
  Effect.provide(
    Effect.gen(function* () {
      return yield* Summarizer
    }),
    Cli.layer.pipe(
      Layer.provideMerge(baseLayer(home, { [DaemonEnv.harness]: harness, [DaemonEnv.progressLine]: "on" }))
    )
  )

describe("the CLI summariser", () => {
  it.effect("asks Claude Code's haiku for a line, with Dream's prompt, no tools and only the window", () =>
    Effect.gen(function* () {
      const home = tempDir()
      const call = fakeCli(home, "claude-code", claudeAnswer("Checking the intro's font"))
      const s = yield* summarizer(home, "claude-code")
      assert.deepStrictEqual(
        yield* s.summarize(input()),
        Option.some({ line: "Checking the intro's font", score: 3.5, source: "model" })
      )
      const { args, stdin, env } = call()
      assert.deepStrictEqual(args.slice(0, 5), ["-p", "--model", "haiku", "--effort", "low"])
      assert.strictEqual(args[args.indexOf("--system-prompt") + 1], system)
      assert.strictEqual(args[args.indexOf("--tools") + 1], "")
      assert.includeMembers(args, ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"])
      assert.include(stdin, "What started this turn: They wrote: “Make it nicer”")
      assert.include(stdin, "thought: I'm checking the font")
      assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, "dream-placeholder")
      assert.isUndefined(env[DaemonEnv.projectToken])
    })
  )

  it.effect("asks Codex's luna, with Dream's prompt as its instructions and its optional tools off", () =>
    Effect.gen(function* () {
      const home = tempDir()
      const call = fakeCli(home, "codex", codexAnswer("Checking the intro's font"))
      const s = yield* summarizer(home, "codex")
      assert.strictEqual(Option.getOrUndefined(yield* s.summarize(input()))?.line, "Checking the intro's font")
      const { args, env } = call()
      assert.deepStrictEqual(args.slice(0, 2), ["exec", "--ignore-user-config"])
      assert.strictEqual(args[args.indexOf("--model") + 1], "gpt-6-luna")
      assert.include(args.join(" "), "--disable shell_tool")
      assert.include(args.join(" "), "model_instructions_file=")
      const file = /model_instructions_file="(.+)"/.exec(args.join("\n"))?.[1] ?? ""
      assert.include(readFileSync(file, "utf8"), marker)
      assert.strictEqual(env.CODEX_API_KEY, "dream-placeholder")
      assert.include(args.join(" "), 'base_url="https://chatgpt.com/backend-api/codex"')
    })
  )

  it.effect("calls at most every two minutes, and falls back to the model-free line between calls and on failure", () =>
    Effect.gen(function* () {
      const home = tempDir()
      fakeCli(home, "claude-code", claudeAnswer("Checking the intro's font"))
      const s = yield* summarizer(home, "claude-code")
      assert.strictEqual(Option.getOrUndefined(yield* s.summarize(input(60_000)))?.source, "model")
      // A minute later: no call, the model-free line.
      assert.deepStrictEqual(
        yield* s.summarize(input(120_000)),
        Option.some({ line: "Checking the font", score: 3, source: "thought" })
      )
      // A failed call (not JSON) falls back too.
      fakeCli(home, "claude-code", "Error: something went wrong")
      assert.strictEqual(Option.getOrUndefined(yield* s.summarize(input(200_000)))?.source, "thought")
    })
  )

  it.live(
    "drops a slow call for the model-free line",
    () =>
      Effect.gen(function* () {
        const home = tempDir()
        fakeCli(home, "claude-code", claudeAnswer("Too late"), 40)
        const s = yield* summarizer(home, "claude-code")
        assert.strictEqual(Option.getOrUndefined(yield* s.summarize(input()))?.source, "thought")
      }),
    40_000
  )

  it("keeps a model's answer only if it fits and reads clean, and notices when nothing changed", () => {
    assert.deepStrictEqual(Cli.lineFrom("Checking the intro's font\n", { shown: undefined }), {
      line: "Checking the intro's font",
      score: 3.5,
      source: "model"
    })
    assert.strictEqual(
      Cli.lineFrom("Checking the episode intro against every recording in the archive", { shown: undefined })?.line,
      "Checking the episode intro"
    )
    assert.isUndefined(Cli.lineFrom("Editing src/intro.ts", { shown: undefined }))
    assert.strictEqual(
      Cli.lineFrom("checking the intro's font", { shown: { line: "Checking the intro's font", at: 0, score: 3.5 } })
        ?.source,
      "held"
    )
  })

  it("reads each CLI's answer and what it used", () => {
    assert.deepStrictEqual(
      Cli.parseClaude(claudeAnswer("A line")),
      Option.some({
        text: "A line",
        inputTokens: 1540,
        cachedTokens: 1200,
        outputTokens: 9,
        costUsd: 0.0003
      })
    )
    assert.deepStrictEqual(
      Cli.parseCodex(codexAnswer("A line")),
      Option.some({
        text: "A line",
        inputTokens: 6200,
        cachedTokens: 5100,
        outputTokens: 29
      })
    )
    assert.isTrue(Option.isNone(Cli.parseClaude(JSON.stringify({ type: "result", is_error: true, result: "429" }))))
    assert.isTrue(Option.isNone(Cli.parseCodex("not json")))
  })
})
