/**
 * The event loop. Nothing runs until an event is queued; then one turn takes
 * every queued event, and events that arrive while it runs are handed to it
 * (both harnesses take input mid-turn) or, if it can't take them, wait for the
 * next turn. Dream never starts a turn on its own.
 *
 * A turn that fails before the agent did anything gives its events to the
 * next try, after a backoff. One that hit a usage limit stops, reports the
 * limit (the API pauses the project and wakes the agent when it resets), and
 * no turn starts until the reset passes or a `UsageReset` arrives.
 */
import { renderSteerPrompt, renderTurnPrompt } from "@dream/agent-context"
import type { EventId, ModelProvider, TurnState } from "@dream/domain"
import { Context, DateTime, Duration, Effect, Exit, Layer, Ref, Stream } from "effect"
import { Api } from "./Api.ts"
import { Harness, TurnOutcome } from "./harness/Harness.ts"
import { Inbox, type InboxState, queuedCount } from "./Inbox.ts"
import * as Usage from "./Usage.ts"

/** Waits after consecutive failed turns: 15 s, 30 s, 1 min, … up to 10 min. */
export const backoff = (failures: number): Duration.Duration =>
  Duration.min(Duration.seconds(15 * 2 ** Math.max(0, failures - 1)), Duration.minutes(10))

const hasQueued = (state: InboxState) => state.entries.some((entry) => entry.state === "queued")
const hasQueuedReset = (state: InboxState) =>
  state.entries.some((entry) => entry.state === "queued" && entry.event._tag === "UsageReset")

export class Agent extends Context.Service<
  Agent,
  {
    /** Run turns as events arrive, forever. */
    readonly run: Effect.Effect<never>
    readonly status: Effect.Effect<{ readonly turn: TurnState; readonly queued: number }>
  }
>()("@dream/dreamd/Agent") {
  static readonly layer = Layer.effect(
    Agent,
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const harness = yield* Harness
      const api = yield* Api
      const provider: ModelProvider = harness.name === "claude-code" ? "claude" : "chatgpt"
      const running = yield* Ref.make(false)
      const usage = yield* Ref.make<Usage.UsageReading>({})

      const waitFor = (predicate: (state: InboxState) => boolean) =>
        inbox.changes.pipe(Stream.filter(predicate), Stream.take(1), Stream.runDrain)

      /** Don't start a turn while a usage limit holds. */
      const waitOutLimit = Effect.gen(function* () {
        const { limit } = yield* Ref.get(usage)
        if (limit === undefined) return
        const remaining = DateTime.distance(yield* DateTime.now, limit.until)
        if (Duration.isGreaterThan(remaining, Duration.zero)) {
          yield* Effect.logInfo("Waiting for the usage limit to reset", {
            window: limit.window,
            until: DateTime.formatIso(limit.until)
          })
          yield* Effect.raceFirst(Effect.sleep(remaining), waitFor(hasQueuedReset))
        }
        yield* Ref.update(usage, ({ limit: _, ...rest }) => rest)
      })

      /** Hand events that arrive mid-turn to the turn, until it can't take them. */
      const steer = (taken: Ref.Ref<ReadonlyArray<EventId>>, timeZone: string | undefined) =>
        inbox.changes.pipe(
          Stream.filter(hasQueued),
          Stream.mapEffect(() =>
            Effect.gen(function* () {
              const events = yield* inbox.take
              if (events.length === 0) return true
              const ids = events.map((event) => event.id)
              const text = renderSteerPrompt({ events, now: yield* DateTime.now, timeZone })
              return yield* harness.steer(text).pipe(
                Effect.tap(() => Ref.update(taken, (all) => [...all, ...ids])),
                Effect.tap(() => Effect.logInfo("Gave new events to the running turn", { events: ids })),
                Effect.as(true),
                Effect.catch((error) =>
                  Effect.logInfo("The turn can't take new events; they'll start the next one", {
                    reason: error.message
                  }).pipe(Effect.andThen(inbox.release(ids, "untake")), Effect.as(false))
                )
              )
            })
          ),
          Stream.takeWhile((steered) => steered),
          Stream.runDrain
        )

      /** Run one turn with everything queued. Returns whether it should be retried. */
      const turn = Effect.gen(function* () {
        const events = yield* inbox.take
        if (events.length === 0) return false
        const taken = yield* Ref.make<ReadonlyArray<EventId>>(events.map((event) => event.id))
        const { timeZone } = yield* inbox.state
        yield* Ref.set(running, true)
        yield* api.reportTurn("started", yield* Ref.get(taken))
        yield* Effect.logInfo("Turn started", { events: yield* Ref.get(taken) })

        const prompt = renderTurnPrompt({ events, now: yield* DateTime.now, timeZone })
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(steer(taken, timeZone))
            return yield* harness.turn(prompt)
          })
        ).pipe(Effect.exit)

        const ids = yield* Ref.get(taken)
        const result = Exit.isSuccess(exit) ? exit.value : undefined
        const completed = result !== undefined && result.outcome._tag === "Completed"
        const retry = !completed && result?.progressed !== true && result?.usage.limit === undefined
        yield* inbox.release(ids, retry ? "retry" : "done")

        if (result !== undefined) yield* Ref.update(usage, (previous) => Usage.merge(previous, result.usage))
        const reading = yield* Ref.get(usage)
        if (Object.keys(reading).length > 0) {
          yield* api.reportUsage(Usage.toSnapshot(provider, reading, yield* DateTime.now))
        }
        yield* api.reportTurn("finished", ids)
        yield* Ref.set(running, false)

        if (Exit.isFailure(exit)) {
          yield* Effect.logError("The turn couldn't run", exit.cause)
        } else if (exit.value.outcome._tag === "Failed") {
          yield* Effect.logWarning("The turn failed", {
            error: TurnOutcome.$is("Failed")(exit.value.outcome) ? exit.value.outcome.message : "",
            retry
          })
        } else {
          yield* Effect.logInfo("Turn finished", { events: ids })
        }
        return retry
      }).pipe(Effect.ensuring(Ref.set(running, false)))

      const run = Effect.gen(function* () {
        let failures = 0
        while (true) {
          yield* waitOutLimit
          yield* waitFor(hasQueued)
          const retry = yield* turn.pipe(
            Effect.catch((error) => Effect.logError("The inbox failed", { error: error.message }).pipe(Effect.as(true)))
          )
          failures = retry ? failures + 1 : 0
          if (retry) yield* Effect.sleep(backoff(failures))
        }
      })

      return Agent.of({
        run,
        status: Effect.gen(function* () {
          const state = yield* inbox.state
          return { turn: (yield* Ref.get(running)) ? "running" : "idle", queued: queuedCount(state) }
        })
      })
    })
  )
}
