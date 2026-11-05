/**
 * The session never reaches the person: only `dream` does. Models still talk
 * to them the ways their harness taught them, so dreamd routes those to Dream
 * or turns them off:
 *
 * - Claude Code's `AskUserQuestion` (the harness's `askUserQuestions` tool)
 *   becomes Dream questions, and the model is told they went to the phone.
 * - A turn that ends with something to say, having sent nothing, posts its
 *   final text to Chat (`replyFromFinalText`).
 * - Claude Code's bundled tools and skills that assume claude.ai or someone at
 *   a terminal are turned off in its user settings (`claudeSettings`).
 *
 * Codex has no user-input tool outside plan mode (which Dream never starts),
 * so only the final-text rule applies to it.
 */
import { Option, Schema } from "effect"

// ---------------------------------------------------------------------------
// AskUserQuestion
// ---------------------------------------------------------------------------

/** The harness's name for the question tool, whatever the harness calls it natively. */
export const questionsToolName = "askUserQuestions"

/** The input of the harness's `askUserQuestions` tool (`HarnessV1QuestionsToolInput`), as far as Dream uses it. */
export const QuestionsInput = Schema.Struct({
  questions: Schema.NonEmptyArray(
    Schema.Struct({
      id: Schema.String,
      question: Schema.String,
      header: Schema.optionalKey(Schema.String),
      options: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }))),
      allowMultiple: Schema.optionalKey(Schema.Boolean)
    })
  )
})
export type QuestionsInput = typeof QuestionsInput.Type
export type HarnessQuestion = QuestionsInput["questions"][number]

/** What `dream ask` would send for one of the harness's questions. */
export interface DreamQuestion {
  readonly question: string
  readonly options: ReadonlyArray<string>
  readonly why?: string
}

const nonEmpty = (text: string | undefined) => {
  const trimmed = text?.trim() ?? ""
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none()
}

/** The question text and option labels as they are; the header becomes the line under the question. */
export const toDreamQuestion = (question: HarnessQuestion): Option.Option<DreamQuestion> =>
  Option.map(nonEmpty(question.question), (text) => {
    const options = (question.options ?? []).flatMap((option) => Option.toArray(nonEmpty(option.label)))
    const why = [
      ...Option.toArray(nonEmpty(question.header)),
      ...(question.allowMultiple === true && options.length > 1 ? ["more than one can apply"] : [])
    ].join(" · ")
    return { question: text, options, ...(why.length > 0 ? { why } : {}) }
  })

/** What happened to one question: it's on their phone as message `messageId`, or it couldn't be sent. */
export type QuestionOutcome =
  | { readonly _tag: "Sent"; readonly messageId: string }
  | { readonly _tag: "NotSent"; readonly reason: string }

const outcomeText = (outcome: QuestionOutcome) =>
  outcome._tag === "Sent"
    ? `Not answered yet. Dream sent this question to their phone (${outcome.messageId}); their answer will arrive ` +
      "later as a new event. Don't wait for it: carry on with what doesn't depend on it. Use `dream ask` for " +
      "questions from now on."
    : `Not answered, and not sent: ${outcome.reason}. Ask it with \`dream ask\` instead.`

/**
 * The tool result for the model (`HarnessV1QuestionsToolOutput`). Claude Code
 * passes the answers to `AskUserQuestion` as given, so each question's
 * "answer" is a note saying where it went; a refusal would read as the person
 * declining.
 */
export const questionsToolOutput = (
  input: QuestionsInput,
  outcomes: ReadonlyArray<QuestionOutcome>
): { readonly action: "answered"; readonly answers: Record<string, { optionIds: []; freeform: string }> } => ({
  action: "answered",
  answers: Object.fromEntries(
    input.questions.map((question, index) => [
      question.id,
      {
        optionIds: [],
        freeform: outcomeText(outcomes[index] ?? { _tag: "NotSent", reason: "it had no question text" })
      }
    ])
  )
})

// ---------------------------------------------------------------------------
// Final text
// ---------------------------------------------------------------------------

/** Final words that say nothing to the person. */
const boilerplate = [
  /^\(?no (response|reply|content|output)( (is )?(requested|needed|required))?\)?$/,
  /^(nothing (more |else )?to (do|add|report|say)( (here|now|for now))?)$/,
  /^(done|ok(ay)?|got it|understood|acknowledged|noted)$/,
  /^(waiting|standing by|idle)( for .*)?$/
]

/**
 * The turn's final assistant text as a Chat message, if it says anything. A
 * model that answers or asks in plain text at the end of a turn, and never
 * runs `dream message`, would otherwise leave the person in silence.
 */
export const replyFromFinalText = (text: string): Option.Option<string> => {
  const trimmed = text.trim()
  const plain = trimmed
    .toLowerCase()
    .replace(/[.!…\s]+$/u, "")
    .trim()
  return plain.length === 0 || boilerplate.some((pattern) => pattern.test(plain)) ? Option.none() : Option.some(trimmed)
}

/** The `SandboxRpcs` calls that reach the person: a message, a question, an access request, the Status card, a Live Activity. */
export const reachesPerson: ReadonlySet<string> = new Set([
  "SendMessage",
  "AskQuestion",
  "RequestAccess",
  "UpdateStatus",
  "StartLiveActivity",
  "UpdateLiveActivity",
  "EndLiveActivity"
])

// ---------------------------------------------------------------------------
// Claude Code's built-ins that can't work here
// ---------------------------------------------------------------------------

/**
 * Tools that only work in an interactive Claude Code, or against claude.ai.
 * Session crons (`CronCreate`, the `/loop` tool `ScheduleWakeup`) fire only
 * while a REPL sits open; `RemoteTrigger` is claude.ai routines;
 * `PushNotification` goes to Claude's own apps; plan mode waits for someone to
 * approve the plan; `DesignSync` needs a claude.ai login. A bare tool name in
 * `permissions.deny` also takes the tool out of the model's list.
 */
export const deniedClaudeTools: ReadonlyArray<string> = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  "EnterPlanMode",
  "ExitPlanMode",
  "DesignSync"
]

/**
 * Bundled skills that assume claude.ai or someone at the terminal, or that
 * configure Claude Code itself (hooks and permissions belong to dreamd here).
 * `dream wake` replaces `schedule` and `loop`.
 */
export const disabledClaudeSkills: ReadonlyArray<string> = [
  "schedule",
  "loop",
  "design",
  "design-sync",
  "doctor",
  "update-config",
  "fewer-permission-prompts",
  "keybindings-help",
  "plugin-authoring"
]

const JsonObject = Schema.Record(Schema.String, Schema.Json)
type JsonObject = typeof JsonObject.Type
const asObject = (value: unknown): JsonObject =>
  Schema.decodeUnknownOption(JsonObject)(value).pipe(Option.getOrElse(() => ({})))

/**
 * `~/.claude/settings.json` with Dream's denials and skill overrides added to
 * whatever else is there. Claude Code reads user settings in SDK sessions too.
 */
export const claudeSettings = (existing: unknown): JsonObject => {
  const settings = asObject(existing)
  const permissions = asObject(settings.permissions)
  const deny = Schema.decodeUnknownOption(Schema.Array(Schema.String))(permissions.deny).pipe(
    Option.getOrElse((): ReadonlyArray<string> => [])
  )
  return {
    ...settings,
    permissions: { ...permissions, deny: [...new Set([...deny, ...deniedClaudeTools])] },
    skillOverrides: {
      ...asObject(settings.skillOverrides),
      ...Object.fromEntries(disabledClaudeSkills.map((skill) => [skill, "off"]))
    }
  }
}
