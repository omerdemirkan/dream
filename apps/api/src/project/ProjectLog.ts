/**
 * The half of the project's log Dream keeps outside the sandbox (`Logs.ts` in @dream/domain), in the DO's SQLite:
 * requests to the published app (from the gateway), notifications its apps sent, relays failing, refreshes, moves
 * and visits that never reached the app. `dream logs` reads it (`SandboxRpcs.ReadLog`) alongside the sandbox's half.
 *
 * It also watches the published app's requests, so the agent hears that the app is failing whoever uses it before
 * the person has to say so: an `Alert` with `noticed` (`server-errors` or `unreachable`), once per problem
 * (`watchRequests`). Requests during a turn don't count, since the agent is likely working on the app then.
 */
import {
  AgentEvent,
  boundedLogEntry,
  type LogEntry,
  type LogLevel,
  LogLimits,
  type LogQuery,
  type LogSource
} from "@dream/domain"
import { Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import { newEventId } from "../lib/Ids.ts"
import { Core } from "./Core.ts"
import type { GatewayRequest } from "./ProjectRpcs.ts"
import { Singletons, Store } from "./Store.ts"

/** Slower than this to answer, and a request is logged as a warning. */
export const SlowRequest = Duration.seconds(3)

/** When a run of trouble with the published app is worth telling the agent about, and how often. */
export const TroubleRules = {
  /** Problems count within this window... */
  window: Duration.minutes(15),
  /** ...and this many of them make an alert... */
  threshold: 3,
  /** ...spread over at least this long for `unreachable` (one visitor's "Waking up" page retries quickly). */
  unreachableSpan: Duration.minutes(1),
  /** After an alert, the next comes once this has passed... */
  coolDown: Duration.hours(6),
  /** ...or sooner, once the app has answered `recoveredAfter` requests fine and this has passed. */
  recoveredCoolDown: Duration.hours(1),
  recoveredAfter: 5,
  /** Problems the alert quotes. */
  samples: 5
} as const

export type GatewayTrouble = "server-errors" | "unreachable"

const Watch = Schema.Struct({
  /** When recent problems happened (epoch milliseconds), within `TroubleRules.window`. */
  recent: Schema.Array(Schema.Number),
  /** The latest of them, as the log says them. */
  samples: Schema.Array(Schema.String),
  /** When the agent was told; nothing more about it until this run is over. */
  alertedAt: Schema.optionalKey(Schema.Number),
  /** Requests that went fine since the alert. */
  fine: Schema.Int
})
type Watch = typeof Watch.Type

export const TroubleState = Schema.Struct({
  "server-errors": Schema.optionalKey(Watch),
  unreachable: Schema.optionalKey(Watch)
})
export type TroubleState = typeof TroubleState.Type

const TroubleSingleton = ["trouble", TroubleState] as const

const emptyWatch: Watch = { recent: [], samples: [], fine: 0 }

const troubleOf = (request: GatewayRequest): GatewayTrouble | undefined =>
  request.outcome !== "answered"
    ? "unreachable"
    : request.status !== undefined && request.status >= 500
      ? "server-errors"
      : undefined

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)

/** A request as the log shows it. */
export const requestEntry = (request: GatewayRequest): LogEntry => {
  const head = `${request.method} ${request.path}`
  if (request.outcome === "not-listening") {
    return {
      at: request.at,
      source: "gateway",
      level: "warn",
      text: `${head} never reached the app: nothing was listening on the published port, so they saw "Waking up"`
    }
  }
  if (request.outcome === "no-answer") {
    return {
      at: request.at,
      source: "gateway",
      level: "warn",
      text: `${head} never reached the app: the sandbox didn't answer after ${seconds(request.ms)}, so they saw "Waking up"`
    }
  }
  const status = request.status ?? 0
  const slow = request.ms >= Duration.toMillis(SlowRequest)
  const level: LogLevel = status >= 500 ? "error" : slow ? "warn" : "info"
  return {
    at: request.at,
    source: "gateway",
    level,
    text: `${head} → ${status} in ${seconds(request.ms)}${slow ? " (slow)" : ""}`
  }
}

/**
 * The trouble state after `requests`, and the alerts they call for. A kind of trouble alerts once `threshold`
 * problems happened within `window` (spread over `unreachableSpan` for `unreachable`), then not again until the
 * cool-down has passed, or the shorter one once the app has answered fine for a while.
 */
export const watchRequests = (
  state: TroubleState,
  requests: ReadonlyArray<GatewayRequest>,
  nowMs: number,
  working: boolean
): {
  readonly state: TroubleState
  readonly alerts: ReadonlyArray<{ readonly kind: GatewayTrouble; readonly watch: Watch }>
} => {
  const alerts: Array<{ kind: GatewayTrouble; watch: Watch }> = []
  const next: { -readonly [K in GatewayTrouble]?: Watch } = {}
  for (const kind of ["server-errors", "unreachable"] as const) {
    let watch = state[kind] ?? emptyWatch
    if (watch.alertedAt !== undefined) {
      const since = nowMs - watch.alertedAt
      const over =
        since >= Duration.toMillis(TroubleRules.coolDown) ||
        (watch.fine >= TroubleRules.recoveredAfter && since >= Duration.toMillis(TroubleRules.recoveredCoolDown))
      if (over) watch = emptyWatch
    }
    const recent = [...watch.recent]
    const samples = [...watch.samples]
    let fine = watch.fine
    for (const request of requests) {
      const trouble = troubleOf(request)
      if (trouble === kind) {
        if (working) continue
        recent.push(DateTime.toEpochMillis(request.at))
        samples.push(requestEntry(request).text)
      } else if (kind === "unreachable" ? request.outcome === "answered" : trouble === undefined) {
        fine++
      }
    }
    const cutoff = nowMs - Duration.toMillis(TroubleRules.window)
    const kept = recent.filter((at) => at >= cutoff).sort((a, b) => a - b)
    watch = {
      recent: kept,
      samples: samples.slice(-TroubleRules.samples),
      fine,
      ...(watch.alertedAt === undefined ? {} : { alertedAt: watch.alertedAt })
    }
    const span = kept.length === 0 ? 0 : (kept.at(-1) ?? 0) - (kept[0] ?? 0)
    const due =
      watch.alertedAt === undefined &&
      kept.length >= TroubleRules.threshold &&
      (kind !== "unreachable" || span >= Duration.toMillis(TroubleRules.unreachableSpan))
    if (due) {
      alerts.push({ kind, watch })
      watch = { ...watch, alertedAt: nowMs, fine: 0 }
    }
    if (watch.recent.length > 0 || watch.alertedAt !== undefined) next[kind] = watch
  }
  return { state: next, alerts }
}

/** What the agent is told about a run of trouble with the published app. */
export const troubleReason = (kind: GatewayTrouble, url: string, watch: Watch): string => {
  const count = watch.recent.length
  const minutes = Math.max(1, Math.round(Duration.toMinutes(TroubleRules.window)))
  const list = watch.samples.map((line) => `- ${line}`).join("\n")
  return kind === "server-errors"
    ? `Your published app (${url}) answered ${count} requests with server errors in the last ${minutes} minutes, ` +
        `outside your turns, so whoever was using it saw them fail. The latest:\n${list}`
    : `${count} requests to your published app (${url}) in the last ${minutes} minutes never reached it, outside ` +
        `your turns, so whoever opened it waited on Dream's "Waking up" page. The latest:\n${list}`
}

export class ProjectLog extends Context.Service<
  ProjectLog,
  {
    /** Add entries to the log. */
    readonly append: (entries: ReadonlyArray<LogEntry>) => Effect.Effect<void>
    /** Add one entry, at the current time. */
    readonly note: (
      source: LogSource,
      level: LogLevel,
      text: string,
      more?: { readonly name?: string; readonly detail?: string }
    ) => Effect.Effect<void>
    /** The latest entries that match, oldest first. */
    readonly read: (query: LogQuery) => Effect.Effect<ReadonlyArray<LogEntry>>
    /** The gateway's requests: logged, and watched for trouble. */
    readonly requests: (requests: ReadonlyArray<GatewayRequest>) => Effect.Effect<void>
  }
>()("@dream/api/project/ProjectLog") {
  static readonly layer = Layer.effect(
    ProjectLog,
    Effect.gen(function* () {
      const store = yield* Store
      const core = yield* Core

      const append = (entries: ReadonlyArray<LogEntry>) =>
        Effect.gen(function* () {
          if (entries.length === 0) return
          if (Option.isSome(yield* store.getSingleton(...Singletons.deleted))) return
          yield* store.appendLog(entries.map(boundedLogEntry))
          const now = yield* DateTime.now
          yield* store.pruneLog(
            LogLimits.remoteEntries,
            DateTime.toEpochMillis(now) - Duration.toMillis(Duration.days(LogLimits.remoteDays))
          )
        })

      const note = (
        source: LogSource,
        level: LogLevel,
        text: string,
        more: { readonly name?: string; readonly detail?: string } = {}
      ) =>
        Effect.flatMap(DateTime.now, (at) =>
          append([
            {
              at,
              source,
              level,
              text,
              ...(more.name === undefined ? {} : { name: more.name }),
              ...(more.detail === undefined ? {} : { detail: more.detail })
            }
          ])
        )

      const read = (query: LogQuery) =>
        store.readLog(query, Math.max(1, Math.min(query.limit ?? LogLimits.read, LogLimits.read)))

      const requests = Effect.fn("ProjectLog.requests")(function* (requests: ReadonlyArray<GatewayRequest>) {
        yield* append(requests.map(requestEntry))
        if (Option.isSome(yield* store.getSingleton(...Singletons.deleted))) return
        if (Option.isSome(yield* store.getSingleton(...Singletons.archived))) return
        const project = yield* core.projectOption
        if (Option.isNone(project)) return
        const before = Option.getOrElse(yield* store.getSingleton(...TroubleSingleton), (): TroubleState => ({}))
        const now = yield* DateTime.now
        const { state, alerts } = watchRequests(
          before,
          requests,
          DateTime.toEpochMillis(now),
          (yield* core.sandbox).working
        )
        yield* store.putSingleton(...TroubleSingleton, state)
        for (const { kind, watch } of alerts) {
          const reason = troubleReason(kind, project.value.publicUrl, watch)
          yield* Effect.logInfo("the published app is in trouble; telling the agent", { kind })
          yield* note("dream", "error", `Told you: ${reason.split("\n")[0]}`)
          yield* core.enqueue(AgentEvent.cases.Alert.make({ id: yield* newEventId(), at: now, reason, noticed: kind }))
        }
      })

      return ProjectLog.of({ append, note, read, requests })
    })
  )
}
