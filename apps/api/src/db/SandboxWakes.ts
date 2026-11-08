/**
 * Why a project's sandbox was used between turns (D1 `sandbox_wakes`): the ProjectDO notes each time it hands dreamd
 * events, a scheduled command or task, sends a visit to the published app, forwards a relay's delivery, or refreshes
 * or moves the sandbox, while no turn runs. Each of these resumes a paused sandbox, so set beside E2B's runs (which
 * say when it ran, not why) they tell a project's machine time apart by cause. Read by
 * `packages/sandbox-template/scripts/resource-review.ts`.
 */
import type { ProjectId } from "@dream/domain"
import { Clock, Context, DateTime, Duration, Effect, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { randomToken } from "../lib/Ids.ts"
import { exec } from "./Sql.ts"

export const WakeReason = Schema.Literals([
  /** Events for the agent: a message, an answer, an alert, a wake without a command. */
  "delivery",
  /** A scheduled `--run` command, which starts no turn when it succeeds. */
  "wake-run",
  /** A scheduled task, which runs in a session of its own. */
  "wake-task",
  /** The gateway sent a visit to the published app. */
  "visit",
  /** A relay's events, posted to the app. */
  "relay",
  "refresh",
  "move"
])
export type WakeReason = typeof WakeReason.Type

/** One row per project and reason within this; the gateway asks about visits at most once a minute anyway. */
export const WakeLogEvery = Duration.minutes(1)
/** How long rows are kept. */
export const WakeRetention = Duration.days(30)

export class SandboxWakes extends Context.Service<
  SandboxWakes,
  {
    /** Never fails: the log must not break what it describes. */
    readonly record: (projectId: ProjectId, reason: WakeReason, detail?: string) => Effect.Effect<void>
    /** Drops rows older than `WakeRetention` (the hourly job). */
    readonly prune: Effect.Effect<void>
  }
>()("@dream/api/SandboxWakes") {
  static readonly layer = Layer.effect(
    SandboxWakes,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const last = yield* Ref.make(new Map<string, number>())

      const record = (projectId: ProjectId, reason: WakeReason, detail?: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const key = `${projectId} ${reason}`
          const previous = (yield* Ref.get(last)).get(key)
          if (previous !== undefined && now - previous < Duration.toMillis(WakeLogEvery)) return
          yield* Ref.update(last, (map) => new Map(map).set(key, now))
          yield* exec(sql`
            INSERT INTO sandbox_wakes (id, project_id, at, reason, detail)
            VALUES (${`swk_${randomToken(22)}`}, ${projectId}, ${DateTime.formatIso(DateTime.makeUnsafe(now))},
              ${reason}, ${detail ?? null})`)
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't log the sandbox's wake", { cause })))

      const prune = Effect.gen(function* () {
        const cutoff = DateTime.subtractDuration(yield* DateTime.now, WakeRetention)
        yield* exec(sql`DELETE FROM sandbox_wakes WHERE at < ${DateTime.formatIso(cutoff)}`)
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("couldn't prune sandbox_wakes", { cause })))

      return SandboxWakes.of({ record, prune })
    })
  )
}
