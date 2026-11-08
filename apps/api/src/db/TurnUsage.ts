/**
 * The per-turn model usage ledger (D1 `turn_usage`): each turn's tokens and the subscription windows before and
 * after it, what it asked of the machine (memory and swap peaks, swapping, out-of-memory kills, free disk), and each scheduled task's run (`wake_id`) the same way. Written by the ProjectDO when a turn or task finishes; read to estimate each project's share of a window
 * (`usage/Shares.ts`).
 */
import {
  type MachineUse,
  ModelProvider,
  ProjectId,
  type TurnUsage,
  type UsageSnapshot,
  type UsageWindow,
  type UsageWindowName,
  UserId,
  type WakeId
} from "@dream/domain"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { TurnRecord, WindowReading } from "../usage/Shares.ts"
import { decodeRows, exec, IsoDate, nowIso, orNull } from "./Sql.ts"

const TurnUsageRow = Schema.Struct({
  id: Schema.String,
  project_id: ProjectId,
  provider: ModelProvider,
  started_at: IsoDate,
  ended_at: IsoDate,
  input_tokens: Schema.NullOr(Schema.Int),
  cache_read_tokens: Schema.NullOr(Schema.Int),
  cache_write_tokens: Schema.NullOr(Schema.Int),
  output_tokens: Schema.NullOr(Schema.Int),
  cost_usd: Schema.NullOr(Schema.Number),
  subagents: Schema.NullOr(Schema.Literals(["included", "excluded"])),
  before_observed_at: Schema.NullOr(IsoDate),
  five_hour_before_percent: Schema.NullOr(Schema.Number),
  five_hour_before_resets_at: Schema.NullOr(IsoDate),
  weekly_before_percent: Schema.NullOr(Schema.Number),
  weekly_before_resets_at: Schema.NullOr(IsoDate),
  after_observed_at: Schema.NullOr(IsoDate),
  five_hour_after_percent: Schema.NullOr(Schema.Number),
  five_hour_after_resets_at: Schema.NullOr(IsoDate),
  weekly_after_percent: Schema.NullOr(Schema.Number),
  weekly_after_resets_at: Schema.NullOr(IsoDate)
})
type TurnUsageRow = typeof TurnUsageRow.Type

/** A recorded turn, as attribution and the usage sheet read it. */
export interface LoggedTurn extends TurnRecord {
  readonly subagents?: "included" | "excluded" | undefined
}

export interface NewTurnUsage {
  readonly id: string
  readonly userId: UserId
  readonly projectId: ProjectId
  readonly provider: ModelProvider
  readonly startedAt: DateTime.Utc
  readonly endedAt: DateTime.Utc
  readonly usage?: TurnUsage | undefined
  readonly before?: UsageSnapshot | undefined
  readonly after?: UsageSnapshot | undefined
  /** A scheduled task's run (`dream wake --task`) rather than a turn of the project's own session. */
  readonly wakeId?: WakeId | undefined
  /** What it asked of the machine, when dreamd reported it. */
  readonly machine?: MachineUse | undefined
}

const ms = (at: DateTime.Utc | null): number | undefined => (at === null ? undefined : DateTime.toEpochMillis(at))

const reading = (
  observedAt: DateTime.Utc | null,
  percent: number | null,
  resetsAt: DateTime.Utc | null
): WindowReading | undefined =>
  observedAt === null || percent === null
    ? undefined
    : { usedPercent: percent, resetsAtMs: ms(resetsAt), observedAtMs: DateTime.toEpochMillis(observedAt) }

const readings = (
  observedAt: DateTime.Utc | null,
  fiveHour: readonly [number | null, DateTime.Utc | null],
  weekly: readonly [number | null, DateTime.Utc | null]
): Partial<Record<UsageWindowName, WindowReading>> => {
  const five = reading(observedAt, ...fiveHour)
  const week = reading(observedAt, ...weekly)
  return { ...(five === undefined ? {} : { fiveHour: five }), ...(week === undefined ? {} : { weekly: week }) }
}

const toLoggedTurn = (row: TurnUsageRow): LoggedTurn => ({
  id: row.id,
  projectId: row.project_id,
  startedMs: DateTime.toEpochMillis(row.started_at),
  endedMs: DateTime.toEpochMillis(row.ended_at),
  ...(row.input_tokens === null ||
  row.cache_read_tokens === null ||
  row.cache_write_tokens === null ||
  row.output_tokens === null
    ? {}
    : {
        tokens: {
          input: row.input_tokens,
          cacheRead: row.cache_read_tokens,
          cacheWrite: row.cache_write_tokens,
          output: row.output_tokens
        }
      }),
  ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
  ...(row.subagents === null ? {} : { subagents: row.subagents }),
  before: readings(
    row.before_observed_at,
    [row.five_hour_before_percent, row.five_hour_before_resets_at],
    [row.weekly_before_percent, row.weekly_before_resets_at]
  ),
  after: readings(
    row.after_observed_at,
    [row.five_hour_after_percent, row.five_hour_after_resets_at],
    [row.weekly_after_percent, row.weekly_after_resets_at]
  )
})

const isoOrNull = (at: DateTime.Utc | undefined): string | null => (at === undefined ? null : DateTime.formatIso(at))

const windowColumns = (window: UsageWindow | undefined) =>
  [orNull(window?.usedPercent), isoOrNull(window?.resetsAt)] as const

export class TurnUsageLog extends Context.Service<
  TurnUsageLog,
  {
    readonly record: (turn: NewTurnUsage) => Effect.Effect<void>
    /** Their turns on `provider` that ended at or after `since`, every project's, oldest first. */
    readonly since: (
      userId: UserId,
      provider: ModelProvider,
      since: DateTime.Utc
    ) => Effect.Effect<ReadonlyArray<LoggedTurn>>
  }
>()("@dream/api/TurnUsageLog") {
  static readonly layer = Layer.effect(
    TurnUsageLog,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const record = Effect.fn("TurnUsageLog.record")(function* (turn: NewTurnUsage) {
        const now = yield* nowIso
        const tokens = turn.usage?.tokens
        const machine = turn.machine
        const [fiveBefore, fiveBeforeResets] = windowColumns(turn.before?.fiveHour)
        const [weekBefore, weekBeforeResets] = windowColumns(turn.before?.weekly)
        const [fiveAfter, fiveAfterResets] = windowColumns(turn.after?.fiveHour)
        const [weekAfter, weekAfterResets] = windowColumns(turn.after?.weekly)
        yield* exec(sql`
          INSERT INTO turn_usage (id, user_id, project_id, provider, started_at, ended_at,
            input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, subagents,
            before_observed_at, five_hour_before_percent, five_hour_before_resets_at, weekly_before_percent,
            weekly_before_resets_at, after_observed_at, five_hour_after_percent, five_hour_after_resets_at,
            weekly_after_percent, weekly_after_resets_at, wake_id, mem_peak_mb, mem_total_mb, swap_peak_mb,
            swap_total_mb, swap_in_pages, swap_out_pages, oom_kills, disk_free_mb, created_at)
          VALUES (${turn.id}, ${turn.userId}, ${turn.projectId}, ${turn.provider},
            ${DateTime.formatIso(turn.startedAt)}, ${DateTime.formatIso(turn.endedAt)},
            ${orNull(tokens?.input)}, ${orNull(tokens?.cacheRead)}, ${orNull(tokens?.cacheWrite)},
            ${orNull(tokens?.output)}, ${orNull(turn.usage?.costUsd)}, ${orNull(turn.usage?.subagents)},
            ${isoOrNull(turn.before?.observedAt)}, ${fiveBefore}, ${fiveBeforeResets}, ${weekBefore},
            ${weekBeforeResets}, ${isoOrNull(turn.after?.observedAt)}, ${fiveAfter}, ${fiveAfterResets},
            ${weekAfter}, ${weekAfterResets}, ${orNull(turn.wakeId)}, ${orNull(machine?.memoryPeakMb)},
            ${orNull(machine?.memoryTotalMb)}, ${orNull(machine?.swapPeakMb)}, ${orNull(machine?.swapTotalMb)},
            ${orNull(machine?.swapInPages)}, ${orNull(machine?.swapOutPages)}, ${orNull(machine?.oomKills)},
            ${orNull(machine?.diskFreeMb)}, ${now})
          ON CONFLICT (id) DO NOTHING`)
      })

      const since = (userId: UserId, provider: ModelProvider, from: DateTime.Utc) =>
        sql`SELECT * FROM turn_usage WHERE user_id = ${userId} AND provider = ${provider}
            AND ended_at >= ${DateTime.formatIso(from)} ORDER BY started_at`.pipe(
          decodeRows(TurnUsageRow),
          Effect.map((rows) => rows.map(toLoggedTurn))
        )

      return TurnUsageLog.of({ record, since })
    })
  )
}
