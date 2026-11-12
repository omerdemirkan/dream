/**
 * Replays the recorded turns with the model-backed progress line: `Progress`'s rules (a check every 10 seconds, a
 * new line only when the work moved on, at most once a minute) with `CliSummarizer`'s (a model call at most every two
 * minutes, the model-free line between calls and when a call fails), calling the real pinned CLI exactly as dreamd
 * does (`invocation`), and prints the model-backed and model-free lines side by side with what each call used.
 *
 *   node packages/dreamd/scripts/progress-eval/cli-replay.ts [--harness claude-code|codex] [--bins <dir>]
 *        [--max-calls <n>] [--windows <file>] [--answers <file>] [--out <file>]
 *
 * --model      what the CLI is given (default: the newest of `lineModel`'s family in the CLI's own list)
 * --bins       where the CLIs are, laid out as `dreamd bootstrap` leaves them (default ~/.ai-sdk-harness/.harness-bootstrap)
 * --max-calls  stop calling after n calls (later picks stay model-free)
 * --windows    instead of calling, write the windows a call would get (for running them elsewhere)
 * --answers    instead of calling, use the CLI outputs recorded for those windows (one JSON string per line, in order)
 *
 * The CLI's endpoint comes from the environment, as in a sandbox: ANTHROPIC_BASE_URL (Claude Code) or
 * DREAM_CODEX_BASE_URL (Codex) point it at the fake servers in `scripts/`; unset, it goes to the real provider on the
 * placeholder credential, which only E2B's egress rule makes real. Never run it with a real token in the environment.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Option } from "effect"
import {
  type Answer,
  betweenCalls,
  binDir,
  invocation,
  lineFrom,
  lineModel,
  modelEvery,
  parseClaude,
  parseCodex
} from "../../src/progress/CliSummarizer.ts"
import { type Derived, derive, type Shown } from "../../src/progress/Derive.ts"
import { catalogCommand, newestOf, parseClaudeModels, parseCodexCatalog } from "../../src/harness/Models.ts"
import { system } from "../../src/progress/Prompt.ts"
import * as Steps from "../../src/progress/Steps.ts"
import { render } from "../../src/progress/Window.ts"
import { scoreLine } from "./criteria.ts"
import { loadTurns } from "./fixtures.ts"

const arg = (name: string) => {
  const index = process.argv.indexOf(name)
  return index > 0 ? process.argv[index + 1] : undefined
}
const harness = (arg("--harness") ?? "claude-code") as "claude-code" | "codex"
const bins = arg("--bins") ?? binDir(homedir())
const maxCalls = Number(arg("--max-calls") ?? Number.POSITIVE_INFINITY)
const windowsOut = arg("--windows")
const answersIn = arg("--answers")
const out = arg("--out")

const work = join(tmpdir(), "dream-progress-replay")
mkdirSync(join(work, "codex-home"), { recursive: true })
writeFileSync(join(work, "instructions.md"), system)
const catalog = (() => {
  const { command, args, stdin, env } = catalogCommand(harness, bins, work)
  const stdout = execFileSync(command, args, {
    input: stdin,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8"
  })
  return Option.getOrElse(harness === "claude-code" ? parseClaudeModels(stdout) : parseCodexCatalog(stdout), () => [])
})()
const model =
  arg("--model") ??
  (harness === "claude-code"
    ? lineModel[harness]
    : Option.getOrThrow(newestOf(harness, catalog, lineModel[harness])).id)

const call = invocation(harness, {
  model,
  home: homedir(),
  bins,
  env: Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  ),
  instructionsFile: join(work, "instructions.md"),
  codexHome: join(work, "codex-home"),
  codexBaseUrl: process.env.DREAM_CODEX_BASE_URL ?? "https://chatgpt.com/backend-api/codex",
  anthropicBaseUrl: Option.fromNullishOr(process.env.ANTHROPIC_BASE_URL)
})

const recorded =
  answersIn === undefined
    ? []
    : readFileSync(answersIn, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string)
const windows: Array<string> = []

interface CallResult {
  readonly answer: Option.Option<Answer>
  readonly ms: number
}

const ask = (window: string): CallResult | undefined => {
  if (windowsOut !== undefined) {
    windows.push(window)
    return undefined
  }
  if (answersIn !== undefined) {
    const stdout = recorded[windows.length]
    windows.push(window)
    if (stdout === undefined) return undefined
    return { answer: harness === "claude-code" ? parseClaude(stdout) : parseCodex(stdout), ms: 0 }
  }
  const started = Date.now()
  const result = spawnSync(call.command, [...call.args], {
    input: window,
    env: call.env as NodeJS.ProcessEnv,
    cwd: work,
    encoding: "utf8",
    timeout: 60_000
  })
  windows.push(window)
  const stdout = result.stdout ?? ""
  return { answer: harness === "claude-code" ? parseClaude(stdout) : parseCodex(stdout), ms: Date.now() - started }
}

const tick = 10_000
const minInterval = 60_000
const firstAfter = 10_000

interface Row {
  readonly project: string
  readonly minute: number
  readonly modelBacked: string | undefined
  readonly source: string | undefined
  readonly modelFree: string | undefined
  readonly call?: { readonly ms: number; readonly answer: Answer | undefined }
}

const rows: Array<Row> = []
let calls = 0
for (const turn of loadTurns()) {
  let state = Steps.empty
  let next = 0
  let pickedVersion = 0
  let pickedAt = 0
  let lastCall: number | undefined
  // The model-backed line and the model-free one, each with its own "on screen" for holding.
  let shownModel: Shown | undefined
  let shownFree: Shown | undefined
  for (let now = turn.startedAt; now <= turn.endedAt + tick; now += tick) {
    while (next < turn.parts.length && turn.parts[next]!.at <= now) {
      state = Steps.observe(state, turn.parts[next]!.part, turn.parts[next]!.at)
      next++
    }
    if (now - turn.startedAt < firstAfter || state.version === pickedVersion) continue
    if (pickedAt !== 0 && now - pickedAt < minInterval) continue
    pickedVersion = state.version
    pickedAt = now
    const steps = Steps.current(state, now)
    const free = derive({ steps, now, shown: shownFree })
    if (free !== undefined && free.line !== shownFree?.line) shownFree = { line: free.line, at: now, score: free.score }

    let backed: Derived | undefined
    let made: CallResult | undefined
    if ((lastCall === undefined || now - lastCall >= Duration.toMillis(modelEvery)) && calls < maxCalls) {
      lastCall = now
      made = ask(render({ trigger: turn.trigger, startedAt: turn.startedAt, now, previous: shownModel?.line, steps }))
      if (made !== undefined) calls++
      backed = Option.getOrUndefined(
        Option.flatMap(made?.answer ?? Option.none(), (a) =>
          Option.fromNullishOr(lineFrom(a.text, { shown: shownModel }))
        )
      )
    }
    backed ??=
      made === undefined
        ? betweenCalls({ steps, now, shown: shownModel, statusNow: undefined })
        : derive({ steps, now, shown: shownModel })
    if (backed !== undefined && backed.line !== shownModel?.line)
      shownModel = { line: backed.line, at: now, score: backed.score }
    rows.push({
      project: turn.project,
      minute: Math.floor((now - turn.startedAt) / 60_000),
      modelBacked: shownModel?.line,
      source: backed?.source,
      modelFree: shownFree?.line,
      ...(made === undefined ? {} : { call: { ms: made.ms, answer: Option.getOrUndefined(made.answer) } })
    })
  }
}

if (windowsOut !== undefined) {
  writeFileSync(windowsOut, `${windows.map((window) => JSON.stringify(window)).join("\n")}\n`)
  console.log(`${windows.length} windows → ${windowsOut}`)
  process.exit(0)
}

let project = ""
for (const row of rows) {
  if (row.project !== project) {
    project = row.project
    console.log(`\n${project}\n  min  model-backed                                  | model-free`)
  }
  const used =
    row.call?.answer === undefined
      ? row.call === undefined
        ? ""
        : "  (call failed)"
      : `  [${row.call.answer.inputTokens} in, ${row.call.answer.cachedTokens} cached, ${row.call.answer.outputTokens} out${row.call.answer.costUsd === undefined ? "" : `, $${row.call.answer.costUsd.toFixed(5)}`}, ${row.call.ms} ms]`
  console.log(
    `  ${String(row.minute).padStart(3)}  ${(row.modelBacked ?? "—").padEnd(46)}| ${row.modelFree ?? "—"}${used}`
  )
}
const answered = rows.flatMap((row) => (row.call?.answer === undefined ? [] : [row.call.answer]))
const total = (f: (a: Answer) => number) => answered.reduce((sum, a) => sum + f(a), 0)
const modelLines = rows.filter((row) => row.source === "model").map((row) => row.modelBacked!)
console.log(
  `\n${calls} calls, ${answered.length} answered, ${modelLines.length} model lines shown; per answered call: ${Math.round(total((a) => a.inputTokens) / Math.max(1, answered.length))} input tokens (${Math.round(total((a) => a.cachedTokens) / Math.max(1, answered.length))} cached), ${Math.round(total((a) => a.outputTokens) / Math.max(1, answered.length))} output${answered.some((a) => a.costUsd !== undefined) ? `, $${(total((a) => a.costUsd ?? 0) / Math.max(1, answered.length)).toFixed(5)} at list prices` : ""}`
)
const scored = modelLines.map((line) => scoreLine(line, line))
console.log(
  `model lines: fit ${scored.filter((s) => s.fits).length}/${scored.length}, clean ${scored.filter((s) => s.clean).length}/${scored.length}`
)
if (out !== undefined) writeFileSync(out, `${JSON.stringify({ harness, calls, rows }, null, 1)}\n`)
