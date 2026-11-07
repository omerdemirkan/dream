/**
 * Background work in a turn: what the agent left running (background subagents, commands and Monitors on Claude
 * Code, child agents on Codex), how long Dream lets it hold a turn, and what to tell the agent when it was stopped.
 *
 * Both bridges keep a turn going after the model's reply while its background work runs, so its reports reach the
 * model (`bridges/claude-code/background.mjs`, the Codex patch in `Bridges.ts`), and say so in `raw` parts
 * (`dream_background`): the live tasks, and whether the turn is held for them. The sandbox stays up and the phone
 * shows the agent working for as long as that lasts, so Dream bounds it. A held turn is stopped when nothing has come
 * from its background work for `limits.quiet` (a server started in the background, a stuck command), or once it has
 * been held for `limits.long` in all. Whatever was still live when a turn ended, for that or any other reason, is
 * reported to the agent in a `BackgroundStopped` event, so it can start it again.
 *
 * The live set is also kept on disk while a turn runs (`Saved`), so a dreamd that restarted mid-turn can say what
 * stopped with it; and once, for sessions from before turns waited, the Claude Code transcript shows what the last
 * turn left running that never reported back (`strandedInTranscript`).
 */
import { AgentEvent } from "@dream/domain"
import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Ref, Schema } from "effect"

export type Kind = "subagent" | "command" | "monitor" | "other"

export interface Task {
  readonly id: string
  readonly kind: Kind
  readonly description: string
}

export type StopReason = Extract<AgentEvent, { readonly _tag: "BackgroundStopped" }>["reason"]

export const limits = {
  /** Nothing from the background work while the turn waits on it. Past a Monitor's own 30-minute deadline. */
  quiet: Duration.minutes(45),
  /** The time one turn may wait on background work in all. */
  long: Duration.hours(3)
}

/** What the bridges' task types are, for the agent. */
export const kindOf = (taskType: string | undefined): Kind =>
  taskType === "local_agent" || taskType === "remote_agent" || taskType === "subagent"
    ? "subagent"
    : taskType === "local_bash" || taskType === "shell"
      ? "command"
      : taskType === "monitor" || taskType === "local_monitor" || taskType === "mcp_monitor"
        ? "monitor"
        : "other"

export interface State {
  readonly live: ReadonlyArray<Task>
  /** Since when the turn is held for background work (epoch ms), while it is. */
  readonly holdingSince?: number
  /** How long earlier holds in this turn lasted. */
  readonly heldMs: number
  /** The last sign of the background work doing something (epoch ms). */
  readonly activityAt?: number
}

export const initial: State = { live: [], heldMs: 0 }

const ReportTask = Schema.Struct({
  id: Schema.String,
  type: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String)
})
/** The bridges' `dream_background` report. `activity`: a Codex child did something. */
const Report = Schema.Struct({
  type: Schema.Literal("dream_background"),
  holding: Schema.Boolean,
  live: Schema.Array(ReportTask),
  activity: Schema.optional(Schema.Boolean)
})
const decodeReport = Schema.decodeUnknownOption(Report)

/** Claude Code's messages that show background work doing something. */
const activitySubtypes = new Set(["task_started", "task_progress", "task_updated", "task_notification"])

const isActivity = (raw: unknown): boolean => {
  if (typeof raw !== "object" || raw === null) return false
  const message = raw as { readonly type?: unknown; readonly subtype?: unknown; readonly parent_tool_use_id?: unknown }
  if (message.type === "system" && typeof message.subtype === "string") return activitySubtypes.has(message.subtype)
  // A subagent's own messages carry the tool call that started it.
  return typeof message.parent_tool_use_id === "string"
}

/** Take in a part of the turn's stream; only `raw` parts matter. */
export const observe = (state: State, part: { readonly type: string; readonly rawValue?: unknown }, now: number) => {
  if (part.type !== "raw") return state
  const report = decodeReport(part.rawValue)
  if (Option.isNone(report)) return isActivity(part.rawValue) ? { ...state, activityAt: now } : state
  const { holding, live, activity } = report.value
  const tasks = live.map(
    (task): Task => ({ id: task.id, kind: kindOf(task.type), description: task.description?.trim() || task.id })
  )
  const next: State = { ...state, live: tasks, ...(activity === true ? { activityAt: now } : {}) }
  if (holding && state.holdingSince === undefined) return { ...next, holdingSince: now }
  if (!holding && state.holdingSince !== undefined) {
    const { holdingSince: _, ...rest } = next
    return { ...rest, heldMs: state.heldMs + (now - state.holdingSince), activityAt: now }
  }
  return next
}

/** Whether a held turn has gone past a limit, and which. */
export const overLimit = (
  state: State,
  now: number,
  bounds: typeof limits = limits
): Option.Option<{ readonly reason: "quiet" | "long"; readonly minutes: number }> => {
  if (state.holdingSince === undefined || state.live.length === 0) return Option.none()
  const held = state.heldMs + (now - state.holdingSince)
  if (held >= Duration.toMillis(bounds.long)) {
    return Option.some({ reason: "long", minutes: Math.round(held / 60_000) })
  }
  const quietFor = now - Math.max(state.holdingSince, state.activityAt ?? 0)
  if (quietFor >= Duration.toMillis(bounds.quiet)) {
    return Option.some({ reason: "quiet", minutes: Math.round(quietFor / 60_000) })
  }
  return Option.none()
}

/** What stopped, for the agent. */
export interface Stopped {
  readonly reason: StopReason
  readonly tasks: ReadonlyArray<Task>
  readonly minutes?: number
}

export const toEvent = (
  stopped: Stopped,
  fields: { readonly id: AgentEvent["id"]; readonly at: AgentEvent["at"] }
): AgentEvent =>
  AgentEvent.cases.BackgroundStopped.make({
    ...fields,
    reason: stopped.reason,
    tasks: stopped.tasks.map(({ kind, description }) => ({ kind, description })),
    ...(stopped.minutes === undefined ? {} : { minutes: stopped.minutes })
  })

/** How often a held turn is checked against the limits. */
export const checkEvery = Duration.seconds(30)

/**
 * Run a turn (`run`, which reports each part of its stream to the `observe` it's given), keeping track of its
 * background work, and stop it (`stop`, which should end `run` soon) once a held turn passes a limit. `persist` is
 * told the live set whenever it changes, and once more, empty, when the turn is over. Returns how `run` ended and
 * what background work stopped with the turn: everything still live at its end, for the limit's reason if Dream
 * stopped it, else `ended`.
 */
export const supervise = Effect.fnUntraced(function* <A, E, R>(options: {
  readonly run: (
    observe: (part: { readonly type: string; readonly rawValue?: unknown }) => Effect.Effect<void>
  ) => Effect.Effect<A, E, R>
  readonly stop: (reason: { readonly reason: "quiet" | "long"; readonly minutes: number }) => Effect.Effect<void>
  readonly persist?: (live: ReadonlyArray<Task>) => Effect.Effect<void>
  readonly bounds?: typeof limits
}) {
  const state = yield* Ref.make(initial)
  const limited = yield* Ref.make(Option.none<{ readonly reason: "quiet" | "long"; readonly minutes: number }>())
  const persist = options.persist ?? (() => Effect.void)
  const observeOne = (part: { readonly type: string; readonly rawValue?: unknown }) =>
    Effect.gen(function* () {
      if (part.type !== "raw") return
      const now = yield* Clock.currentTimeMillis
      const [before, after] = yield* Ref.modify(state, (previous) => {
        const next = observe(previous, part, now)
        return [[previous, next] as const, next]
      })
      if (before.live !== after.live && !sameTasks(before.live, after.live)) yield* persist(after.live)
    })
  const check = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(checkEvery)
      const over = overLimit(yield* Ref.get(state), yield* Clock.currentTimeMillis, options.bounds)
      if (Option.isSome(over)) {
        yield* Ref.set(limited, over)
        yield* Effect.logWarning("Background work held the turn past Dream's limit; stopping the turn", {
          reason: over.value.reason,
          minutes: over.value.minutes,
          live: (yield* Ref.get(state)).live.map((task) => `${task.kind}: ${task.description}`)
        })
        yield* options.stop(over.value)
        return
      }
    }
  })
  const checker = yield* Effect.forkChild(check)
  const exit = yield* Effect.exit(options.run(observeOne))
  yield* Fiber.interrupt(checker)
  const { live } = yield* Ref.get(state)
  // dreamd is stopping: what's live stays on disk, for the agent to hear of after the restart.
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
    return { exit, stopped: Option.none<Stopped>(), limited: false }
  }
  if (live.length > 0) yield* persist([])
  const limit = yield* Ref.get(limited)
  const stopped: Option.Option<Stopped> =
    live.length === 0
      ? Option.none()
      : Option.some(
          Option.match(limit, {
            onNone: (): Stopped => ({ reason: "ended", tasks: live }),
            onSome: ({ reason, minutes }): Stopped => ({ reason, tasks: live, minutes })
          })
        )
  return { exit, stopped, limited: Option.isSome(limit) }
})

const sameTasks = (a: ReadonlyArray<Task>, b: ReadonlyArray<Task>) =>
  a.length === b.length && a.every((task, index) => task.id === b[index]?.id)

// ---------------------------------------------------------------------------
// On disk
// ---------------------------------------------------------------------------

export const SavedTask = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["subagent", "command", "monitor", "other"]),
  description: Schema.String
})

/**
 * `background.json` in dreamd's state: the live background work of the running turn (empty between turns), and
 * whether the session was looked over for work an earlier turn left (`checkedSession`).
 */
export const Saved = Schema.Struct({
  live: Schema.Array(SavedTask),
  checkedSession: Schema.Boolean
})
export type Saved = typeof Saved.Type

// ---------------------------------------------------------------------------
// Before turns waited: the Claude Code transcript
// ---------------------------------------------------------------------------

const Line = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    isSidechain: Schema.optional(Schema.Boolean),
    origin: Schema.optional(Schema.Unknown),
    toolUseResult: Schema.optional(Schema.Unknown),
    message: Schema.optional(Schema.Struct({ content: Schema.optional(Schema.Unknown) }))
  })
)
const decodeLine = Schema.decodeUnknownOption(Line)

type Block = { readonly type?: unknown; readonly text?: unknown; readonly id?: unknown; readonly name?: unknown }

const blocksOf = (content: unknown): ReadonlyArray<Block> =>
  typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content.filter((block): block is Block => typeof block === "object" && block !== null)
      : []

const textOf = (content: unknown) =>
  blocksOf(content)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("\n")

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const stringOf = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined)

/**
 * Background work the session's last turn started and never heard back from: launches after the last turn's prompt
 * (Dream's turn prompts hold "What woke you") whose task never sent a `<task-notification>`. Claude Code's main
 * transcript (`~/.claude/projects/<project>/<session>.jsonl`) records each launch's result (`toolUseResult`: an
 * async agent's `agentId`, a background command's `backgroundTaskId`, a Monitor's `taskId`) and each notification.
 */
export const strandedInTranscript = (text: string): ReadonlyArray<Task> => {
  const entries = text
    .split("\n")
    .flatMap((line) => (line.trim() === "" ? [] : Option.toArray(decodeLine(line))))
    .filter((entry) => entry.isSidechain !== true)
  const start = entries.findLastIndex(
    (entry) =>
      entry.type === "user" &&
      entry.origin === undefined &&
      entry.toolUseResult === undefined &&
      textOf(entry.message?.content).includes("What woke you")
  )
  if (start === -1) return []
  const calls = new Map<string, { readonly name: string; readonly input: Readonly<Record<string, unknown>> }>()
  const launched = new Map<string, Task>()
  const reported = new Set<string>()
  for (const entry of entries.slice(start)) {
    const content = entry.message?.content
    if (entry.type === "assistant") {
      for (const block of blocksOf(content)) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          calls.set(block.id, { name: String(block.name), input: record((block as { input?: unknown }).input) })
        }
      }
      continue
    }
    if (entry.type !== "user") continue
    for (const match of textOf(content).matchAll(/<task-id>([^<]+)<\/task-id>/g)) reported.add(match[1]!.trim())
    if (entry.toolUseResult === undefined) continue
    const result = record(entry.toolUseResult)
    const callId = blocksOf(content)
      .map((block) => (block as { tool_use_id?: unknown }).tool_use_id)
      .find((id): id is string => typeof id === "string")
    const call = callId === undefined ? undefined : calls.get(callId)
    const described = stringOf(call?.input.description) ?? stringOf(call?.input.command)
    if (result.status === "async_launched" && typeof result.agentId === "string") {
      launched.set(result.agentId, {
        id: result.agentId,
        kind: "subagent",
        description: stringOf(result.description) ?? described ?? "a subagent"
      })
    } else if (typeof result.backgroundTaskId === "string") {
      launched.set(result.backgroundTaskId, {
        id: result.backgroundTaskId,
        kind: "command",
        description: described ?? "a command"
      })
    } else if (call?.name === "Monitor" && typeof result.taskId === "string") {
      launched.set(result.taskId, { id: result.taskId, kind: "monitor", description: described ?? "a Monitor" })
    }
  }
  return [...launched.values()].filter((task) => !reported.has(task.id))
}
