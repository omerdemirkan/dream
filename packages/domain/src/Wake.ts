/**
 * Wake-ups the agent schedules with `dream wake --at|--cron`. The ProjectDO
 * keeps them and fires them from alarms.
 */
import { Schema } from "effect"
import { WakeId } from "./Ids.ts"
import { MachineUse } from "./Logs.ts"
import { ReasoningEffort } from "./Project.ts"
import { TurnUsage, UsageSnapshot } from "./Usage.ts"
import { TimeZone } from "./User.ts"

export const WakeWhen = Schema.TaggedUnion({
  At: { at: Schema.DateTimeUtc },
  /** Five-field cron. `timeZone` defaults to theirs, so "0 7 * * *" means 7:00 where they are. */
  Cron: { expression: Schema.NonEmptyString, timeZone: Schema.optionalKey(TimeZone) }
})
export type WakeWhen = typeof WakeWhen.Type

/**
 * A task that runs in a session of its own when the wake fires (`dream wake --task`): a new conversation that
 * starts from `brief`, on `model` at `effort`, with the project's files and the `dream` command, instead of a turn
 * of the project's own session. The agent is only woken if it fails, or if the task wakes it.
 */
export const WakeTask = Schema.Struct({
  /** Everything the task's session is told about the job: it knows nothing else of the project. */
  brief: Schema.NonEmptyString,
  /** As the harness names models: Claude Code's `sonnet`, `haiku`, `opus`; a Codex catalog slug. */
  model: Schema.NonEmptyString,
  effort: ReasoningEffort
})
export type WakeTask = typeof WakeTask.Type

/** How a task's run went. A failed run also reaches the agent, as a `WakeDue` with the result. */
export const TaskOutcome = Schema.Literals(["succeeded", "failed"])
export type TaskOutcome = typeof TaskOutcome.Type

/** Why a task's run failed, for the agent. */
export const TaskFailure = Schema.Struct({
  /** What went wrong, in a sentence: the harness's error, a limit, the time running out. */
  reason: Schema.String,
  /** The end of what the session said last, when it said anything. */
  report: Schema.optionalKey(Schema.String)
})
export type TaskFailure = typeof TaskFailure.Type

/** A task's latest run, as `dream wake list` shows it. */
export const TaskRun = Schema.Struct({
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  outcome: TaskOutcome,
  /** The session's last words (its report), or why it couldn't run, shortened. */
  summary: Schema.optionalKey(Schema.String),
  /** What the run used of the model. */
  usage: Schema.optionalKey(TurnUsage)
})
export type TaskRun = typeof TaskRun.Type

/**
 * What dreamd reports when a task's session finishes (`SandboxRpcs.ReportTask`). `before` and `after` are the
 * subscription's usage as the session first and last saw it, when it reported any.
 */
export const TaskReport = Schema.Struct({
  wakeId: WakeId,
  ...TaskRun.fields,
  before: Schema.optionalKey(UsageSnapshot),
  after: Schema.optionalKey(UsageSnapshot),
  /** What the run asked of the machine. Added November 2026; older builds send none. */
  machine: Schema.optionalKey(MachineUse)
})
export type TaskReport = typeof TaskReport.Type

export const Wake = Schema.Struct({
  id: WakeId,
  when: WakeWhen,
  why: Schema.NonEmptyString,
  /**
   * A shell command dreamd runs when the wake fires. The agent is only woken
   * if it exits non-zero. Without a command the agent is woken directly.
   */
  run: Schema.optionalKey(Schema.NonEmptyString),
  /** A task to run in a fresh session instead (never together with `run`). */
  task: Schema.optionalKey(WakeTask),
  /** The task's latest run. */
  lastRun: Schema.optionalKey(TaskRun),
  /** Absent once a one-off wake has fired. */
  nextAt: Schema.optionalKey(Schema.DateTimeUtc),
  createdAt: Schema.DateTimeUtc
})
export type Wake = typeof Wake.Type
