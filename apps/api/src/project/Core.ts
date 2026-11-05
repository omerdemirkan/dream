/**
 * A project's own state, as the ProjectDO keeps it: the project record, the
 * Status card, chat, and the agent's inbox. Every change is stored, published
 * to subscribed phones, and (when it affects Home) projected into D1.
 */
import {
  type AgentEvent,
  AskMessage,
  isOpenAsk,
  type Message,
  NotFound,
  type Project,
  ProjectEvent,
  type StatusCard
} from "@dream/domain"
import { Clock, Context, DateTime, Effect, Layer, Option, Semaphore } from "effect"
import { Projects } from "../db/Projects.ts"
import { Alarm } from "./Alarm.ts"
import { LiveFeed } from "./Live.ts"
import { emptySandbox, type SandboxRecord, Singletons, Store, type UsagePause } from "./Store.ts"

/** Messages in a snapshot; earlier ones come from ListMessages. */
export const SnapshotMessages = 50

export const initialStatus = (now: DateTime.Utc): StatusCard => ({
  phase: "new",
  phaseSince: now,
  media: [],
  milestones: [],
  updatedAt: now
})

export class Core extends Context.Service<
  Core,
  {
    readonly project: Effect.Effect<Project, NotFound>
    readonly projectOption: Effect.Effect<Option.Option<Project>>
    readonly status: Effect.Effect<StatusCard>
    readonly sandbox: Effect.Effect<SandboxRecord>
    readonly usagePause: Effect.Effect<Option.Option<UsagePause>>

    readonly saveProject: (project: Project) => Effect.Effect<void>
    readonly saveStatus: (status: StatusCard) => Effect.Effect<void>
    readonly saveSandbox: (record: SandboxRecord) => Effect.Effect<void>
    readonly saveUsagePause: (pause: Option.Option<UsagePause>) => Effect.Effect<void>

    readonly message: (id: Message["id"]) => Effect.Effect<Option.Option<Message>>
    readonly addMessage: (message: Message) => Effect.Effect<void>
    readonly changeMessage: (message: Message) => Effect.Effect<void>
    readonly openAsks: Effect.Effect<ReadonlyArray<AskMessage>>

    /** Adds an event to the inbox and arranges delivery. */
    readonly enqueue: (event: AgentEvent) => Effect.Effect<void>
    readonly snapshot: Effect.Effect<ProjectEvent>
    /** Rewrites this project's rows in D1 (projects, open_asks). */
    readonly project_: Effect.Effect<void>
  }
>()("@dream/api/project/Core") {
  static readonly layer = Layer.effect(
    Core,
    Effect.gen(function* () {
      const store = yield* Store
      const live = yield* LiveFeed
      const projects = yield* Projects
      const alarm = yield* Alarm
      const projectionLock = yield* Semaphore.make(1)

      const projectOption = store.getSingleton(...Singletons.project)
      const project = Effect.flatMap(projectOption, (found) =>
        Option.match(found, {
          onNone: () => Effect.fail(new NotFound({ entity: "project", id: "this" })),
          onSome: Effect.succeed
        })
      )
      const status = Effect.flatMap(store.getSingleton(...Singletons.status), (found) =>
        Option.match(found, { onNone: () => Effect.map(DateTime.now, initialStatus), onSome: Effect.succeed })
      )
      const sandbox = Effect.map(
        store.getSingleton(...Singletons.sandbox),
        Option.getOrElse(() => emptySandbox)
      )
      const usagePause = store.getSingleton(...Singletons.usagePause)

      const openAsks = Effect.map(store.openAsks, (messages) => messages.filter(isOpenAsk))

      const reproject = projectionLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* projectOption
          if (Option.isNone(current)) return
          const card = yield* status
          const record = yield* sandbox
          const pause = yield* usagePause
          const done = card.milestones.filter((m) => m.state === "done").length
          yield* projects.project({
            project: current.value,
            sandboxId: record.access?.sandboxId,
            progress: card.milestones.length === 0 ? undefined : { done, total: card.milestones.length },
            pausedUntil: Option.isSome(pause) ? pause.value.until : undefined,
            openAsks: yield* openAsks
          })
        })
      )

      const saveProject = (next: Project) =>
        Effect.gen(function* () {
          yield* store.putSingleton(...Singletons.project, next)
          yield* live.publish(ProjectEvent.cases.ProjectChanged.make({ project: next }))
          yield* reproject
        })

      const saveStatus = (next: StatusCard) =>
        Effect.gen(function* () {
          yield* store.putSingleton(...Singletons.status, next)
          yield* live.publish(ProjectEvent.cases.StatusChanged.make({ status: next }))
          yield* reproject
        })

      const saveSandbox = (next: SandboxRecord) =>
        Effect.gen(function* () {
          const previous = yield* sandbox
          yield* store.putSingleton(...Singletons.sandbox, next)
          if (previous.working !== next.working) {
            yield* live.publish(ProjectEvent.cases.WorkingChanged.make({ working: next.working }))
          }
          if (previous.access?.sandboxId !== next.access?.sandboxId) yield* reproject
        })

      const saveUsagePause = (pause: Option.Option<UsagePause>) =>
        Effect.gen(function* () {
          if (Option.isSome(pause)) yield* store.putSingleton(...Singletons.usagePause, pause.value)
          else yield* store.clearSingleton(Singletons.usagePause[0])
          const card = yield* status
          const { pausedUntil: _, ...rest } = card
          const next: StatusCard = Option.isSome(pause) ? { ...rest, pausedUntil: pause.value.until } : rest
          yield* store.putSingleton(...Singletons.status, next)
          yield* live.publish(ProjectEvent.cases.StatusChanged.make({ status: next }))
          yield* reproject
        })

      const addMessage = (message: Message) =>
        Effect.gen(function* () {
          yield* store.insertMessage(message)
          yield* live.publish(ProjectEvent.cases.MessageAdded.make({ message }))
          if (message._tag !== "Text") yield* reproject
        })

      const changeMessage = (message: Message) =>
        Effect.gen(function* () {
          yield* store.updateMessage(message)
          yield* live.publish(ProjectEvent.cases.MessageChanged.make({ message }))
          if (message._tag !== "Text") yield* reproject
        })

      const enqueue = (event: AgentEvent) =>
        Effect.gen(function* () {
          yield* store.enqueue(event)
          yield* store.setTimer("deliver", yield* Clock.currentTimeMillis)
          yield* alarm.reschedule
        })

      const snapshot = Effect.gen(function* () {
        const current = yield* project.pipe(Effect.orDie)
        const recent = yield* store.messagesBefore(undefined, SnapshotMessages)
        return ProjectEvent.cases.Snapshot.make({
          project: current,
          status: yield* status,
          messages: [...recent.messages].reverse(),
          hasEarlierMessages: recent.hasEarlier,
          working: (yield* sandbox).working
        })
      })

      return Core.of({
        project,
        projectOption,
        status,
        sandbox,
        usagePause,
        saveProject,
        saveStatus,
        saveSandbox,
        saveUsagePause,
        message: store.message,
        addMessage,
        changeMessage,
        openAsks,
        enqueue,
        snapshot,
        project_: reproject
      })
    })
  )
}
