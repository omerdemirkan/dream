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
 *
 * The person sees only what goes through `dream`. Questions the model asks
 * through its harness go to their phone, and a turn that ends with something
 * to say, having sent them nothing, posts its final words to Chat, unless
 * nothing the person did is among its events (see `agentOnly`).
 *
 * After a completed turn with nothing else queued, the published URL is
 * loaded, and a new breakage there becomes an event for the agent (see
 * `Published.ts`).
 */
import { renderSteerPrompt, renderTurnPrompt } from "@dream/agent-context"
import type { AgentEvent, EventId, ModelProvider, TurnState } from "@dream/domain"
import { Clock, Context, DateTime, Duration, Effect, Exit, Layer, Option, Ref, Stream } from "effect"
import { Api } from "./Api.ts"
import { Harness, type TurnResult, TurnOutcome } from "./harness/Harness.ts"
import { type QuestionOutcome, replyFromFinalText } from "./harness/PersonChannel.ts"
import type { TurnHandlers } from "./harness/Turn.ts"
import { Inbox, type InboxState, queuedCount } from "./Inbox.ts"
import { Outreach } from "./Outreach.ts"
import { Published } from "./Published.ts"
import * as Usage from "./Usage.ts"

/** Waits after consecutive failed turns: 15 s, 30 s, 1 min, … up to 10 min. */
export const backoff = (failures: number): Duration.Duration =>
  Duration.min(Duration.seconds(15 * 2 ** Math.max(0, failures - 1)), Duration.minutes(10))

/**
 * Events that come from the agent's own doing rather than the person: a wake whose command it ran, a `dream wake`,
 * a check of its published URL. A turn started only by these doesn't post its final text to Chat.
 */
export const agentOnly = (event: AgentEvent): boolean =>
  event._tag === "Alert" || event._tag === "PublishedUrlBroken" || (event._tag === "WakeDue" && event.run !== undefined)

const hasQueued = (state: InboxState) => state.entries.some((entry) => entry.state === "queued")
const hasQueuedReset = (state: InboxState) =>
  state.entries.some((entry) => entry.state === "queued" && entry.event._tag === "UsageReset")

export class Agent extends Context.Service<
  Agent,
  {
    /** Run turns as events arrive, forever. */
    readonly run: Effect.Effect<never>
    readonly status: Effect.Effect<{ readonly turn: TurnState; readonly queued: number }>
    /** When the last turn ended (epoch ms), if one has since dreamd started. */
    readonly lastTurnEnded: Effect.Effect<Option.Option<number>>
  }
>()("@dream/dreamd/Agent") {
  static readonly layer = Layer.effect(
    Agent,
    Effect.gen(function* () {
      const inbox = yield* Inbox
      const harness = yield* Harness
      const api = yield* Api
      const outreach = yield* Outreach
      const published = yield* Published
      const provider: ModelProvider = harness.name === "claude-code" ? "claude" : "chatgpt"
      const running = yield* Ref.make(false)
      const lastTurnEndedMs = yield* Ref.make(Option.none<number>())
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
      const steer = (
        taken: Ref.Ref<ReadonlyArray<EventId>>,
        fromPerson: Ref.Ref<boolean>,
        timeZone: string | undefined
      ) =>
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
                Effect.tap(() => Ref.update(fromPerson, (before) => before || !events.every(agentOnly))),
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

      const handlers: TurnHandlers = {
        ask: (question) =>
          api.askQuestion(question).pipe(
            Effect.tap(() => outreach.record(["AskQuestion"])),
            Effect.map((messageId): QuestionOutcome => ({ _tag: "Sent", messageId })),
            Effect.catch((error) =>
              Effect.logWarning("Couldn't send the agent's question", { error: error.message }).pipe(
                Effect.as<QuestionOutcome>({ _tag: "NotSent", reason: `Dream couldn't send it (${error.message})` })
              )
            )
          )
      }

      /**
       * A completed turn that sent them nothing but ended with something to say: put that in Chat. Only when
       * something they did is among its events; otherwise the agent was talking to itself.
       */
      const replyIfSilent = (result: TurnResult, reachedBefore: number, fromPerson: boolean) =>
        Effect.gen(function* () {
          if (result.outcome._tag !== "Completed" || !fromPerson) return
          const reply = replyFromFinalText(result.finalText ?? "")
          if (Option.isNone(reply) || (yield* outreach.count) !== reachedBefore) return
          yield* api.sendMessage(reply.value).pipe(
            Effect.tap(() => outreach.record(["SendMessage"])),
            Effect.tap((messageId) =>
              Effect.logInfo("The turn sent nothing; posted its final text to Chat", { messageId })
            ),
            Effect.catch((error) => Effect.logWarning("Couldn't post the turn's final text", { error: error.message }))
          )
        })

      /** Run one turn with everything queued. Returns whether it should be retried. */
      const turn = Effect.gen(function* () {
        const events = yield* inbox.take
        if (events.length === 0) return false
        const taken = yield* Ref.make<ReadonlyArray<EventId>>(events.map((event) => event.id))
        const fromPerson = yield* Ref.make(!events.every(agentOnly))
        const { timeZone } = yield* inbox.state
        yield* Ref.set(running, true)
        yield* api.reportTurn("started", yield* Ref.get(taken))
        yield* Effect.logInfo("Turn started", { events: yield* Ref.get(taken) })

        const prompt = renderTurnPrompt({ events, now: yield* DateTime.now, timeZone })
        const reachedBefore = yield* outreach.count
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(steer(taken, fromPerson, timeZone))
            return yield* harness.turn(prompt, handlers)
          })
        ).pipe(Effect.exit)
        if (Exit.isSuccess(exit)) yield* replyIfSilent(exit.value, reachedBefore, yield* Ref.get(fromPerson))

        const ids = yield* Ref.get(taken)
        const result = Exit.isSuccess(exit) ? exit.value : undefined
        const completed = result !== undefined && result.outcome._tag === "Completed"
        // Events count as handled once the agent has started on them; otherwise they go to the next turn.
        const requeue = !completed && result?.progressed !== true
        const limited = result?.usage.limit !== undefined
        yield* inbox.release(ids, requeue ? "retry" : "done")

        if (result !== undefined) yield* Ref.update(usage, (previous) => Usage.merge(previous, result.usage))
        const reading = yield* Ref.get(usage)
        if (Object.keys(reading).length > 0) {
          yield* api.reportUsage(Usage.toSnapshot(provider, reading, yield* DateTime.now))
        }
        yield* api.reportTurn("finished", ids, result?.turnUsage)
        yield* Ref.set(running, false)
        yield* Ref.set(lastTurnEndedMs, Option.some(yield* Clock.currentTimeMillis))

        if (Exit.isFailure(exit)) {
          yield* Effect.logError("The turn couldn't run", exit.cause)
        } else if (TurnOutcome.$is("Failed")(exit.value.outcome)) {
          yield* Effect.logWarning("The turn failed", { error: exit.value.outcome.message, requeue, limited })
        } else {
          yield* Effect.logInfo("Turn finished", { events: ids })
        }
        // Look at the published app once the agent is done, unless more work is already waiting.
        if (completed && !limited && !hasQueued(yield* inbox.state)) yield* published.checkAfterTurn
        // A limit is waited out before the next turn; other failures back off.
        return requeue && !limited
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (yield* Ref.getAndSet(running, false)) {
              yield* Ref.set(lastTurnEndedMs, Option.some(yield* Clock.currentTimeMillis))
            }
          })
        )
      )

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
        }),
        lastTurnEnded: Ref.get(lastTurnEndedMs)
      })
    })
  )
}
