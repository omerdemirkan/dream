/**
 * Turn progress: while a turn runs and someone is watching, what it's doing, shown under "Working" in Chat and on
 * Home: a line in the agent's voice ("Setting up unit tests for the voice session") and the liveness signal (when
 * the harness last did anything; whether one long step is all that's going on).
 *
 * Every harness event of the turn is folded into steps (`Steps.ts`), and `Summarizer` picks the line (without a
 * model, see `Derive.ts`). Nothing is reported unless:
 *
 * - it's on for this project (`DaemonEnv.progressLine`);
 * - someone is watching: the DO said so (`SetWatching`) in the last `watchingFor`; it repeats itself every few
 *   minutes while a phone stays subscribed, so a lost "stopped watching" can't keep this going.
 *
 * Then a new line is picked only when the work moved on (a step the last one wasn't picked from), at most every
 * `minInterval` (`firstAfter` into the turn for the first), and reported if it differs from the one on screen.
 * Liveness alone is reported every `heartbeat` when it has changed.
 */
import type { AgentEvent } from "@dream/domain"
import { renderAgentEvent } from "@dream/domain"
import { Clock, Context, DateTime, Duration, Effect, Layer, Option, Ref } from "effect"
import { Api } from "../Api.ts"
import { DreamdConfig } from "../Config.ts"
import type { Part } from "../harness/Turn.ts"
import { liveness, type Shown } from "./Derive.ts"
import * as Steps from "./Steps.ts"
import { Summarizer } from "./Summarizer.ts"

export const tick = Duration.seconds(10)
export const minInterval = Duration.minutes(1)
export const firstAfter = Duration.seconds(10)
export const heartbeat = Duration.minutes(2)
export const watchingFor = Duration.minutes(12)

interface Reported {
  readonly line: string | undefined
  readonly activeAt: number
  readonly waitingSince: number | undefined
  readonly at: number
}

interface TurnState {
  readonly id: number
  readonly startedAt: number
  readonly trigger: string | undefined
  readonly steps: Steps.StepsState
  readonly lastEventAt: number
  readonly statusNow: string | undefined
  readonly line: string | undefined
  readonly shown: Shown | undefined
  /** The steps' version the line was last picked from, and when. */
  readonly pickedVersion: number
  readonly pickedAt: number
  readonly reported: Reported | undefined
}

/** What started the turn, as one short line: their message if there is one, else the first event. */
export const triggerOf = (events: ReadonlyArray<AgentEvent>): string | undefined => {
  const message = events.findLast((event) => event._tag === "UserMessage")
  if (message !== undefined && message._tag === "UserMessage") {
    return `They wrote: “${Steps.clip(message.text, 240)}”`
  }
  const first = events[0]
  if (first === undefined) return undefined
  const text = renderAgentEvent(first)
    .split("\n")
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ")
  return Steps.clip(text, 200)
}

export class Progress extends Context.Service<
  Progress,
  {
    readonly turnStarted: (events: ReadonlyArray<AgentEvent>) => Effect.Effect<void>
    /** Every part of the running turn's stream. */
    readonly observe: (part: Part) => Effect.Effect<void>
    /** The agent set its Status card's now sentence (or a workstream's) through `dream`. */
    readonly statusNow: (text: string) => Effect.Effect<void>
    readonly turnEnded: Effect.Effect<void>
    /** From the DO (`DaemonRpcs.SetWatching`). */
    readonly setWatching: (watching: boolean) => Effect.Effect<void>
    /** Reports progress while turns run, forever. */
    readonly run: Effect.Effect<never>
    /** One check, as `run` makes every `tick`: what it reported, if anything. For tests. */
    readonly check: Effect.Effect<Option.Option<Reported>>
  }
>()("@dream/dreamd/Progress") {
  static readonly layer = Layer.effect(
    Progress,
    Effect.gen(function* () {
      const config = yield* DreamdConfig
      const api = yield* Api
      const summarizer = yield* Summarizer
      const turn = yield* Ref.make(Option.none<TurnState>())
      const watching = yield* Ref.make<{ readonly watching: boolean; readonly at: number }>({ watching: false, at: 0 })
      const turns = yield* Ref.make(0)

      const isWatched = (now: number) =>
        Effect.map(Ref.get(watching), (state) => state.watching && now - state.at < Duration.toMillis(watchingFor))

      const pickDue = (state: TurnState, now: number) =>
        state.steps.version !== state.pickedVersion &&
        (state.pickedAt === 0
          ? now - state.startedAt >= Duration.toMillis(firstAfter)
          : now - state.pickedAt >= Duration.toMillis(minInterval))

      const checkOnce = Effect.gen(function* () {
        if (!config.progressLine) return Option.none<Reported>()
        const now = yield* Clock.currentTimeMillis
        const found = yield* Ref.get(turn)
        if (Option.isNone(found) || !(yield* isWatched(now))) return Option.none<Reported>()
        let state = found.value
        if (now - state.startedAt < Duration.toMillis(firstAfter)) return Option.none<Reported>()
        const steps = Steps.current(state.steps, now)
        if (pickDue(state, now)) {
          const picked = yield* summarizer.summarize({
            steps,
            trigger: state.trigger,
            startedAt: state.startedAt,
            now,
            shown: state.shown,
            statusNow: state.statusNow
          })
          const fresh = Option.filter(picked, ({ line }) => line !== state.line)
          state = {
            ...state,
            pickedVersion: state.steps.version,
            pickedAt: now,
            ...Option.match(fresh, {
              onNone: () => ({}),
              onSome: ({ line, score }) => ({ line, shown: { line, at: now, score } })
            })
          }
        }
        const alive = liveness(steps, state.lastEventAt)
        const last = state.reported
        const changedLine = state.line !== last?.line
        const heartbeatDue =
          last === undefined ||
          (now - last.at >= Duration.toMillis(heartbeat) &&
            (alive.activeAt !== last.activeAt || alive.waitingSince !== last.waitingSince))
        if (!changedLine && !heartbeatDue) {
          yield* Ref.set(turn, Option.some(state))
          return Option.none<Reported>()
        }
        const report: Reported = { line: state.line, ...alive, at: now }
        yield* Ref.set(turn, Option.some({ ...state, reported: report }))
        yield* api.reportProgress({
          ...(report.line === undefined ? {} : { line: report.line }),
          activeAt: DateTime.makeUnsafe(report.activeAt),
          ...(report.waitingSince === undefined ? {} : { waitingSince: DateTime.makeUnsafe(report.waitingSince) })
        })
        if (changedLine && report.line !== undefined) {
          yield* Effect.logInfo("Progress line", { line: report.line, summarizer: summarizer.name })
        }
        return Option.some(report)
      })

      const updateTurn = (f: (state: TurnState, now: number) => TurnState) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Ref.update(
            turn,
            Option.map((state) => f(state, now))
          )
        )

      return Progress.of({
        turnStarted: (events) =>
          Effect.gen(function* () {
            const id = yield* Ref.updateAndGet(turns, (n) => n + 1)
            const now = yield* Clock.currentTimeMillis
            yield* Ref.set(
              turn,
              Option.some({
                id,
                startedAt: now,
                trigger: triggerOf(events),
                steps: Steps.empty,
                lastEventAt: now,
                statusNow: undefined,
                line: undefined,
                shown: undefined,
                pickedVersion: 0,
                pickedAt: 0,
                reported: undefined
              })
            )
          }),
        observe: (part) =>
          updateTurn((state, now) => ({ ...state, lastEventAt: now, steps: Steps.observe(state.steps, part, now) })),
        statusNow: (text) =>
          updateTurn((state, now) => ({
            ...state,
            statusNow: text.trim().length === 0 ? undefined : text.trim(),
            lastEventAt: now,
            // A new now sentence is news of its own.
            pickedVersion: -1
          })),
        turnEnded: Effect.gen(function* () {
          yield* Ref.set(turn, Option.none())
          // The DO says so again when the next turn starts.
          yield* Ref.set(watching, { watching: false, at: 0 })
        }),
        setWatching: (value) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(watching, { watching: value, at: now })),
        run: checkOnce.pipe(
          Effect.catchCause((cause) => Effect.logWarning("The progress check failed", cause)),
          Effect.andThen(Effect.sleep(tick)),
          Effect.forever
        ),
        check: checkOnce
      })
    })
  )
}
