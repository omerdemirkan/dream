/** A harness turn driven with fake harness events: question calls, continuations and the final text. */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ToolResultPart } from "@ai-sdk/provider-utils"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Ref, Stream } from "effect"
import { Harness } from "../src/harness/Harness.ts"
import {
  claudeSettings,
  type DreamQuestion,
  deniedClaudeTools,
  disabledClaudeSkills,
  type QuestionOutcome,
  replyFromFinalText
} from "../src/harness/PersonChannel.ts"
import { drive, type Part } from "../src/harness/Turn.ts"
import { baseLayer, tempDir } from "./support.ts"

const step: Part = { type: "start-step", request: {}, warnings: [] }
const text = (value: string): Part => ({ type: "text-delta", id: "t", text: value })
const toolCall = (toolName: string, input: unknown, providerExecuted = false): Part => ({
  type: "tool-call",
  toolCallId: `call_${toolName}`,
  toolName,
  input,
  providerExecuted,
  dynamic: true
})

/** What the harness emits for Claude Code's `AskUserQuestion` (see the adapter's `toHarnessQuestionsInput`). */
const askUserQuestion = toolCall("askUserQuestions", {
  allowPartialAnswers: true,
  questions: [
    {
      id: "question-1",
      question: "What features matter most for the site?",
      header: "Features",
      options: [
        { id: "option-1", label: "Tour dates", description: "Upcoming shows" },
        { id: "option-2", label: "Music", description: "Streaming links" }
      ],
      allowMultiple: true,
      allowFreeForm: true
    },
    {
      id: "question-2",
      question: "Do you have photos ready?",
      header: "Content",
      options: [
        { id: "option-1", label: "Yes" },
        { id: "option-2", label: "Not yet" }
      ],
      allowMultiple: false,
      allowFreeForm: true
    }
  ]
})

const run = (start: ReadonlyArray<Part>, afterAnswer: ReadonlyArray<Part> = [], failAsk = false) =>
  Effect.gen(function* () {
    const asked = yield* Ref.make<ReadonlyArray<DreamQuestion>>([])
    const answered = yield* Ref.make<ReadonlyArray<ReadonlyArray<ToolResultPart>>>([])
    const seen = yield* Ref.make(0)
    const result = yield* drive(
      {
        start: Stream.fromIterable(start),
        answer: (results) =>
          Stream.fromEffect(Ref.update(answered, (all) => [...all, results])).pipe(
            Stream.flatMap(() => Stream.fromIterable(afterAnswer))
          )
      },
      {
        ask: (question) =>
          Ref.modify(asked, (all): [QuestionOutcome, ReadonlyArray<DreamQuestion>] => [
            failAsk
              ? { _tag: "NotSent", reason: "the API is down" }
              : { _tag: "Sent", messageId: `msg_${all.length + 1}` },
            [...all, question]
          ])
      },
      () => Ref.update(seen, (n) => n + 1)
    )
    return { ...result, asked: yield* Ref.get(asked), answered: yield* Ref.get(answered), seen: yield* Ref.get(seen) }
  })

const freeform = (results: ReadonlyArray<ToolResultPart> | undefined, id: string) => {
  const output = results?.[0]?.output
  assert.strictEqual(output?.type, "json")
  const value = output?.type === "json" ? output.value : undefined
  const answers = typeof value === "object" && value !== null && "answers" in value ? value.answers : undefined
  const answer = typeof answers === "object" && answers !== null && id in answers ? Reflect.get(answers, id) : undefined
  return typeof answer === "object" && answer !== null && "freeform" in answer ? String(answer.freeform) : ""
}

describe("a harness turn", () => {
  it.effect("turns AskUserQuestion into Dream questions and continues the turn with where they went", () =>
    Effect.gen(function* () {
      const { asked, answered, finalText, seen } = yield* run(
        [step, text("Let me ask a couple of things."), askUserQuestion],
        [step, text("Meanwhile I'll scaffold the site.")]
      )
      assert.deepStrictEqual(asked, [
        {
          question: "What features matter most for the site?",
          options: ["Tour dates", "Music"],
          why: "Features · more than one can apply"
        },
        { question: "Do you have photos ready?", options: ["Yes", "Not yet"], why: "Content" }
      ])
      assert.strictEqual(answered.length, 1)
      const [result] = answered[0] ?? []
      assert.strictEqual(result?.toolCallId, "call_askUserQuestions")
      assert.strictEqual(result?.toolName, "askUserQuestions")
      assert.include(freeform(answered[0], "question-1"), "sent this question to their phone (msg_1)")
      assert.include(freeform(answered[0], "question-2"), "(msg_2)")
      assert.include(freeform(answered[0], "question-2"), "will arrive later as a new event")
      assert.strictEqual(finalText, "Meanwhile I'll scaffold the site.")
      assert.strictEqual(seen, 5)
    })
  )

  it.effect("tells the model to use `dream ask` when a question couldn't be sent", () =>
    Effect.gen(function* () {
      const { answered } = yield* run([askUserQuestion], [], true)
      assert.include(freeform(answered[0], "question-1"), "not sent: the API is down")
      assert.include(freeform(answered[0], "question-1"), "`dream ask`")
    })
  )

  it.effect("answers a question call it can't read, so the turn doesn't hang", () =>
    Effect.gen(function* () {
      const { asked, answered } = yield* run([toolCall("askUserQuestions", { questions: "?" })])
      assert.deepStrictEqual(asked, [])
      assert.deepStrictEqual(answered[0]?.[0]?.output, { type: "json", value: { action: "answered", answers: {} } })
    })
  )

  it.effect("leaves other tool calls to the harness", () =>
    Effect.gen(function* () {
      const { asked, answered } = yield* run([
        toolCall("bash", { command: "dream message hi" }, true),
        toolCall("askUserQuestions", {}, true)
      ])
      assert.deepStrictEqual(asked, [])
      assert.deepStrictEqual(answered, [])
    })
  )

  it.effect("keeps only the last step's text as the final text", () =>
    Effect.gen(function* () {
      const { finalText } = yield* run([
        step,
        text("Checking the repo."),
        toolCall("bash", { command: "ls" }, true),
        { type: "tool-result", toolCallId: "call_bash", toolName: "bash", input: {}, output: "", dynamic: true },
        step,
        text("What's the priority — "),
        text("fast or polished?")
      ])
      assert.strictEqual(finalText, "What's the priority — fast or polished?")
    })
  )

  it.effect("has no final text when the turn ended on a tool call", () =>
    Effect.gen(function* () {
      const { finalText } = yield* run([
        step,
        text("Sending it."),
        toolCall("bash", { command: "dream message" }, true)
      ])
      assert.strictEqual(finalText, "")
    })
  )
})

describe("final text", () => {
  it("is posted when it says something", () => {
    assert.deepStrictEqual(
      replyFromFinalText("\nIt's live at band.dream.app.\n"),
      Option.some("It's live at band.dream.app.")
    )
    assert.deepStrictEqual(
      replyFromFinalText("Done — the tour page is up."),
      Option.some("Done — the tour page is up.")
    )
  })

  it("is skipped when it's empty or boilerplate", () => {
    for (const text of [
      "",
      "   ",
      "No response requested.",
      "(no content)",
      "Done.",
      "OK",
      "Nothing to add.",
      "Waiting for their answer."
    ]) {
      assert.deepStrictEqual(replyFromFinalText(text), Option.none(), text)
    }
  })
})

describe("Claude Code's built-ins", () => {
  it("are turned off in its settings, keeping the dream skill and what was there", () => {
    const settings = claudeSettings({
      model: "opus",
      permissions: { deny: ["WebFetch", "CronCreate"], allow: ["Bash"] },
      skillOverrides: { "code-review": "name-only" }
    })
    assert.strictEqual(settings.model, "opus")
    assert.deepStrictEqual(settings.permissions, {
      deny: ["WebFetch", ...deniedClaudeTools],
      allow: ["Bash"]
    })
    const overrides = settings.skillOverrides as Record<string, string>
    assert.strictEqual(overrides["code-review"], "name-only")
    for (const skill of ["schedule", "loop", "update-config"]) assert.strictEqual(overrides[skill], "off")
    assert.notInclude(disabledClaudeSkills, "dream")
    assert.notProperty(overrides, "dream")
    for (const tool of ["CronCreate", "RemoteTrigger", "ScheduleWakeup", "ExitPlanMode"]) {
      assert.include(deniedClaudeTools, tool)
    }
    assert.notInclude(deniedClaudeTools, "AskUserQuestion")
  })

  it("starts from nothing when the settings aren't an object", () => {
    assert.deepStrictEqual(Object.keys(claudeSettings("garbage")), ["permissions", "skillOverrides"])
  })

  it.effect("are written to ~/.claude/settings.json when the Claude Code harness starts", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      yield* Effect.scoped(Layer.build(Harness.layer.pipe(Layer.provide(baseLayer(dir)))))
      const written = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"))
      assert.deepStrictEqual(written, claudeSettings(undefined))
    })
  )
})
