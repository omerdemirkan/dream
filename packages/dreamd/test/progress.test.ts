import { assert, describe, it } from "@effect/vitest"
import { DaemonEnv } from "@dream/domain"
import { Effect, Layer, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { Api, type Report } from "../src/Api.ts"
import type { Part } from "../src/harness/Turn.ts"
import { check, width } from "../src/progress/Line.ts"
import { derive, fitted, liveness } from "../src/progress/Derive.ts"
import { fromImperative, fromSentence, gerund, presentable } from "../src/progress/Phrase.ts"
import { Progress, triggerOf } from "../src/progress/Progress.ts"
import * as Steps from "../src/progress/Steps.ts"
import { ago, render, windowChars } from "../src/progress/Window.ts"
import { Summarizer } from "../src/progress/Summarizer.ts"
import { summarize, evaluate } from "../scripts/progress-eval/eval.ts"
import { baseLayer, tempDir, userMessage } from "./support.ts"

// Parts as the harness adapters send them (see the adapters' bridges): tool inputs arrive parsed or as JSON.
const call = (id: string, toolName: string, input: unknown) =>
  ({ type: "tool-call", toolCallId: id, toolName, input, providerExecuted: true }) as unknown as Part
const result = (id: string, toolName: string, output: unknown = "ok") =>
  ({ type: "tool-result", toolCallId: id, toolName, input: {}, output, providerExecuted: true }) as unknown as Part
const error = (id: string, toolName: string) =>
  ({
    type: "tool-error",
    toolCallId: id,
    toolName,
    input: {},
    error: "boom",
    providerExecuted: true
  }) as unknown as Part
const thinking = (id: string, text: string): ReadonlyArray<Part> => [
  { type: "reasoning-start", id } as Part,
  { type: "reasoning-delta", id, text } as Part,
  { type: "reasoning-end", id } as Part
]

const fold = (parts: ReadonlyArray<readonly [number, Part]>) =>
  parts.reduce((state, [at, part]) => Steps.observe(state, part, at), Steps.empty)

const texts = (state: Steps.StepsState, now: number) =>
  render({ startedAt: 0, now, steps: Steps.current(state, now) })
    .split("\n")
    .filter((line) => line.startsWith("- "))

describe("Steps", () => {
  it("condenses a Claude Code turn: descriptions, merged edits, failures, helpers and the plan", () => {
    const state = fold([
      ...thinking("r1", "The first scorer is too forgiving. I'll tighten the phoneme threshold.").map(
        (part) => [0, part] as const
      ),
      [10_000, call("t1", "edit", { file_path: "/home/user/project/src/scorer.ts", old_string: "a", new_string: "b" })],
      [11_000, result("t1", "edit")],
      [12_000, call("t2", "edit", JSON.stringify({ file_path: "/home/user/project/src/lesson.tsx" }))],
      [13_000, result("t2", "edit")],
      [20_000, call("t3", "bash", { command: "pnpm vitest run scorer", description: "Run the scorer tests." })],
      [80_000, error("t3", "bash")],
      [90_000, call("t4", "Agent", { description: "Compare two speech models", prompt: "…" })],
      [
        100_000,
        call("t5", "TodoWrite", {
          todos: [
            { content: "Hear each sound", status: "completed", activeForm: "Hearing each sound" },
            { content: "Tune the scorer", status: "in_progress", activeForm: "Tuning the scorer" },
            { content: "Show feedback", status: "pending", activeForm: "Showing feedback" }
          ]
        })
      ],
      [400_000, result("t4", "Agent", "The smaller one is as accurate.")]
    ])
    assert.deepStrictEqual(texts(state, 420_000), [
      "- 7m ago · thought: The first scorer is too forgiving. I'll tighten the phoneme threshold.",
      "- 7m ago · edited src/scorer.ts, src/lesson.tsx",
      "- 7m ago · ran: Run the scorer tests (failed)",
      "- 6m ago · started a helper: Compare two speech models",
      "- 5m ago · plan 1 of 3 done, now: Tuning the scorer",
      "- 20s ago · a helper finished: Compare two speech models"
    ])
    assert.strictEqual(state.version, 6)
  })

  it("keeps a Codex command to its first plain words, and says when it's still running", () => {
    const state = fold([
      [0, call("c1", "bash", { command: "cd /home/user/project && pnpm test -- --run 2>&1 | tail -40" })],
      [1_000, result("c1", "bash", { exitCode: 1, output: "FAIL", status: "completed" })],
      [2_000, call("f1", "fileChange", { event: "modify", path: "src/digest.ts" })],
      [3_000, call("c2", "bash", { command: "node scripts/build-digest.mjs --day monday" })]
    ])
    assert.deepStrictEqual(texts(state, 183_000), [
      "- 3m ago · ran: `pnpm test -- --run` (failed)",
      "- 3m ago · edited src/digest.ts",
      "- 3m ago · ran: `node scripts/build-digest.mjs --day monday` (still running, 3 minutes so far)"
    ])
  })

  it("never keeps what could be a credential", () => {
    assert.strictEqual(Steps.commandWords('curl -H "Authorization: Bearer sk-ant-oat01-abc" https://x'), "curl -H")
    assert.strictEqual(Steps.commandWords("OPENAI_API_KEY=sk-12345 node run.js"), "node run.js")
    assert.strictEqual(Steps.commandWords("export TOKEN=abc && npm start"), "npm start")
    assert.strictEqual(
      Steps.commandWords("gh auth login --with-token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      "gh auth login"
    )
    assert.strictEqual(Steps.commandWords("curl 'https://api.example.com/v1?key=abc'"), "curl")
    const fetched = fold([[0, call("w1", "WebFetch", { url: "https://example.com/reset?token=abc", prompt: "x" })]])
    assert.deepStrictEqual(texts(fetched, 0), ["- now · read a page on example.com"])
  })

  it("turns dream commands into what the person saw, and repeats into a count", () => {
    const state = fold([
      [0, call("d1", "bash", { command: 'dream message "Voice works"', description: "Tell them" })],
      [1_000, call("b1", "bash", { command: "pnpm test", description: "Run the tests" })],
      [2_000, result("b1", "bash")],
      [3_000, call("b2", "bash", { command: "pnpm test", description: "Run the tests" })],
      [4_000, result("b2", "bash")],
      [5_000, call("q1", "ToolSearch", { query: "x" })]
    ])
    assert.deepStrictEqual(texts(state, 5_000), ["- now · sent them a message", "- now · ran: Run the tests ×2"])
    assert.strictEqual(state.version, 2)
  })
})

describe("the window", () => {
  it("says what started the turn, how long it's run, the line on screen and the last steps", () => {
    const state = fold([[0, call("b", "bash", { command: "pnpm test", description: "Run the tests" })]])
    const window = render({
      trigger: "They wrote: “Can it tell me when I say a word wrong?”",
      startedAt: 0,
      now: 35 * 60_000,
      previous: "Testing the scorer",
      steps: Steps.current(state, 35 * 60_000)
    })
    assert.strictEqual(
      window,
      [
        "What started this turn: They wrote: “Can it tell me when I say a word wrong?”",
        "The turn has run 35 minutes.",
        "The line on their screen now: “Testing the scorer”",
        "",
        "The agent's latest steps, oldest first:",
        "- 35m ago · ran: Run the tests (still running, 35 minutes so far)"
      ].join("\n")
    )
  })

  it("keeps the last twelve steps and stays under its size", () => {
    let state = Steps.empty
    for (let i = 0; i < 30; i++) {
      for (const part of thinking(`r${i}`, `Step ${i}: ${"a long thought about the work ".repeat(30)}`)) {
        state = Steps.observe(state, part, i * 1000)
      }
      state = Steps.observe(state, call(`b${i}`, "bash", { command: "x", description: `Run check ${i}` }), i * 1000)
    }
    const window = render({ startedAt: 0, now: 30_000, steps: Steps.current(state, 30_000) })
    const steps = window.split("\n").filter((line) => line.startsWith("- "))
    assert.isAtMost(steps.length, 12)
    assert.isAtMost(window.length, windowChars)
    assert.include(steps.at(-1) ?? "", "Run check 29")
  })

  it("names its times plainly", () => {
    assert.strictEqual(ago(4_000), "now")
    assert.strictEqual(ago(40_000), "40s ago")
    assert.strictEqual(ago(4 * 60_000), "4m ago")
  })

  it("starts from their message when there is one", () => {
    assert.strictEqual(triggerOf([userMessage(1, "Like pero and perro.")]), "They wrote: “Like pero and perro.”")
    assert.strictEqual(triggerOf([]), undefined)
  })
})

describe("the one-line limit", () => {
  it("keeps a line that fits, tidied", () => {
    assert.deepStrictEqual(check("Making the slip detector stricter"), {
      _tag: "Fits",
      text: "Making the slip detector stricter"
    })
    assert.deepStrictEqual(check('"Testing the scorer on 40 recordings."\n'), {
      _tag: "Fits",
      text: "Testing the scorer on 40 recordings"
    })
  })

  it("measures width, not only characters", () => {
    assert.strictEqual(check("Testing it on recordings of pero and perro")._tag, "Fits")
    assert.strictEqual(check("WWWWWWWWWWWWWWWWWWWWWWWWWWW")._tag, "TooLong")
    assert.strictEqual(check("Checking the slip detector against every recording")._tag, "TooLong")
    assert.isBelow(width("Making the slip detector stricter"), 240)
  })

  it("refuses a line that's cut off, empty or more than one sentence", () => {
    assert.strictEqual(check("Testing the scorer on rec…")._tag, "Unusable")
    assert.strictEqual(check("   ")._tag, "Unusable")
    assert.strictEqual(check("Tests failed. Fixing them")._tag, "Unusable")
  })
})

describe("phrases, without a model", () => {
  it("turns verbs into their -ing forms", () => {
    assert.deepStrictEqual(["run", "make", "tie", "see", "commit", "fix", "Write", "set"].map(gerund), [
      "running",
      "making",
      "tying",
      "seeing",
      "committing",
      "fixing",
      "Writing",
      "setting"
    ])
  })

  it("turns a command's description into what's happening, and skips looking around", () => {
    assert.strictEqual(fromImperative("Run the scorer tests."), "Running the scorer tests")
    assert.strictEqual(
      fromImperative("Scaffold web package and install deps"),
      "Scaffolding web package and installing deps"
    )
    assert.strictEqual(fromImperative("Build voice frontend + realtime"), "Building voice frontend and realtime")
    assert.strictEqual(fromImperative("Read spec and list project"), undefined)
    assert.strictEqual(fromImperative("Anki backend server"), undefined)
  })

  it("takes the first clause of a thought that says what the agent is doing", () => {
    assert.strictEqual(
      fromSentence("Now I'm setting up unit tests for the realtime session, using a mock transport and a mock API."),
      "Setting up unit tests for the realtime session"
    )
    assert.strictEqual(
      fromSentence("I'm going to check the episode intro before publishing."),
      "Checking the episode intro before publishing"
    )
    assert.strictEqual(
      fromSentence("I'll move the restart script into the scripts folder."),
      "Moving the restart script into the scripts folder"
    )
    assert.strictEqual(fromSentence("Publishing the app."), "Publishing the app")
    assert.strictEqual(
      fromSentence("**Tightening the threshold**\n\nThe first pass let slips through."),
      "Tightening the threshold"
    )
    assert.strictEqual(fromSentence("I'm checking their deck for Arabic cards."), "Checking your deck for Arabic cards")
  })

  it("leaves out deliberation, past tense and anything that isn't an action", () => {
    assert.strictEqual(fromSentence("I'm weighing whether to end my turn while the subagents run."), undefined)
    assert.strictEqual(fromSentence("I've confirmed the anki package works."), undefined)
    assert.strictEqual(fromSentence("Everything else is already checked off."), undefined)
    assert.strictEqual(fromSentence("I'm looking at Home.tsx."), undefined)
  })

  it("never shows code, the machinery, someone unclear, or a phrase cut short", () => {
    for (const phrase of [
      "Writing db.py",
      "Checking whether probe() updates",
      "Ruling out gpt-live-1",
      "Restarting the agent session",
      "Swapping the placeholder token",
      "Running a quick web search for them",
      "Checking that the router sits",
      "Fixing src/realtime/session",
      "Setting VT_OPENAI_BASE",
      "Fetching https",
      "Opening www and the docs"
    ]) {
      assert.isFalse(presentable(phrase), phrase)
    }
    assert.isTrue(presentable("Checking the sūrah card's Arabic verses"))
  })

  it("keeps a URL whole, so a line never ends at its scheme", () => {
    const thought = fromSentence("I'm fetching https://ankiweb.net/shared/info to check the API.")
    assert.strictEqual(thought, "Fetching https://ankiweb.net/shared/info")
    assert.strictEqual(fitted(thought!), undefined)
    assert.strictEqual(fitted(fromImperative("Fetch https://docs.ankiweb.net/sync")!), undefined)
    assert.strictEqual(fitted("Fetching https"), undefined)
    assert.strictEqual(fromSentence("I'm checking the sync API: what it needs to log in."), "Checking the sync API")
  })
})

describe("the line", () => {
  const steps = (parts: ReadonlyArray<readonly [number, Part]>, now: number) => Steps.current(fold(parts), now)

  it("prefers what the agent said it's doing, then a command's description, then the Status card", () => {
    const now = 120_000
    const thought = steps(
      [
        [0, call("b1", "bash", { command: "pnpm test", description: "Run the scorer tests" })],
        ...thinking("r1", "I'm tightening the slip detector, since the first pass let most slips through.").map(
          (part) => [60_000, part] as const
        )
      ],
      now
    )
    assert.deepStrictEqual(derive({ steps: thought, now }), {
      line: "Tightening the slip detector",
      score: 3,
      source: "thought"
    })
    const command = steps([[0, call("b1", "bash", { command: "pnpm test", description: "Run the scorer tests" })]], now)
    assert.strictEqual(derive({ steps: command, now })?.line, "Running the scorer tests")
    assert.deepStrictEqual(derive({ steps: [], now, statusNow: "Charting your estimated 1RM" }), {
      line: "Charting your estimated 1RM",
      score: 2,
      source: "status"
    })
    assert.strictEqual(derive({ steps: [], now }), undefined)
  })

  it("follows a helper's work, and the plan's current step", () => {
    const helper = steps(
      [
        [0, call("a1", "Agent", { description: "Build voice frontend + realtime" })],
        [
          60_000,
          {
            type: "raw",
            rawValue: {
              type: "assistant",
              parent_tool_use_id: "a1",
              message: {
                content: [{ type: "thinking", thinking: "Now I'm writing the lesson tests for the voice screen." }]
              }
            }
          } as unknown as Part
        ]
      ],
      90_000
    )
    assert.strictEqual(derive({ steps: helper, now: 90_000 })?.line, "Writing the lesson tests")
    const plan = steps(
      [
        [
          0,
          call("t1", "TodoWrite", {
            todos: [
              { content: "Hear each sound", status: "completed", activeForm: "Hearing each sound" },
              { content: "Tune the scorer", status: "in_progress", activeForm: "Tuning the scorer" }
            ]
          })
        ]
      ],
      10_000
    )
    assert.deepStrictEqual(derive({ steps: plan, now: 10_000 }), {
      line: "Tuning the scorer",
      score: 4,
      source: "plan"
    })
  })

  it("drops trailing phrases to fit rather than cutting, and holds a line for two minutes", () => {
    const long = steps(
      thinking(
        "r1",
        "I'm setting up unit tests for the realtime voice tutor against the recorded sample conversations."
      ).map((part) => [0, part] as const),
      10_000
    )
    assert.strictEqual(derive({ steps: long, now: 10_000 })?.line, "Setting up unit tests")
    const shown = { line: "Tuning the scorer", at: 0, score: 3 }
    const next = steps(
      thinking("r2", "I'm rerunning the scorer tests.").map((part) => [50_000, part] as const),
      60_000
    )
    assert.strictEqual(derive({ steps: next, now: 60_000, shown })?.source, "held")
    assert.strictEqual(derive({ steps: next, now: 130_000, shown })?.line, "Rerunning the scorer tests")
  })

  it("says when one long command is all that's going on", () => {
    const running = steps([[0, call("b1", "bash", { command: "pnpm build" })]], 600_000)
    assert.deepStrictEqual(liveness(running, 5_000), { activeAt: 5_000, waitingSince: 0 })
    const done = steps(
      [
        [0, call("b1", "bash", { command: "pnpm build" })],
        [9_000, result("b1", "bash")]
      ],
      600_000
    )
    assert.deepStrictEqual(liveness(done, 9_000), { activeAt: 9_000, waitingSince: undefined })
  })
})

describe("Progress", () => {
  const setup = (env: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const reports = yield* Ref.make<ReadonlyArray<Report>>([])
      const progress = yield* Progress.pipe(
        Effect.provide(
          Progress.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Api.layerTest(reports),
                Summarizer.modelFree,
                baseLayer(tempDir(), { [DaemonEnv.progressLine]: "on", ...env })
              )
            )
          )
        )
      )
      const sent = Effect.map(Ref.get(reports), (all) =>
        all.flatMap((report) => (report._tag === "Progress" ? [report.progress] : []))
      )
      return { progress, sent }
    })

  const doing = (n: number, what: string) => thinking(`r${n}`, `I'm ${what}.`)

  it.effect("reports a line once someone watches and the work moves, changing it at most every minute or two", () =>
    Effect.gen(function* () {
      const { progress, sent } = yield* setup()
      yield* progress.turnStarted([userMessage(1, "Make it check things")])
      yield* Effect.forEach(doing(1, "writing the first check"), progress.observe)
      yield* TestClock.adjust("15 seconds")
      assert.isTrue(Option.isNone(yield* progress.check), "nobody is watching")
      yield* progress.setWatching(true)
      assert.strictEqual(Option.getOrUndefined(yield* progress.check)?.line, "Writing the first check")

      yield* Effect.forEach(doing(2, "writing the second check"), progress.observe)
      yield* TestClock.adjust("30 seconds")
      assert.isTrue(Option.isNone(yield* progress.check), "too soon")
      yield* TestClock.adjust("90 seconds")
      assert.strictEqual(Option.getOrUndefined(yield* progress.check)?.line, "Writing the second check")

      yield* TestClock.adjust("1 minute")
      assert.isTrue(Option.isNone(yield* progress.check), "nothing new happened and the heartbeat isn't due")
      const lines = (yield* sent).map((report) => report.line)
      assert.deepStrictEqual(lines, ["Writing the first check", "Writing the second check"])
    })
  )

  it.effect("keeps proving it's alive while one long command runs, and takes the agent's own now sentence", () =>
    Effect.gen(function* () {
      const { progress, sent } = yield* setup()
      yield* progress.setWatching(true)
      yield* progress.turnStarted([])
      yield* progress.statusNow("Charting your estimated 1RM")
      yield* progress.observe(call("b1", "bash", { command: "pnpm build" }))
      yield* TestClock.adjust("15 seconds")
      const first = Option.getOrThrow(yield* progress.check)
      assert.strictEqual(first.line, "Charting your estimated 1RM")
      assert.strictEqual(first.waitingSince, first.activeAt)
      yield* progress.setWatching(true)
      yield* TestClock.adjust("2 minutes")
      assert.isTrue(Option.isNone(yield* progress.check), "nothing changed, so no heartbeat")
      yield* progress.observe(result("b1", "bash"))
      yield* TestClock.adjust("2 minutes")
      const beat = Option.getOrThrow(yield* progress.check)
      assert.strictEqual(beat.waitingSince, undefined)
      assert.strictEqual((yield* sent).length, 2)
    })
  )

  it.effect("stops when the turn ends, when watching lapses, and when it's off", () =>
    Effect.gen(function* () {
      const { progress } = yield* setup()
      yield* progress.setWatching(true)
      yield* progress.turnStarted([])
      yield* Effect.forEach(doing(1, "writing a check"), progress.observe)
      yield* progress.turnEnded
      yield* TestClock.adjust("1 minute")
      assert.isTrue(Option.isNone(yield* progress.check), "no turn")

      yield* progress.setWatching(true)
      yield* progress.turnStarted([])
      yield* Effect.forEach(doing(1, "writing a check"), progress.observe)
      yield* TestClock.adjust("13 minutes")
      assert.isTrue(Option.isNone(yield* progress.check), "the DO stopped saying anyone watches")

      const off = yield* setup({ [DaemonEnv.progressLine]: "off" })
      yield* off.progress.setWatching(true)
      yield* off.progress.turnStarted([])
      yield* Effect.forEach(doing(1, "writing a check"), off.progress.observe)
      yield* TestClock.adjust("1 minute")
      assert.isTrue(Option.isNone(yield* off.progress.check), "it's off")
    })
  )
})

describe("the recorded turns", () => {
  // The evaluation (`scripts/progress-eval`) on Voice Tutor's and The Morning Build's turns: every line it shows
  // must fit and be clean, and a long turn should have a line on screen nearly all the time without turning into noise.
  it("fit, read clean, cover the turn and change calmly", () => {
    const summary = summarize(evaluate())
    assert.isAtLeast(summary.lines, 20)
    assert.strictEqual(summary.fits, 1)
    assert.strictEqual(summary.clean, 1)
    assert.strictEqual(summary.voice, 1)
    assert.isAtLeast(summary.coverage, 0.8)
    assert.isAtMost(summary.changesPer10Min, 6)
  })
})
