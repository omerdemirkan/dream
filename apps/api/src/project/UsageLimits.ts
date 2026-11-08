/**
 * The usage limits they set on a project (`AppRpcs.SetUsageLimits`): a cap on its own share of the plan's week, and
 * a floor on what's left of the plan. Reaching either pauses the project the way the plan's own limit does (the
 * usage pause in `Core`, which holds deliveries, scheduled wakes and relays): the turn under way finishes, dreamd
 * starts nothing more (`SandboxManager.holdTurns`), and their phone hears which limit and how to go on. It lasts
 * until they raise or clear the limit, or the week resets with the limit no longer reached; then what waited is
 * delivered.
 *
 * Limits are checked wherever a reading arrives (`check`): dreamd's usage reports (a turn's first model call, and
 * the end of each turn and task), a finished turn or task (its share is credited then), a reading from another of
 * their projects (the plan's week moved; `ProjectDirectory.usageChanged`), a change of limits, and the week's reset.
 * Shares are estimates (`usage/Shares.ts`), and one turn's use is only known when it ends, so a project can run
 * past a limit by what its last turn used.
 */
import {
  AgentEvent,
  type NotificationId,
  type Project,
  reachedLimit,
  type UsageLimitReached,
  type UsageLimits,
  type UsageLimitStanding
} from "@dream/domain"
import { Clock, Context, DateTime, Effect, Layer, Option, Semaphore } from "effect"
import { Users } from "../db/Users.ts"
import { newEventId, newNotificationId } from "../lib/Ids.ts"
import { UsageReport } from "../usage/ProjectUsage.ts"
import { Alarm } from "./Alarm.ts"
import { Core } from "./Core.ts"
import { Notifier } from "./Notifier.ts"
import { SandboxManager } from "./SandboxManager.ts"
import { Singletons, Store, type UsagePause } from "./Store.ts"

/** When a limit is reached but the week's reset isn't known: look again then. */
const UnknownResetRecheck = { days: 1 } as const

/** "Mon 8 AM", "Mon 8:30 AM", in their time zone. */
export const resetLabel = (at: DateTime.Utc, timeZone: string): string => {
  const options = (zone: string | undefined): Intl.DateTimeFormatOptions => ({
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    ...(zone === undefined ? {} : { timeZone: zone })
  })
  const format = (zone: string | undefined) =>
    new Intl.DateTimeFormat("en-US", options(zone)).format(DateTime.toDateUtc(at)).replace(/:00(?=\s)/u, "")
  try {
    return format(timeZone)
  } catch {
    return format("UTC")
  }
}

/** What their phone says when a limit pauses the project. The project's title is the notification's. */
export const pausedNotice = (
  reached: UsageLimitReached,
  project: Pick<Project, "harness">,
  resetsAt: DateTime.Utc | undefined,
  timeZone: string
): string => {
  const plan = project.harness === "codex" ? "ChatGPT" : "Claude"
  const after =
    resetsAt === undefined
      ? "or it picks up when your week resets."
      : `or it picks up when your week resets, ${resetLabel(resetsAt, timeZone)}.`
  return reached.limit === "project"
    ? `Paused after using the ${reached.percent}% of your week you gave it. Raise or clear the limit to carry on, ${after}`
    : `Paused to keep the last ${reached.percent}% of your ${plan} week free. Lower or clear the limit to carry on, ${after}`
}

const sameLimits = (a: UsageLimits, b: UsageLimits) =>
  a.projectWeekPercent === b.projectWeekPercent && a.planLeftPercent === b.planLeftPercent

export class UsageLimiter extends Context.Service<
  UsageLimiter,
  {
    /** `dream usage`: the limits and where the project stands against them. */
    readonly standing: Effect.Effect<UsageLimitStanding>
    /** They set new limits: stored, the agent hears, and the project pauses or goes on to match. */
    readonly set: (limits: UsageLimits) => Effect.Effect<void>
    /** A reading arrived, or time passed: pause the project at a limit reached, or let it go on. */
    readonly check: Effect.Effect<void>
  }
>()("@dream/api/project/UsageLimiter") {
  static readonly layer = Layer.effect(
    UsageLimiter,
    Effect.gen(function* () {
      const core = yield* Core
      const store = yield* Store
      const alarm = yield* Alarm
      const sandbox = yield* SandboxManager
      const notifier = yield* Notifier
      const report = yield* UsageReport
      const users = yield* Users
      const lock = yield* Semaphore.make(1)

      const timeZoneOf = (project: Project) =>
        Effect.map(users.find(project.ownerId), (user) =>
          Option.match(user, { onNone: () => "UTC", onSome: (u) => u.timeZone ?? "UTC" })
        )

      /** The pause in force now, if any. */
      const activePause = Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis
        return Option.filter(yield* core.usagePause, (pause) => DateTime.toEpochMillis(pause.until) > nowMs)
      })

      const resume = (pause: UsagePause) =>
        Effect.gen(function* () {
          yield* core.saveUsagePause(Option.none())
          yield* store.clearTimer("usage-reset")
          // Deliver whatever waited; delivering tells dreamd the hold is over.
          yield* store.setTimer("deliver", yield* Clock.currentTimeMillis)
          yield* alarm.reschedule
          if (pause.notificationId !== undefined) yield* notifier.withdraw([pause.notificationId])
          yield* Effect.logInfo("a usage limit no longer holds the project", { limit: pause.limit })
        })

      const pauseAt = (reached: UsageLimitReached, until: DateTime.Utc, current: UsagePause | undefined) =>
        Effect.gen(function* () {
          const fresh = current?.limit?.limit !== reached.limit
          const notificationId: NotificationId | undefined = fresh
            ? yield* newNotificationId()
            : current?.notificationId
          yield* core.saveUsagePause(
            Option.some({
              window: "weekly",
              until,
              wakeOnReset: false,
              limit: reached,
              ...(notificationId === undefined ? {} : { notificationId })
            })
          )
          yield* store.setTimer("usage-reset", DateTime.toEpochMillis(until))
          yield* alarm.reschedule
          yield* sandbox.holdTurns(true)
          if (!fresh || notificationId === undefined) return
          if (current?.notificationId !== undefined) yield* notifier.withdraw([current.notificationId])
          const project = yield* core.project.pipe(Effect.orDie)
          const week = yield* report.week(project)
          yield* notifier.alertUsage(
            notificationId,
            pausedNotice(reached, project, week?.resetsAt, yield* timeZoneOf(project))
          )
          yield* Effect.logInfo("a usage limit paused the project", { limit: reached })
        })

      const checkNow = Effect.gen(function* () {
        if (Option.isSome(yield* store.getSingleton(...Singletons.deleted))) return
        const project = yield* core.projectOption
        if (Option.isNone(project)) return
        const pause = yield* core.usagePause
        const active = yield* activePause
        // The plan's own limit holds it; its reset checks again.
        if (Option.isSome(active) && active.value.limit === undefined) return
        const limits = yield* core.usageLimits
        const week =
          limits.projectWeekPercent === undefined && limits.planLeftPercent === undefined
            ? undefined
            : yield* report.week(project.value)
        const reached = reachedLimit(limits, week)
        if (reached === undefined) {
          if (Option.isSome(pause) && pause.value.limit !== undefined) yield* resume(pause.value)
          return
        }
        const until = week?.resetsAt ?? DateTime.add(yield* DateTime.now, UnknownResetRecheck)
        const current = Option.getOrUndefined(active)
        const unchanged =
          current?.limit?.limit === reached.limit &&
          current.limit.percent === reached.percent &&
          (week?.resetsAt === undefined || DateTime.toEpochMillis(current.until) === DateTime.toEpochMillis(until))
        if (unchanged) return
        yield* pauseAt(reached, until, current)
      })

      const check = lock
        .withPermits(1)(checkNow)
        .pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't check the usage limits", { cause })))

      const set = Effect.fn("UsageLimiter.set")(function* (limits: UsageLimits) {
        const previous = yield* core.usageLimits
        if (sameLimits(previous, limits)) return
        yield* core.saveUsageLimits(limits)
        const project = yield* core.project.pipe(Effect.orDie)
        const week = yield* report.week(project)
        yield* core.enqueue(
          AgentEvent.cases.UsageLimitsChanged.make({
            id: yield* newEventId(),
            at: yield* DateTime.now,
            limits,
            previous,
            ...(week === undefined ? {} : { week })
          })
        )
        yield* check
      })

      const standing = Effect.gen(function* () {
        const limits = yield* core.usageLimits
        const project = yield* core.project.pipe(Effect.orDie)
        const week = yield* report.week(project)
        const reached = Option.flatMap(yield* activePause, (pause) => Option.fromUndefinedOr(pause.limit))
        return {
          limits,
          ...(week === undefined ? {} : { week }),
          ...(Option.isSome(reached) ? { reached: reached.value } : {})
        }
      })

      return UsageLimiter.of({ standing, set, check })
    })
  )
}
