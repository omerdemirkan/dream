/**
 * How hard each sandbox worked (D1 `sandbox_usage`): once an hour, E2B's metrics for every sandbox that ran in the
 * last few hours, rolled up per sandbox and UTC hour (CPU average and peak, memory used, disk). E2B answers a short
 * span in 30-second to one-minute samples but keeps nothing once a sandbox is killed, so this is the record sizing
 * questions are answered from: is a large sandbox ever using what it pays for, does a standard one hit its memory.
 * Each run rewrites the hours it read, so an hour read while it was still going is completed by the next run.
 */
import { Context, DateTime, Duration, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { exec, nowIso } from "../db/Sql.ts"
import { attribute, E2BEvents, type ListedSandbox, type MetricSample } from "./E2BEvents.ts"

/** How far back each run reads: the hour before last, the last one, and this one so far. */
export const UsageLookback = Duration.hours(2)

const Mb = 1024 * 1024
const HourMs = 3_600_000

export interface UsageHour {
  readonly hour: string
  readonly samples: number
  readonly cpuAvgPct: number
  readonly cpuMaxPct: number
  readonly memAvgMb: number
  readonly memMaxMb: number
  readonly diskUsedMaxMb: number
  readonly diskTotalMb: number
}

/** `samples` grouped by the UTC hour they fell in, oldest first. */
export const rollUp = (samples: ReadonlyArray<MetricSample>): ReadonlyArray<UsageHour> => {
  const hours = new Map<number, Array<MetricSample>>()
  for (const sample of samples) {
    const hour = Math.floor((sample.timestampUnix * 1000) / HourMs) * HourMs
    const list = hours.get(hour) ?? []
    list.push(sample)
    hours.set(hour, list)
  }
  return [...hours.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, list]) => {
      const sum = (f: (s: MetricSample) => number) => list.reduce((total, s) => total + f(s), 0)
      const max = (f: (s: MetricSample) => number) => Math.max(...list.map(f))
      return {
        hour: new Date(hour).toISOString(),
        samples: list.length,
        cpuAvgPct: sum((s) => s.cpuUsedPct) / list.length,
        cpuMaxPct: max((s) => s.cpuUsedPct),
        memAvgMb: sum((s) => s.memUsed) / list.length / Mb,
        memMaxMb: max((s) => s.memUsed) / Mb,
        diskUsedMaxMb: max((s) => s.diskUsed) / Mb,
        diskTotalMb: max((s) => s.diskTotal) / Mb
      }
    })
}

/** Whether a listed sandbox may have run since `sinceMs`: running now, or paused after it. */
export const ranSince = (sandbox: ListedSandbox, sinceMs: number): boolean => {
  if (sandbox.state !== "paused") return true
  const pausedAt = sandbox.endAt === undefined || sandbox.endAt === null ? Number.NaN : Date.parse(sandbox.endAt)
  return Number.isNaN(pausedAt) || pausedAt >= sinceMs
}

export class SandboxUsage extends Context.Service<
  SandboxUsage,
  {
    /** Reads the metrics of every sandbox that ran in the last `UsageLookback` and keeps them per hour. */
    readonly hourly: Effect.Effect<void>
  }
>()("@dream/api/metering/SandboxUsage") {
  static readonly layer = Layer.effect(
    SandboxUsage,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const events = yield* E2BEvents

      const recordSandbox = (sandbox: ListedSandbox, startMs: number, endMs: number) =>
        Effect.gen(function* () {
          const samples = yield* events.metrics(sandbox.sandboxID, startMs / 1000, endMs / 1000)
          const who = attribute(sandbox.metadata ?? {})
          const recordedAt = yield* nowIso
          for (const hour of rollUp(samples)) {
            yield* exec(sql`
              INSERT INTO sandbox_usage (sandbox_id, hour, project_id, cause, vcpus, memory_mb, samples, cpu_avg_pct,
                cpu_max_pct, mem_avg_mb, mem_max_mb, disk_used_max_mb, disk_total_mb, recorded_at)
              VALUES (${sandbox.sandboxID}, ${hour.hour}, ${who.project ?? null}, ${who.cause},
                ${sandbox.cpuCount}, ${sandbox.memoryMB}, ${hour.samples}, ${hour.cpuAvgPct}, ${hour.cpuMaxPct},
                ${hour.memAvgMb}, ${hour.memMaxMb}, ${hour.diskUsedMaxMb}, ${hour.diskTotalMb}, ${recordedAt})
              ON CONFLICT (sandbox_id, hour) DO UPDATE SET samples = excluded.samples,
                cpu_avg_pct = excluded.cpu_avg_pct, cpu_max_pct = excluded.cpu_max_pct,
                mem_avg_mb = excluded.mem_avg_mb, mem_max_mb = excluded.mem_max_mb,
                disk_used_max_mb = excluded.disk_used_max_mb, disk_total_mb = excluded.disk_total_mb,
                recorded_at = excluded.recorded_at
              WHERE excluded.samples >= sandbox_usage.samples`)
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("couldn't read a sandbox's metrics", {
              sandboxId: sandbox.sandboxID,
              error: error.message
            })
          )
        )

      const hourly = Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now)
        const startMs = Math.floor(nowMs / HourMs) * HourMs - Duration.toMillis(UsageLookback)
        const listed = yield* events.sandboxes
        const recent = listed.filter((sandbox) => ranSince(sandbox, startMs))
        yield* Effect.forEach(recent, (sandbox) => recordSandbox(sandbox, startMs, nowMs), {
          concurrency: 4,
          discard: true
        })
        yield* Effect.logInfo("recorded sandbox usage", { sandboxes: recent.length, listed: listed.length })
      }).pipe(
        Effect.catch((error) => Effect.logWarning("sandbox usage failed", error.message)),
        Effect.withSpan("SandboxUsage.hourly")
      )

      return SandboxUsage.of({ hourly })
    })
  )
}
