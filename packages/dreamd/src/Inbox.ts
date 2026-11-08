/**
 * The agent's inbox: events the ProjectDO delivered that no turn has finished
 * with yet. It's on disk before `Deliver` replies, so the DO can treat the ids
 * it gets back as delivered; a crash, restart or pause loses nothing.
 *
 * An entry is `queued` until a turn takes it, `turn` while that turn runs, and
 * gone once the turn ends. A `WakeDue` with a `--run` command or a `--task`
 * starts as `command`: dreamd runs it, drops the event if it succeeds, and
 * queues it with the result if it fails. After a restart, events a turn had taken are
 * queued again, so an interrupted turn's events reach the next one.
 */
import { AgentEvent, EventId, type TaskFailure, TimeZone } from "@dream/domain"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream, SubscriptionRef } from "effect"
import { DreamdConfig } from "./Config.ts"
import * as JsonFile from "./JsonFile.ts"

const EntryState = Schema.Literals(["queued", "command", "turn"])

const Entry = Schema.Struct({
  event: AgentEvent,
  state: EntryState,
  /** How many turns have taken this event; a turn that keeps failing on it eventually drops it. */
  attempts: Schema.Int
})
type Entry = typeof Entry.Type

export const InboxState = Schema.Struct({
  entries: Schema.Array(Entry),
  /** Recently accepted ids, so redeliveries are ignored. */
  seen: Schema.Array(EventId),
  /** Their time zone, as last given with a delivery. */
  timeZone: Schema.optionalKey(TimeZone)
})
export type InboxState = typeof InboxState.Type

const empty: InboxState = { entries: [], seen: [] }
const seenLimit = 2000
/** Turns that may take an event before it's dropped as the likely cause of their failure. */
export const maxAttempts = 6

export type WakeDueEvent = Extract<AgentEvent, { readonly _tag: "WakeDue" }>
export type RunResult = NonNullable<NonNullable<WakeDueEvent["run"]>["result"]>

const needsCommand = (event: AgentEvent): event is WakeDueEvent =>
  event._tag === "WakeDue" &&
  ((event.run !== undefined && event.run.result === undefined) ||
    (event.run === undefined && event.task !== undefined && event.task.result === undefined))

export class Inbox extends Context.Service<
  Inbox,
  {
    /** Persist new events and return every id the DO may mark delivered (duplicates included). */
    readonly deliver: (
      events: ReadonlyArray<AgentEvent>,
      timeZone?: string
    ) => Effect.Effect<ReadonlyArray<EventId>, JsonFile.StateFileError>
    /** Mark every queued event as taken by a turn and return them. */
    readonly take: Effect.Effect<ReadonlyArray<AgentEvent>, JsonFile.StateFileError>
    /**
     * The turn that took these is done with them: drop them (`done`), queue
     * them for another try after a failure (`retry`), or put them back as if
     * never taken (`untake`, when they couldn't be handed to the turn).
     */
    readonly release: (
      ids: ReadonlyArray<EventId>,
      outcome: "done" | "retry" | "untake"
    ) => Effect.Effect<void, JsonFile.StateFileError>
    /** Scheduled `--run` commands still to run. */
    readonly commands: Effect.Effect<ReadonlyArray<WakeDueEvent>>
    /**
     * A command finished: success drops the wake, failure queues it with the result for the agent, unless `wake`
     * says not to (it failed the same way a moment ago, and the agent heard then).
     */
    readonly commandFinished: (
      id: EventId,
      result: RunResult,
      wake?: boolean
    ) => Effect.Effect<void, JsonFile.StateFileError>
    /** A task's session finished: success (no failure) drops the wake, failure queues it with why for the agent. */
    readonly taskFinished: (
      id: EventId,
      failure: TaskFailure | undefined
    ) => Effect.Effect<void, JsonFile.StateFileError>
    readonly state: Effect.Effect<InboxState>
    /** The state now and after every change. */
    readonly changes: Stream.Stream<InboxState>
  }
>()("@dream/dreamd/Inbox") {
  static readonly layer = Layer.effect(
    Inbox,
    Effect.gen(function* () {
      const config = yield* DreamdConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = JsonFile.make(InboxState, path.join(config.stateDir, "inbox.json"))
      const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        effect.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))

      const loaded = Option.getOrElse(yield* provide(file.read), () => empty)
      const recovered = recover(loaded)
      if (recovered.requeued > 0 || recovered.dropped.length > 0) {
        yield* Effect.logWarning("Recovered the inbox after a restart", {
          requeued: recovered.requeued,
          dropped: recovered.dropped
        })
      }
      yield* provide(file.write(recovered.state))
      const ref = yield* SubscriptionRef.make(recovered.state)

      /** Apply `f`, persist the result, then publish it. */
      const transact = <B>(f: (state: InboxState) => readonly [B, InboxState]) =>
        SubscriptionRef.modifyEffect(ref, (state) => {
          const [result, next] = f(state)
          return next === state
            ? Effect.succeed([result, state] as const)
            : provide(file.write(next)).pipe(Effect.as([result, next] as const))
        })

      return Inbox.of({
        deliver: (events, timeZone) =>
          transact((state) => {
            const known = new Set<string>(state.seen)
            const fresh = events.filter((event) => !known.has(event.id))
            const ids = events.map((event) => event.id)
            if (fresh.length === 0 && (timeZone === undefined || timeZone === state.timeZone)) return [ids, state]
            return [
              ids,
              {
                entries: [
                  ...state.entries,
                  ...fresh.map((event) => ({
                    event,
                    state: needsCommand(event) ? ("command" as const) : ("queued" as const),
                    attempts: 0
                  }))
                ],
                seen: [...state.seen, ...fresh.map((event) => event.id)].slice(-seenLimit),
                ...(timeZone !== undefined
                  ? { timeZone }
                  : state.timeZone !== undefined
                    ? { timeZone: state.timeZone }
                    : {})
              }
            ]
          }),
        take: transact((state) => {
          const queued = state.entries.filter((entry) => entry.state === "queued")
          if (queued.length === 0) return [[], state]
          return [
            queued.map((entry) => entry.event),
            {
              ...state,
              entries: state.entries.map((entry) =>
                entry.state === "queued" ? { ...entry, state: "turn" as const, attempts: entry.attempts + 1 } : entry
              )
            }
          ]
        }),
        release: (ids, outcome) =>
          transact((state) => {
            const released = new Set<string>(ids)
            const dropped: Array<EventId> = []
            const entries = state.entries.flatMap((entry): Array<Entry> => {
              if (!released.has(entry.event.id) || entry.state !== "turn") return [entry]
              if (outcome === "done") return []
              if (outcome === "untake") return [{ ...entry, state: "queued", attempts: entry.attempts - 1 }]
              if (entry.attempts < maxAttempts) return [{ ...entry, state: "queued" }]
              dropped.push(entry.event.id)
              return []
            })
            return [dropped, { ...state, entries }]
          }).pipe(
            Effect.tap((dropped) =>
              dropped.length === 0
                ? Effect.void
                : Effect.logError(`Dropped events after ${maxAttempts} failed turns`, { dropped })
            ),
            Effect.asVoid
          ),
        commands: SubscriptionRef.get(ref).pipe(
          Effect.map((state) =>
            state.entries.flatMap((entry) =>
              entry.state === "command" && entry.event._tag === "WakeDue" ? [entry.event] : []
            )
          )
        ),
        commandFinished: (id, result, wake = result.exitCode !== 0) =>
          transact((state) => {
            const entries = state.entries.flatMap((entry): Array<Entry> => {
              if (entry.event.id !== id || entry.state !== "command" || entry.event._tag !== "WakeDue") return [entry]
              if (!wake || entry.event.run === undefined) return []
              return [
                {
                  ...entry,
                  state: "queued",
                  event: { ...entry.event, run: { command: entry.event.run.command, result } }
                }
              ]
            })
            return [undefined, { ...state, entries }]
          }),
        taskFinished: (id, failure) =>
          transact((state) => {
            const entries = state.entries.flatMap((entry): Array<Entry> => {
              if (entry.event.id !== id || entry.state !== "command" || entry.event._tag !== "WakeDue") return [entry]
              if (failure === undefined || entry.event.task === undefined) return []
              return [
                { ...entry, state: "queued", event: { ...entry.event, task: { ...entry.event.task, result: failure } } }
              ]
            })
            return [undefined, { ...state, entries }]
          }),
        state: SubscriptionRef.get(ref),
        changes: SubscriptionRef.changes(ref)
      })
    })
  )
}

/** Events a turn had taken when dreamd stopped go back in the queue, unless they've failed too often. */
export const recover = (
  state: InboxState
): { readonly state: InboxState; readonly requeued: number; readonly dropped: ReadonlyArray<EventId> } => {
  const dropped: Array<EventId> = []
  let requeued = 0
  const entries = state.entries.flatMap((entry): Array<Entry> => {
    if (entry.state !== "turn") return [entry]
    if (entry.attempts >= maxAttempts) {
      dropped.push(entry.event.id)
      return []
    }
    requeued++
    return [{ ...entry, state: "queued" }]
  })
  return { state: { ...state, entries }, requeued, dropped }
}

export const queuedCount = (state: InboxState): number =>
  state.entries.filter((entry) => entry.state === "queued" || entry.state === "command").length
