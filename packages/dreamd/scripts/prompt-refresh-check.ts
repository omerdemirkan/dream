/**
 * Checks that new guidance (Dream's system prompt and skills) reaches a project's agent across a
 * refresh, on dreamd's real harness, with the real Claude Code and Codex CLIs against the fake model servers
 * (fake-anthropic.ts, fake-responses.ts), so no account is needed:
 *
 *   node packages/dreamd/scripts/prompt-refresh-check.ts [claude-code|codex]     (default: both)
 *
 * Each turn runs in a process of its own, as dreamd does across a template refresh (which restarts it), on
 * Dream's prompt and skills with a `PROMPT-MARK` and `SKILL-MARK` added: two turns on version one, then two on
 * version two. It checks what each model request carried:
 *
 *   Claude Code   the same conversation throughout (the fake recalls REMEMBER words), the system prompt of the
 *                 version the turn ran on, and the note saying it changed on the first turn of version two only.
 *   Codex         the same thread on version one; on version two a new thread whose developer instructions are
 *                 version two's, and whose first prompt is the handoff, quoting the old thread.
 *
 * It needs pnpm on PATH, and the network the first time, when the harness installs its bridge under the check's
 * HOME (CHECK_HOME, default /tmp/dream-prompt-check, kept between runs for that; everything else is reset).
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { systemPrompt } from "@dream/agent-context"
import { DaemonEnv, type Harness as HarnessName } from "@dream/domain"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { DreamdConfig } from "../src/Config.ts"
import { Harness } from "../src/harness/Harness.ts"
import * as Skill from "../src/harness/Skill.ts"

const scripts = fileURLToPath(new URL(".", import.meta.url))
const home = process.env.CHECK_HOME ?? "/tmp/dream-prompt-check"
const ports = { anthropic: 18799, responses: 18798 }

/** One turn on `version` of the guidance, in this process (`turn <harness> <version> <prompt>`). */
const turn = async (harness: HarnessName, version: string, prompt: string) => {
  const skills = await Effect.runPromise(Skill.all)
  const guidance = {
    instructions: `${systemPrompt}\n\nPROMPT-MARK: v${version}`,
    skills: skills.map((skill) => ({ ...skill, content: `${skill.content}\n\nSKILL-MARK: v${version}` }))
  }
  const config = DreamdConfig.layerFromRecord({
    HOME: home,
    DREAM_STATE_DIR: join(home, ".dream", "state"),
    DREAM_WORKDIR: join(home, "project"),
    [DaemonEnv.apiUrl]: "http://127.0.0.1:1",
    [DaemonEnv.projectId]: "prj_check",
    [DaemonEnv.projectToken]: "check-project-token",
    [DaemonEnv.daemonToken]: "check-daemon-token",
    [DaemonEnv.harness]: harness,
    [DaemonEnv.socket]: join(home, "dreamd.sock"),
    DREAM_CODEX_BASE_URL: `http://127.0.0.1:${ports.responses}/v1`
  })
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const agent = yield* Harness
      return yield* agent.turn(prompt, { ask: () => Effect.die(new Error("The check asks no questions")) })
    }).pipe(
      Effect.scoped,
      Effect.provide(Harness.layerWith(guidance).pipe(Layer.provideMerge(Layer.mergeAll(config, NodeServices.layer))))
    )
  )
  console.log(JSON.stringify({ outcome: result.outcome._tag, finalText: result.finalText }))
}

type Request = Record<string, unknown>

const startFake = (script: string, port: number, log: string): ChildProcess => {
  rmSync(log, { force: true })
  return spawn(
    "sh",
    ["-c", `exec node ${JSON.stringify(join(scripts, script))} ${port} > ${JSON.stringify(log)} 2>&1`],
    { stdio: "ignore" }
  )
}

const requests = (log: string): ReadonlyArray<Request> =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Request)
    : []

const failures: Array<string> = []
const expect = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures.push(what)
}

const check = (harness: HarnessName) => {
  console.log(`\n== ${harness}`)
  // Keep the installed bridge, reset everything else: the project, its session, the CLIs' conversations.
  mkdirSync(home, { recursive: true })
  for (const entry of readdirSync(home)) if (entry !== ".ai-sdk-harness") rmSync(join(home, entry), { recursive: true })
  for (const dir of [".ai-sdk-harness/sessions", ".ai-sdk-harness/session-data"]) {
    rmSync(join(home, dir), { recursive: true, force: true })
  }
  mkdirSync(join(home, "project"), { recursive: true })
  const log = join(home, `fake-${harness}.log`)
  const fake =
    harness === "claude-code"
      ? startFake("fake-anthropic.ts", ports.anthropic, log)
      : startFake("fake-responses.ts", ports.responses, log)
  execFileSync("sleep", ["1"])
  const steps = [
    { version: "1", prompt: "REMEMBER: apple" },
    { version: "1", prompt: "And now?" },
    { version: "2", prompt: "After the refresh." },
    { version: "2", prompt: "Once more." }
  ]
  const seen: Array<ReadonlyArray<Request>> = []
  try {
    for (const step of steps) {
      const before = requests(log).length
      const output = execFileSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "turn", harness, step.version, step.prompt],
        {
          env: { ...process.env, HOME: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${ports.anthropic}` },
          encoding: "utf8",
          timeout: 600_000,
          stdio: ["ignore", "pipe", "inherit"]
        }
      )
      const made = requests(log)
        .slice(before)
        .filter((request) => request.role === "agent")
      console.log(`turn on v${step.version}: ${output.trim().split("\n").at(-1)}; ${made.length} request(s)`)
      seen.push(made)
    }
  } finally {
    fake.kill()
  }
  const last = (turn: number) => seen[turn]?.at(-1) ?? {}
  const marks = (request: Request) =>
    harness === "claude-code"
      ? ((request.systemMarks as ReadonlyArray<string> | undefined) ?? [])
      : ((request.developerMarks as ReadonlyArray<ReadonlyArray<string>> | undefined) ?? []).flat()
  const remembered = (request: Request) =>
    ((request.remembered as ReadonlyArray<string> | undefined) ?? []).includes("apple")
  const users = (request: Request) => Number(request.userMessages ?? 0)

  expect(
    seen.every((made) => made.length > 0),
    "every turn reached the model"
  )
  expect(marks(last(0)).join() === "v1" && marks(last(1)).join() === "v1", "turns on v1 carry v1's prompt")
  expect(remembered(last(1)), "the second turn on v1 is the same conversation")
  expect(marks(last(2)).join() === "v2", "the first turn on v2 carries v2's prompt, and only it")
  expect(marks(last(3)).join() === "v2", "the second turn on v2 carries v2's prompt")
  expect(remembered(last(2)) && remembered(last(3)), "the turns on v2 still know what was said on v1")
  if (harness === "claude-code") {
    expect(users(last(3)) === users(last(1)) + 2, "Claude Code: the same conversation throughout")
  } else {
    expect(users(last(2)) < users(last(1)) + 1, "Codex: v2 runs in a new thread")
  }
  // What the turn's prompt opened with, on the turn's first request.
  const opening = (turn: number) => String(seen[turn]?.[0]?.opening ?? "")
  const note = harness === "claude-code" ? "Dream updated its guidance" : "Dream started this conversation"
  expect(opening(2).startsWith(note), `the first turn on v2 opens with "${note}…"`)
  expect(
    [0, 1, 3].every((turn) => !opening(turn).startsWith("Dream")),
    "no other turn does"
  )
}

if (process.argv[2] === "turn") {
  await turn(process.argv[3] as HarnessName, process.argv[4] ?? "1", process.argv[5] ?? "")
  process.exit(0)
} else {
  const which = process.argv[2] === undefined ? (["claude-code", "codex"] as const) : [process.argv[2] as HarnessName]
  for (const harness of which) check(harness)
  console.log(failures.length === 0 ? "\nAll checks passed." : `\n${failures.length} check(s) failed.`)
  process.exit(failures.length === 0 ? 0 : 1)
}
