/**
 * The progress line from a small model, through the project's own harness CLI on the login the agent already uses:
 * `claude -p --model haiku` on Claude Code, `codex exec -m gpt-6-luna` on Codex, with the same placeholder
 * credential the agent has (E2B's egress rule puts the real one in, `HarnessEnv.ts`). Nothing in dreamd calls a
 * provider's API itself (docs/proposals/sidecar-terms.html).
 *
 * The model sees only the window (`Window.ts`: what started the turn, how long it's run, the line on screen, the last
 * ten steps), never the conversation, and each CLI is stripped as far as it allows: Claude Code gets Dream's prompt
 * in place of its own, no tools, no settings, MCP servers, slash commands or session file; Codex gets Dream's prompt
 * in place of its base instructions, no shell or other optional tools, no environment, permissions or app
 * instructions, and no session file. What's left is each CLI's own (see scripts/progress-eval/README.md for the
 * cost). Both run at low effort.
 *
 * A model line is asked for at most every `modelEvery`, on top of `Progress`'s own rules (someone watching, the work
 * moved on). Between calls, and whenever a call fails, is slow (`callTimeout`) or answers with something that doesn't
 * fit or isn't presentable, the model-free line (`Derive.ts`) stands in, which keeps a model line up until it's
 * outranked or old. An answer too wide loses trailing phrases rather than asking again, since each ask is a full CLI
 * call.
 */
import { join } from "node:path"
import type { Harness } from "@dream/domain"
import { Clock, Duration, Effect, FileSystem, Layer, Option, Ref, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { DreamdConfig } from "../Config.ts"
import { agentEnv, chatgptCodexBaseUrl, harnessAuth } from "../harness/HarnessEnv.ts"
import { type Derived, derive, fitted } from "./Derive.ts"
import { system } from "./Prompt.ts"
import { Summarizer, type SummaryInput } from "./Summarizer.ts"
import { render } from "./Window.ts"

/** The cheapest current model of each provider, as the pinned CLI names it. */
export const lineModel: Readonly<Record<Harness, string>> = {
  // Claude Code 2.1.318's alias for claude-haiku-5-5; it moves when the CLI does.
  "claude-code": "haiku",
  // The newest luna in Codex 0.165.0's catalog (and 0.167.0's).
  codex: "gpt-6-luna"
}

export const modelEvery = Duration.minutes(2)
export const callTimeout = Duration.seconds(25)
/** What a model line is worth against the model-free sources (`Derive.ts`): above all but the plan's step. */
export const modelScore = 3.5

/** Where `dreamd bootstrap` installs the pinned CLIs. */
export const binDir = (home: string) => join(home, ".ai-sdk-harness", ".harness-bootstrap")

/** Codex features that add tools or instructions a one-line summary doesn't need. */
const codexFeaturesOff = [
  "shell_tool",
  "unified_exec",
  "multi_agent",
  "multi_agent_v2",
  "apps",
  "plugins",
  "skill_search",
  "image_generation",
  "view_image",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "sleep_tool",
  "goals",
  "tool_suggest",
  "hooks",
  "shell_snapshot",
  "realtime_conversation",
  "worktrees",
  "default_mode_request_user_input"
]

export interface Invocation {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

/** The CLI call that asks for a line; the window goes on stdin. */
export const invocation = (
  harness: Harness,
  options: {
    readonly home: string
    readonly bins: string
    readonly env: Readonly<Record<string, string>>
    /** Codex only: Dream's prompt as a file (`model_instructions_file`), and a home of its own. */
    readonly instructionsFile: string
    readonly codexHome: string
    readonly codexBaseUrl: string
    readonly anthropicBaseUrl: Option.Option<string>
  }
): Invocation =>
  harness === "claude-code"
    ? {
        command: join(options.bins, "claude-code", "node_modules", ".bin", "claude"),
        args: [
          "-p",
          "--model",
          lineModel["claude-code"],
          "--effort",
          "low",
          "--system-prompt",
          system,
          "--tools",
          "",
          "--strict-mcp-config",
          "--setting-sources",
          "",
          "--disable-slash-commands",
          "--no-session-persistence",
          "--output-format",
          "json"
        ],
        env: {
          ...options.env,
          ...harnessAuth("claude-code"),
          ...Option.match(options.anthropicBaseUrl, {
            onNone: () => ({}),
            onSome: (url) => ({ ANTHROPIC_BASE_URL: url })
          })
        }
      }
    : {
        command: join(options.bins, "codex", "node_modules", ".bin", "codex"),
        args: [
          "exec",
          "--ignore-user-config",
          "--ignore-rules",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--json",
          "--model",
          lineModel.codex,
          ...codexFeaturesOff.flatMap((feature) => ["--disable", feature]),
          "-c",
          'model_reasoning_effort="low"',
          "-c",
          'web_search="disabled"',
          "-c",
          `model_instructions_file=${JSON.stringify(options.instructionsFile)}`,
          ...[
            "include_permissions_instructions",
            "include_environment_context",
            "include_apps_instructions",
            "include_collaboration_mode_instructions",
            "include_skills_usage_instructions",
            "include_plugin_usage_instructions"
          ].flatMap((key) => ["-c", `${key}=false`]),
          "-c",
          'model_provider="dream"',
          "-c",
          `model_providers.dream={name="Dream",base_url=${JSON.stringify(options.codexBaseUrl)},env_key="CODEX_API_KEY",wire_api="responses",supports_websockets=false}`,
          "-"
        ],
        env: { ...options.env, ...harnessAuth("codex"), CODEX_HOME: options.codexHome }
      }

export interface Answer {
  readonly text: string
  /** Input tokens, all of them (cached included), and how many of those were read from the cache. */
  readonly inputTokens: number
  readonly cachedTokens: number
  readonly outputTokens: number
  /** What Claude Code says the call costs at list prices; Codex doesn't say. */
  readonly costUsd?: number
}

const ClaudeResult = Schema.Struct({
  result: Schema.optionalKey(Schema.String),
  is_error: Schema.optionalKey(Schema.Boolean),
  total_cost_usd: Schema.optionalKey(Schema.Number),
  usage: Schema.optionalKey(
    Schema.Struct({
      input_tokens: Schema.optionalKey(Schema.Number),
      cache_creation_input_tokens: Schema.optionalKey(Schema.Number),
      cache_read_input_tokens: Schema.optionalKey(Schema.Number),
      output_tokens: Schema.optionalKey(Schema.Number)
    })
  )
})
const decodeClaude = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeResult))

/** `claude -p --output-format json`'s one result object. */
export const parseClaude = (stdout: string): Option.Option<Answer> =>
  decodeClaude(stdout.trim()).pipe(
    Option.filter((result) => result.is_error !== true && result.result !== undefined),
    Option.map((result) => {
      const usage = result.usage ?? {}
      const read = usage.cache_read_input_tokens ?? 0
      return {
        text: result.result ?? "",
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + read,
        cachedTokens: read,
        outputTokens: usage.output_tokens ?? 0,
        ...(result.total_cost_usd === undefined ? {} : { costUsd: result.total_cost_usd })
      }
    })
  )

const CodexEvent = Schema.Struct({
  type: Schema.String,
  item: Schema.optionalKey(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
  usage: Schema.optionalKey(
    Schema.Struct({
      input_tokens: Schema.optionalKey(Schema.Number),
      cached_input_tokens: Schema.optionalKey(Schema.Number),
      output_tokens: Schema.optionalKey(Schema.Number),
      reasoning_output_tokens: Schema.optionalKey(Schema.Number)
    })
  )
})
const decodeCodexEvent = Schema.decodeUnknownOption(Schema.fromJsonString(CodexEvent))

/** `codex exec --json`'s event lines: the last agent message, and the turn's usage. */
export const parseCodex = (stdout: string): Option.Option<Answer> => {
  const events = stdout.split("\n").flatMap((line) => Option.toArray(decodeCodexEvent(line.trim())))
  const message = events.findLast((event) => event.type === "item.completed" && event.item?.type === "agent_message")
  const usage = events.findLast((event) => event.type === "turn.completed")?.usage
  if (message?.item?.text === undefined) return Option.none()
  return Option.some({
    text: message.item.text,
    inputTokens: usage?.input_tokens ?? 0,
    cachedTokens: usage?.cached_input_tokens ?? 0,
    outputTokens: (usage?.output_tokens ?? 0) + (usage?.reasoning_output_tokens ?? 0)
  })
}

/**
 * Between model calls: a model line stays up until the next call replaces it (the model is the voice, and swapping it
 * for a model-free line in between would make the line flip every minute); before the first model line, and after a
 * call that gave nothing usable, the model-free line stands in.
 */
export const betweenCalls = (
  input: Pick<SummaryInput, "steps" | "now" | "shown" | "statusNow">
): Derived | undefined =>
  input.shown !== undefined && input.shown.score === modelScore
    ? { line: input.shown.line, score: input.shown.score, source: "held" }
    : derive(input)

/** What to show for a model's answer: the line (made to fit), the one on screen if it says the same, or nothing. */
export const lineFrom = (answer: string, input: Pick<SummaryInput, "shown">): Derived | undefined => {
  const first =
    answer
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  const line = fitted(first)
  if (line === undefined) return undefined
  if (input.shown !== undefined && line.toLowerCase() === input.shown.line.toLowerCase()) {
    return { line: input.shown.line, score: input.shown.score, source: "held" }
  }
  return { line, score: modelScore, source: "model" }
}

const ClaudeSettings = Schema.Struct({
  env: Schema.optionalKey(Schema.Struct({ ANTHROPIC_BASE_URL: Schema.optionalKey(Schema.String) }))
})
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeSettings))

export const layer = Layer.effect(
  Summarizer,
  Effect.gen(function* () {
    const config = yield* DreamdConfig
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dir = join(config.stateDir, "progress")
    const instructionsFile = join(dir, "instructions.md")
    const codexHome = join(dir, "codex-home")
    yield* fs.makeDirectory(codexHome, { recursive: true }).pipe(Effect.ignore)
    yield* fs.writeFileString(instructionsFile, system).pipe(Effect.ignore)
    // The fake model servers in tests are named in Claude Code's own settings, which the call doesn't load.
    const anthropicBaseUrl = yield* fs.readFileString(join(config.home, ".claude", "settings.json")).pipe(
      Effect.map(decodeSettings),
      Effect.map(Option.flatMap((settings) => Option.fromNullishOr(settings.env?.ANTHROPIC_BASE_URL))),
      Effect.orElseSucceed(() => Option.none<string>())
    )
    const call = invocation(config.harness, {
      home: config.home,
      bins: binDir(config.home),
      env: agentEnv(process.env, config),
      instructionsFile,
      codexHome,
      codexBaseUrl: Option.getOrElse(config.codexBaseUrl, () => chatgptCodexBaseUrl),
      anthropicBaseUrl
    })
    const lastCallAt = yield* Ref.make<number | undefined>(undefined)

    const ask = (window: string) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(call.command, [...call.args], {
              cwd: dir,
              env: call.env,
              extendEnv: false,
              stdin: { stream: Stream.make(new TextEncoder().encode(window)) }
            })
          )
          const [stdout] = yield* Effect.all(
            [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
            {
              concurrency: 2
            }
          )
          return config.harness === "claude-code" ? parseClaude(stdout) : parseCodex(stdout)
        })
      ).pipe(
        Effect.timeoutOption(callTimeout),
        Effect.map(Option.flatten),
        Effect.catch((error) =>
          Effect.logWarning("The progress summary call failed", { error: error.message }).pipe(
            Effect.as(Option.none<Answer>())
          )
        )
      )

    return Summarizer.of({
      name: `${config.harness} ${lineModel[config.harness]}`,
      summarize: (input) =>
        Effect.gen(function* () {
          const last = yield* Ref.get(lastCallAt)
          if (last !== undefined && input.now - last < Duration.toMillis(modelEvery)) {
            return Option.fromNullishOr(betweenCalls(input))
          }
          yield* Ref.set(lastCallAt, input.now)
          const started = yield* Clock.currentTimeMillis
          const answer = yield* ask(
            render({
              trigger: input.trigger,
              startedAt: input.startedAt,
              now: input.now,
              previous: input.shown?.line,
              steps: input.steps
            })
          )
          const line = Option.flatMap(answer, (a) => Option.fromNullishOr(lineFrom(a.text, input)))
          yield* Effect.logInfo("Progress summary", {
            model: lineModel[config.harness],
            ms: (yield* Clock.currentTimeMillis) - started,
            used: Option.isSome(line),
            ...Option.match(answer, {
              onNone: () => ({ answered: false }),
              onSome: (a) => ({
                inputTokens: a.inputTokens,
                cachedTokens: a.cachedTokens,
                outputTokens: a.outputTokens,
                ...(a.costUsd === undefined ? {} : { costUsd: a.costUsd })
              })
            })
          })
          return Option.isSome(line) ? line : Option.fromNullishOr(derive(input))
        })
    })
  })
)
