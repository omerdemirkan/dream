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
 * Attachments in the events are copied into the sandbox before the prompt
 * that names them (see `Attachments.ts`).
 *
 * The prompt also says what the previous turn used, session by session
 * (`harness/TurnUsage.ts`), kept in `last-turn.json` so it survives a
 * restart: the agent can't see its own spending otherwise.
 *
 * After a completed turn with nothing else queued, the published URL is
 * loaded, and a new breakage there becomes an event for the agent (see
 * `Published.ts`).
 *
 * A turn lasts while the agent's background work runs (`harness/Background.ts`). Whatever was still running when it
 * ended (Dream stopped it past a limit, or the turn ended another way) becomes a `BackgroundStopped` event, which
 * starts the next turn, as does work that stopped before dreamd started. One exception keeps a loop from forming: a
 * turn started only by such an event whose own background work is stopped past a limit again holds that news for
 * the next turn something else starts.
 */
import { renderSteerPrompt, renderTurnPrompt } from "@dream/agent-context"
import { randomUUID } from "node:crypto"
import { type AgentEvent, EventId, type ModelProvider, type TurnState, type UsageWindow } from "@dream/domain"
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Stream
} from "effect"
import { Api } from "./Api.ts"
import { Attachments } from "./Attachments.ts"
import { DreamdConfig } from "./Config.ts"
import * as Background from "./harness/Background.ts"
import { Harness, type TurnResult, TurnOutcome } from "./harness/Harness.ts"
import { type QuestionOutcome, replyFromFinalText } from "./harness/PersonChannel.ts"
import type { TurnHandlers } from "./harness/Turn.ts"
import { Hold } from "./Hold.ts"
import { Inbox, type InboxState, queuedCount } from "./Inbox.ts"
import * as JsonFile from "./JsonFile.ts"
import { ProjectLog } from "./Log.ts"
import { Machine } from "./Machine.ts"
import { Outreach } from "./Outreach.ts"
import { Progress } from "./progress/Progress.ts"
import { Published } from "./Published.ts"
import * as Usage from "./Usage.ts"

/** Waits after consecutive failed turns: 15 s, 30 s, 1 min, … up to 10 min. */
export const backoff = (failures: number): Duration.Duration =>
  Duration.min(Duration.seconds(15 * 2 ** Math.max(0, failures - 1)), Duration.minutes(10))

/**
 * Events that come from the agent's own doing rather than the person: a wake whose command it ran, a `dream wake`,
 * a check of its published URL. A turn started only by these doesn't post its final text to Chat. A move to another
 * plan is theirs, but what the agents say about it is between them (a handoff written, a handoff read).
 */
export const agentOnly = (event: AgentEvent): boolean =>
  event._tag === "Alert" ||
  event._tag === "PublishedUrlBroken" ||
  event._tag === "BackgroundStopped" ||
  event._tag === "PlanSwitching" ||
  event._tag === "PlanSwitched" ||
  (event._tag === "WakeDue" && (event.run !== undefined || event.task !== undefined))

/** What the last turn used (`LastTurn` in `@dream/agent-context`), as `last-turn.json` keeps it. */
const LastTurnFile = Schema.Struct({
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  priced: Schema.Boolean,
  sessions: Schema.Array(
    Schema.Struct({
      own: Schema.Boolean,
      description: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(Schema.String),
      effort: Schema.optionalKey(Schema.String),
      steps: Schema.Finite,
      peakContext: Schema.Finite,
      cost: Schema.Finite,
      recached: Schema.Finite
    })
  ),
  weekly: Schema.optionalKey(Schema.Struct({ before: Schema.Finite, after: Schema.Finite }))
})

/** The weekly window's rise across a turn, when both readings are of the same window (it didn't reset meanwhile). */
const weeklyRise = (before: UsageWindow | undefined, after: UsageWindow | undefined) => {
  if (before === undefined || after === undefined) return undefined
  const resets = [before.resetsAt, after.resetsAt].map((at) =>
    at === undefined ? undefined : DateTime.toEpochMillis(at)
  )
  const [from, to] = resets
  if (from !== undefined && to !== undefined && Math.abs(from - to) > 30 * 60_000) return undefined
  return { before: before.usedPercent, after: after.usedPercent }
}

/** What woke a turn, for the log: "a message from them, a wake-up". */
const wokenBy = (events: ReadonlyArray<AgentEvent>): string => {
  const names: Record<AgentEvent["_tag"], string> = {
    UserMessage: "a message from them",
    QuestionAnswered: "an answer",
    AccessConnected: "a connection",
    AccessDeclined: "a declined request",
    AccessRemoved: "a removed connection",
    WakeDue: "a wake-up",
    Alert: "an alert",
    UsageReset: "a usage reset",
    UsageLimitsChanged: "changed usage limits",
    PublishedUrlBroken: "the published URL looking broken",
    LinkEdited: "an edited app link",
    AppNotificationsChanged: "a change to an app's notifications",
    MachineMoved: "a machine move",
    PlanSwitching: "a move to another plan",
    PlanSwitched: "a move to another plan",
    AppNotificationsHeld: "notifications held back",
    BackgroundStopped: "stopped background work"
  }
  return [...new Set(events.map((event) => names[event._tag]))].join(", ")
}

/**
 * A handoff asked of the agent on another harness: the project has moved since (a restart in the handoff's turn left
 * it queued), so there's no one here to write it.
 */
export const staleFor =
  (harness: string) =>
  (event: AgentEvent): boolean =>
    event._tag === "PlanSwitching" && event.from !== harness

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
      const hold = yield* Hold
      const harness = yield* Harness
      const api = yield* Api
      const outreach = yield* Outreach
      const published = yield* Published
      const attachments = yield* Attachments
      const progress = yield* Progress
      const log = yield* ProjectLog
      const machine = yield* Machine
      const config = yield* DreamdConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const provider: ModelProvider = harness.name === "claude-code" ? "claude" : "chatgpt"
      const lastTurnFile = JsonFile.make(LastTurnFile, path.join(config.stateDir, "last-turn.json"))
      const onDisk = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        effect.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))
      /** The weekly window as the running turn's first model call left it. */
      const weeklyAtStart = yield* Ref.make<UsageWindow | undefined>(undefined)
      const running = yield* Ref.make(false)
      const lastTurnEndedMs = yield* Ref.make(Option.none<number>())
      const usage = yield* Ref.make<Usage.UsageReading>({})
      /** News of background work stopped again, held for the next turn (see above). */
      const heldStop = yield* Ref.make(Option.none<AgentEvent>())

      const stoppedEvent = (stopped: Background.Stopped) =>
        Effect.map(DateTime.now, (at) =>
          Background.toEvent(stopped, { id: EventId.make(`evt_dreamd_${randomUUID()}`), at })
        )
      /** Tell the agent about background work that stopped, now or (`hold`) with the next turn. */
      const reportStopped = (stopped: Background.Stopped, hold: boolean) =>
        Effect.gen(function* () {
          const event = yield* stoppedEvent(stopped)
          if (hold) {
            yield* Ref.set(heldStop, Option.some(event))
            yield* Effect.logWarning("Background work was stopped again; the agent hears of it next turn", {
              reason: stopped.reason
            })
            return
          }
          yield* inbox.deliver([event])
          yield* log.note(
            "dream",
            "warn",
            `Dream stopped background work that hadn't reported back (${stopped.reason}): ` +
              stopped.tasks.map((task) => task.description).join("; ")
          )
          yield* Effect.logInfo("Background work stopped before it reported back; told the agent", {
            reason: stopped.reason,
            tasks: stopped.tasks.length,
            event: event.id
          })
        }).pipe(
          Effect.catch((error) => Effect.logError("Couldn't tell the agent its background work stopped", { error }))
        )

      /** What's queued, but for handoffs asked of another harness's agent, which are dropped. */
      const takeLive = Effect.gen(function* () {
        const taken = yield* inbox.take
        const stale = taken.filter(staleFor(harness.name))
        if (stale.length === 0) return taken
        yield* inbox.release(
          stale.map((event) => event.id),
          "done"
        )
        yield* Effect.logInfo("Dropped a handoff asked of the agent on the plan the project left", {
          events: stale.map((event) => event.id)
        })
        return taken.filter((event) => !staleFor(harness.name)(event))
      })

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
              const events = yield* takeLive
              if (events.length === 0) return true
              const ids = events.map((event) => event.id)
              const missingAttachments = yield* attachments.fetch(events)
              const text = renderSteerPrompt({ events, now: yield* DateTime.now, timeZone, missingAttachments })
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
          ),
        firstUsage: (reading) =>
          Effect.gen(function* () {
            yield* Ref.set(weeklyAtStart, reading.weekly)
            yield* Ref.update(usage, (previous) => Usage.merge(previous, reading))
            yield* api.reportUsage(Usage.toSnapshot(provider, yield* Ref.get(usage), yield* DateTime.now))
          }),
        observe: progress.observe
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

      /** Keep what the turn used for the next one's prompt; a turn that used nothing leaves nothing to say. */
      const keepLastTurn = (startedAt: DateTime.Utc, result: TurnResult | undefined, reading: Usage.UsageReading) =>
        Effect.gen(function* () {
          if (result?.spend === undefined) {
            if (yield* fs.exists(lastTurnFile.path)) yield* fs.remove(lastTurnFile.path)
            return
          }
          const weekly = weeklyRise(yield* Ref.get(weeklyAtStart), reading.weekly)
          yield* onDisk(
            lastTurnFile.write({
              startedAt,
              endedAt: yield* DateTime.now,
              priced: result.spend.priced,
              sessions: result.spend.sessions,
              ...(weekly === undefined ? {} : { weekly })
            })
          )
        }).pipe(
          Effect.catch((error) => Effect.logWarning("Couldn't keep what the turn used", { error: String(error) }))
        )

      /** Run one turn with everything queued. Returns whether it should be retried. */
      const turn = Effect.gen(function* () {
        const held = yield* Ref.getAndSet(heldStop, Option.none())
        if (Option.isSome(held)) yield* inbox.deliver([held.value])
        const events = yield* takeLive
        if (events.length === 0) return false
        const taken = yield* Ref.make<ReadonlyArray<EventId>>(events.map((event) => event.id))
        const fromPerson = yield* Ref.make(!events.every(agentOnly))
        const { timeZone } = yield* inbox.state
        const startedAt = yield* DateTime.now
        yield* Ref.set(weeklyAtStart, undefined)
        yield* Ref.set(running, true)
        const window = `turn-${DateTime.toEpochMillis(startedAt)}`
        yield* machine.begin(window)
        yield* api.reportTurn("started", yield* Ref.get(taken))
        yield* progress.turnStarted(events)
        yield* Effect.logInfo("Turn started", { events: yield* Ref.get(taken) })
        yield* log.note("dream", "info", `A turn started, woken by ${wokenBy(events)}`)

        const missingAttachments = yield* attachments.fetch(events)
        const lastTurn = yield* onDisk(lastTurnFile.read).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.catch((error) =>
            Effect.logWarning("Couldn't read what the last turn used", { error: error.message }).pipe(
              Effect.as(undefined)
            )
          )
        )
        const prompt = renderTurnPrompt({ events, now: yield* DateTime.now, timeZone, missingAttachments, lastTurn })
        const reachedBefore = yield* outreach.count
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(steer(taken, fromPerson, timeZone))
            return yield* harness.turn(prompt, handlers)
          })
        ).pipe(Effect.exit)
        yield* progress.turnEnded
        if (Exit.isSuccess(exit)) yield* replyIfSilent(exit.value, reachedBefore, yield* Ref.get(fromPerson))

        const ids = yield* Ref.get(taken)
        const result = Exit.isSuccess(exit) ? exit.value : undefined
        const completed = result !== undefined && result.outcome._tag === "Completed"
        // Events count as handled once the agent has started on them; otherwise they go to the next turn.
        const requeue = !completed && result?.progressed !== true
        const limited = result?.usage.limit !== undefined
        yield* inbox.release(ids, requeue ? "retry" : "done")

        if (result?.backgroundStopped !== undefined) {
          const again =
            events.every((event) => event._tag === "BackgroundStopped") &&
            (result.backgroundStopped.reason === "quiet" || result.backgroundStopped.reason === "long")
          yield* reportStopped(result.backgroundStopped, again)
        }
        if (result !== undefined) yield* Ref.update(usage, (previous) => Usage.merge(previous, result.usage))
        const reading = yield* Ref.get(usage)
        if (Object.keys(reading).length > 0) {
          yield* api.reportUsage(Usage.toSnapshot(provider, reading, yield* DateTime.now))
        }
        yield* api.reportTurn("finished", ids, result?.turnUsage, yield* machine.end(window))
        yield* keepLastTurn(startedAt, result, reading)
        yield* Ref.set(running, false)
        yield* Ref.set(lastTurnEndedMs, Option.some(yield* Clock.currentTimeMillis))

        const took = Duration.format(
          Duration.seconds(
            Math.round((DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(startedAt)) / 1000)
          )
        )
        if (Exit.isFailure(exit)) {
          yield* Effect.logError("The turn couldn't run", exit.cause)
          yield* log.note("dream", "error", `The turn couldn't run: ${Cause.pretty(exit.cause).split("\n")[0]}`)
        } else if (TurnOutcome.$is("Failed")(exit.value.outcome)) {
          yield* Effect.logWarning("The turn failed", { error: exit.value.outcome.message, requeue, limited })
          yield* log.note("dream", "warn", `The turn failed after ${took}: ${exit.value.outcome.message}`)
        } else {
          yield* Effect.logInfo("Turn finished", { events: ids })
          yield* log.note("dream", "info", `The turn ended after ${took}`)
        }
        // Look at the published app once the agent is done, unless more work is already waiting.
        if (completed && !limited && !hasQueued(yield* inbox.state)) yield* published.checkAfterTurn
        // A limit is waited out before the next turn; other failures back off.
        return requeue && !limited
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* progress.turnEnded
            if (yield* Ref.getAndSet(running, false)) {
              yield* Ref.set(lastTurnEndedMs, Option.some(yield* Clock.currentTimeMillis))
            }
          })
        )
      )

      const run = Effect.gen(function* () {
        const before = yield* harness.takeStopped
        if (Option.isSome(before)) yield* reportStopped(before.value, false)
        let failures = 0
        while (true) {
          yield* waitOutLimit
          yield* waitFor(hasQueued)
          // A limit they set on the project: what's queued waits until it's raised, cleared or over.
          yield* hold.released
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
