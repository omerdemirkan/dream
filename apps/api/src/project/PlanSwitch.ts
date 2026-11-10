/**
 * Moving a project to another of their plans (`AppRpcs.SwitchPlan`): from Claude to ChatGPT or back, or between
 * any two plans Dream runs, since nothing here knows which.
 *
 * Neither harness can hand its conversation to the other: Codex compacts on OpenAI's side into items only OpenAI
 * can read, and a forced Claude Code compaction would rewrite the very session that has to stay if the move fails.
 * So the move goes in two steps:
 *
 *   1. The handoff. While the old plan can run a turn (it's connected, nothing pauses the project, and the agent has
 *      a conversation to hand over), its agent gets `PlanSwitching` and writes a handoff file, in a turn of its own or
 *      at the end of the one it's in. Everything else that arrives waits for the new agent (`deliverOnce`).
 *   2. The move, once the turn that took it ends, or at the deadline whatever runs: the project's harness, model
 *      choice and scheduled tasks' models move over, the sandbox gets the new plan's credential and a dreamd on the
 *      new harness (`SandboxManager.applyPlan`), which starts a new conversation that opens with what it can read of
 *      the old one (`Session.planHandoff` in dreamd), and the new agent gets `PlanSwitched`: the handoff, its model,
 *      the tasks that changed and the latest of Chat. A pause for the old plan's usage ends with it, and the limits
 *      they set apply to the new plan from there.
 *
 * A failure at any point leaves the project on the plan it was on, in the same conversation, and says so on their
 * phone (`Project.planSwitch`) and to the agent that stays.
 */
import {
  AgentEvent,
  agentChoiceOn,
  agentOf,
  equivalentModel,
  type Harness,
  InvalidRequest,
  type Message,
  NotFound,
  type PlanSwitch,
  type Project,
  ProjectEvent,
  planHandoffPath,
  providerOf,
  type WakeId
} from "@dream/domain"
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Semaphore } from "effect"
import { Connections } from "../db/Connections.ts"
import { newEventId } from "../lib/Ids.ts"
import { UsageReport } from "../usage/ProjectUsage.ts"
import { Alarm } from "./Alarm.ts"
import { Core } from "./Core.ts"
import { LiveFeed } from "./Live.ts"
import { Notifier } from "./Notifier.ts"
import { ProjectLog } from "./ProjectLog.ts"
import { SandboxManager } from "./SandboxManager.ts"
import { type SandboxRecord, Singletons, Store } from "./Store.ts"
import { UsageLimiter } from "./UsageLimits.ts"

/**
 * How long the handoff may take before the move goes anyway, stopping whatever runs. A handoff turn takes a few
 * minutes; a turn already under way when they asked is told to wrap up, and background work may keep it longer.
 */
export const HandoffDeadline = Duration.minutes(20)

/** How much of Chat the new agent is shown: the latest messages, each cut short. */
export const ChatShown = { messages: 12, chars: 600 }

const planName = (harness: Harness) => (providerOf(harness) === "chatgpt" ? "ChatGPT" : "Claude")

const clip = (text: string, chars: number) => (text.length <= chars ? text : `${text.slice(0, chars).trimEnd()} […]`)

/** Chat as they saw it, oldest first: what was said, and the questions asked. */
export const chatLines = (newestFirst: ReadonlyArray<Message>) =>
  newestFirst
    .flatMap((message) =>
      message._tag === "Text" && message.text.trim() !== ""
        ? [{ from: message.from, text: clip(message.text.trim(), ChatShown.chars), at: message.createdAt }]
        : message._tag === "Question"
          ? [
              {
                from: "agent" as const,
                text: clip(`(a question) ${message.question}`, ChatShown.chars),
                at: message.createdAt
              }
            ]
          : []
    )
    .slice(0, ChatShown.messages)
    .reverse()

export class PlanSwitcher extends Context.Service<
  PlanSwitcher,
  {
    /** `SwitchPlan`: ask for the move (the Worker checked `to` is connected), or cancel it with the plan it's on. */
    readonly request: (to: Harness) => Effect.Effect<Project, NotFound | InvalidRequest>
    /** The `plan-switch` timer: move now if the handoff is in (or its time is up), else wait for it. */
    readonly run: Effect.Effect<void>
  }
>()("@dream/api/project/PlanSwitcher") {
  static readonly layer = Layer.effect(
    PlanSwitcher,
    Effect.gen(function* () {
      const core = yield* Core
      const store = yield* Store
      const alarm = yield* Alarm
      const sandbox = yield* SandboxManager
      const connections = yield* Connections
      const limiter = yield* UsageLimiter
      const notifier = yield* Notifier
      const live = yield* LiveFeed
      const usageReport = yield* UsageReport
      const projectLog = yield* ProjectLog
      const lock = yield* Semaphore.make(1)

      const archived = Effect.map(store.getSingleton(...Singletons.archived), Option.isSome)
      const setRecord = (f: (record: SandboxRecord) => SandboxRecord) =>
        Effect.flatMap(core.sandbox, (record) => core.saveSandbox(f(record)))
      const clearRecord = setRecord(({ planSwitch: _, ...rest }) => rest)
      const deliverNow = Effect.gen(function* () {
        yield* store.setTimer("deliver", yield* Clock.currentTimeMillis)
        yield* alarm.reschedule
      })
      const connected = (project: Project, harness: Harness) =>
        Effect.map(connections.connectedModel(project.ownerId, providerOf(harness)), Option.isSome)

      const event = (fields: Omit<typeof AgentEvent.cases.PlanSwitched.Type, "_tag" | "id" | "at">) =>
        Effect.gen(function* () {
          return AgentEvent.cases.PlanSwitched.make({ id: yield* newEventId(), at: yield* DateTime.now, ...fields })
        })

      /**
       * The agent that stays hears how it ended, if it was asked for a handoff; one not delivered yet is taken back.
       * Either way, what waited is delivered.
       */
      const release = (
        waiting: NonNullable<SandboxRecord["planSwitch"]>,
        from: Harness,
        outcome: { readonly outcome: "failed" | "cancelled"; readonly reason?: string }
      ) =>
        Effect.gen(function* () {
          const asked = waiting.handoffEventId
          if (asked !== undefined && !(yield* store.discardPending(asked))) {
            yield* core.enqueue(yield* event({ from, to: waiting.to, ...outcome }))
          }
          yield* deliverNow
        })

      const request = (to: Harness) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const project = yield* core.project
            if (yield* archived) return yield* new InvalidRequest({ message: "The project is archived." })
            const record = yield* core.sandbox
            const waiting = record.planSwitch
            if (to === project.harness) {
              if (waiting === undefined) return project
              // They changed their mind: it stays, as if they'd never asked.
              yield* clearRecord
              yield* store.clearTimer("plan-switch")
              const { planSwitch: _, ...next } = project
              yield* core.saveProject(next)
              yield* release(waiting, project.harness, { outcome: "cancelled" })
              yield* projectLog.note("dream", "info", `They decided to keep the project on their ${planName(to)} plan`)
              return next
            }
            if (waiting?.to === to) return project
            if (!(yield* connected(project, to))) {
              return yield* new InvalidRequest({ message: `Connect your ${planName(to)} plan first.` })
            }
            const now = yield* DateTime.now
            // A handoff takes a turn on the old plan: only when it can run one, and there's a conversation to hand over.
            const pause = yield* core.usagePause
            const paused = Option.isSome(pause) && DateTime.isGreaterThan(pause.value.until, now)
            const canHandOff =
              record.status === "ready" &&
              record.startedWork === true &&
              !paused &&
              (yield* connected(project, project.harness))
            const handoff = canHandOff ? planHandoffPath(now, to) : undefined
            const handoffEventId = handoff === undefined ? undefined : yield* newEventId()
            const deadline = DateTime.addDuration(now, HandoffDeadline)
            if (waiting?.handoffEventId !== undefined) yield* store.discardPending(waiting.handoffEventId)
            yield* setRecord((r) => ({
              ...r,
              planSwitch: {
                to,
                requestedAt: now,
                deadline,
                ...(handoffEventId === undefined || handoff === undefined ? {} : { handoffEventId, handoff })
              }
            }))
            if (handoffEventId !== undefined && handoff !== undefined) {
              yield* core.enqueue(
                AgentEvent.cases.PlanSwitching.make({ id: handoffEventId, at: now, from: project.harness, to, handoff })
              )
            }
            yield* store.setTimer(
              "plan-switch",
              handoff === undefined ? yield* Clock.currentTimeMillis : DateTime.toEpochMillis(deadline)
            )
            yield* alarm.reschedule
            const next: Project = {
              ...project,
              planSwitch: { from: providerOf(project.harness), to: providerOf(to), state: "waiting", requestedAt: now }
            }
            yield* core.saveProject(next)
            yield* projectLog.note(
              "dream",
              "info",
              `They asked to move the project to their ${planName(to)} plan` +
                (handoff === undefined ? "; it moves without a handoff turn" : `; the agent writes a handoff first`)
            )
            return next
          })
        )

      /** It couldn't move: it stays on its plan, and their phone and the agent hear why. */
      const failed = (project: Project, waiting: NonNullable<SandboxRecord["planSwitch"]>, reason: string) =>
        Effect.gen(function* () {
          yield* clearRecord
          const planSwitch: PlanSwitch = {
            from: providerOf(project.harness),
            to: providerOf(waiting.to),
            state: "failed",
            requestedAt: waiting.requestedAt,
            endedAt: yield* DateTime.now,
            reason
          }
          yield* core.saveProject({ ...project, planSwitch })
          yield* release(waiting, project.harness, { outcome: "failed", reason })
          yield* projectLog.note(
            "dream",
            "error",
            `Dream couldn't move the project to their ${planName(waiting.to)} plan (${reason})`
          )
        })

      /** Tasks that named one of the old plan's models get its counterpart on the new one. */
      const moveTasks = (from: Harness, to: Harness) =>
        Effect.gen(function* () {
          const moved: Array<{ wakeId: WakeId; why: string; from: string; to: string }> = []
          for (const wake of yield* store.wakes) {
            if (wake.task === undefined) continue
            const model = equivalentModel(from, to, wake.task.model)
            if (model === wake.task.model) continue
            const nextAt = wake.nextAt === undefined ? undefined : DateTime.toEpochMillis(wake.nextAt)
            yield* store.putWake({ ...wake, task: { ...wake.task, model } }, nextAt)
            moved.push({ wakeId: wake.id, why: wake.why, from: wake.task.model, to: model })
          }
          if (moved.length > 0) yield* core.wakesChanged
          return moved
        })

      /** A pause for the old plan's usage: over, since that plan no longer runs the project. */
      const endPause = Effect.gen(function* () {
        const pause = yield* core.usagePause
        if (Option.isNone(pause)) return
        yield* core.saveUsagePause(Option.none())
        yield* store.clearTimer("usage-reset")
        if (pause.value.notificationId !== undefined) yield* notifier.withdraw([pause.value.notificationId])
      })

      const move = (project: Project, waiting: NonNullable<SandboxRecord["planSwitch"]>) =>
        Effect.gen(function* () {
          const from = project.harness
          const to = waiting.to
          if (!(yield* connected(project, to))) {
            return yield* failed(project, waiting, `their ${planName(to)} plan isn't connected`)
          }
          const { planSwitch: _, agentModel: _m, agentEffort: _e, ...rest } = project
          const now = yield* DateTime.now
          const next: Project = {
            ...rest,
            ...agentChoiceOn(project, to),
            harness: to,
            planSwitch: {
              from: providerOf(from),
              to: providerOf(to),
              state: "done",
              requestedAt: waiting.requestedAt,
              endedAt: now
            }
          }
          const applied = yield* sandbox.applyPlan(next, waiting.handoff).pipe(Effect.result)
          if (applied._tag === "Failure") {
            yield* Effect.logError("couldn't move the project to another plan", { to, error: applied.failure.message })
            return yield* failed(project, waiting, applied.failure.message)
          }
          yield* clearRecord
          yield* core.saveProject(next)
          yield* endPause
          const tasks = yield* moveTasks(from, to)
          const recent = yield* store.messagesBefore(undefined, ChatShown.messages * 2)
          yield* core.enqueue(
            yield* event({
              from,
              to,
              outcome: "moved",
              ...(applied.success.handoff && waiting.handoff !== undefined ? { handoff: waiting.handoff } : {}),
              model: agentOf(next).model,
              ...(project.agentModel === undefined ? {} : { modelBefore: project.agentModel }),
              ...(tasks.length === 0 ? {} : { tasks }),
              chat: chatLines(recent.messages)
            })
          )
          const seconds = Math.round(DateTime.distance(waiting.requestedAt, now).pipe(Duration.toSeconds))
          yield* Effect.logInfo("moved the project to another plan", { from, to, seconds })
          yield* projectLog.note(
            "dream",
            "info",
            `Dream moved the project from their ${planName(from)} plan to their ${planName(to)} plan, ` +
              (applied.success.handoff ? "with a handoff from the agent" : "without a handoff from the agent") +
              (tasks.length === 0 ? "" : `; ${tasks.length} tasks' models moved too`)
          )
          yield* live.publish(ProjectEvent.cases.Usage.make({ usage: yield* usageReport.glance(next) }))
          yield* limiter.check
        })

      const run = lock
        .withPermits(1)(
          Effect.gen(function* () {
            yield* store.clearTimer("plan-switch")
            const record = yield* core.sandbox
            const waiting = record.planSwitch
            if (waiting === undefined || (yield* archived)) return
            const project = yield* core.project.pipe(Effect.orDie)
            if (project.harness === waiting.to) return yield* clearRecord
            const now = yield* DateTime.now
            const late = !DateTime.isLessThan(now, waiting.deadline)
            const handoffDue = waiting.handoffEventId !== undefined && waiting.handedOff !== true
            if (!late && (handoffDue || record.working)) {
              // The end of the turn sets the timer again; the deadline is the backstop.
              yield* store.setTimer("plan-switch", DateTime.toEpochMillis(waiting.deadline))
              return yield* alarm.reschedule
            }
            yield* move(project, waiting)
          })
        )
        .pipe(
          Effect.catchCause((cause) => Effect.logError("the move to another plan failed unexpectedly", { cause })),
          Effect.withSpan("PlanSwitcher.run")
        )

      return PlanSwitcher.of({ request, run })
    })
  )
}
