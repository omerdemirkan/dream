/**
 * Each rented Mac's activity log (D1 `mac_activity`): its start, the agent's status checks and ssh sessions,
 * deadline extensions, what the ProjectDO saw running on it at each check (`project/MacProbe.ts`), and its stop with
 * the reason and Namespace's own end time. Written by the ProjectDO as it happens; read by operators
 * (GET /admin/macs/activity), so what a Mac cost can be told apart into work, idle tails and time held open.
 */
import { ProjectId } from "@dream/domain"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { randomToken } from "../lib/Ids.ts"
import { MacProbe } from "../brokers/MacProbe.ts"
import { decodeRows, encodeJson, exec, IsoDate, jsonCodec } from "./Sql.ts"

export const MacStopReason = Schema.Literals([
  /** `dream mac stop`. */
  "explicit",
  /** Nothing used it for the idle timeout. */
  "idle",
  /** The turn ended with nothing running on the Mac and nothing due soon. */
  "turn-ended",
  /** Namespace destroyed it at its deadline (the workspace's policy caps a Mac's lifetime). */
  "deadline",
  /** Namespace destroyed it before its deadline. */
  "provider-gone",
  "archived",
  "deleted"
])
export type MacStopReason = typeof MacStopReason.Type

export const MacActivity = Schema.TaggedUnion({
  Start: {
    /** What Namespace set (its policy can shorten what Dream asked for). */
    deadline: Schema.optionalKey(Schema.DateTimeUtc),
    /** From asking for the Mac to its running, as Dream waited for it. */
    bootMs: Schema.Int
  },
  /** `dream mac`: no longer counts as using it. */
  Status: {},
  /** `dream mac ssh` or `dream mac cp` got credentials: the agent runs a command now. */
  Ssh: { count: Schema.Int },
  Extend: {
    trigger: Schema.Literals(["ssh", "busy"]),
    deadline: Schema.optionalKey(Schema.DateTimeUtc),
    failure: Schema.optionalKey(Schema.String)
  },
  Probe: {
    probe: Schema.optionalKey(MacProbe),
    failure: Schema.optionalKey(Schema.String),
    /** How long the probe took. */
    ms: Schema.Int
  },
  Stop: {
    reason: MacStopReason,
    /** Namespace's `destroyedAt` when it gave one (`endedBy: namespace`), else when Dream saw it end. */
    endedAt: Schema.DateTimeUtc,
    endedBy: Schema.Literals(["namespace", "dream"]),
    /** What was metered: creation to destruction. */
    ms: Schema.Int,
    /** From its last use (a start, an ssh session, a busy probe) to its end: the idle tail. */
    idleMs: Schema.Int
  }
})
export type MacActivity = typeof MacActivity.Type

const MacActivityRow = Schema.Struct({
  project_id: ProjectId,
  instance_id: Schema.String,
  at: IsoDate,
  detail_json: jsonCodec(MacActivity)
})

export type MacActivityFilter =
  | { readonly instanceId: string }
  | { readonly projectId: ProjectId; readonly since: DateTime.Utc }

export interface MacActivityEntry {
  readonly projectId: ProjectId
  readonly instanceId: string
  readonly at: DateTime.Utc
  readonly activity: MacActivity
}

export class MacActivityLog extends Context.Service<
  MacActivityLog,
  {
    /** Never fails: the log must not break the Mac it describes. */
    readonly record: (entry: MacActivityEntry) => Effect.Effect<void>
    /** One Mac's entries, or every Mac's of a project since `since`, oldest first. */
    readonly read: (filter: MacActivityFilter) => Effect.Effect<ReadonlyArray<MacActivityEntry>>
  }
>()("@dream/api/MacActivityLog") {
  static readonly layer = Layer.effect(
    MacActivityLog,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const record = (entry: MacActivityEntry) =>
        exec(sql`
          INSERT INTO mac_activity (id, project_id, instance_id, at, kind, busy, reason, detail_json)
          VALUES (${`mac_${randomToken(22)}`}, ${entry.projectId}, ${entry.instanceId},
            ${DateTime.formatIso(entry.at)}, ${entry.activity._tag.toLowerCase()},
            ${entry.activity._tag === "Probe" && entry.activity.probe !== undefined ? (entry.activity.probe.busy ? 1 : 0) : null},
            ${entry.activity._tag === "Stop" ? entry.activity.reason : null}, ${encodeJson(MacActivity, entry.activity)})`).pipe(
          Effect.catchCause((cause) => Effect.logWarning("couldn't log the Mac's activity", { cause }))
        )

      const read = (filter: MacActivityFilter) =>
        ("instanceId" in filter
          ? sql`SELECT project_id, instance_id, at, detail_json FROM mac_activity
                WHERE instance_id = ${filter.instanceId} ORDER BY at`
          : sql`SELECT project_id, instance_id, at, detail_json FROM mac_activity
                WHERE project_id = ${filter.projectId} AND at >= ${DateTime.formatIso(filter.since)} ORDER BY at`
        ).pipe(
          decodeRows(MacActivityRow),
          Effect.map((rows) =>
            rows.map((row) => ({
              projectId: row.project_id,
              instanceId: row.instance_id,
              at: row.at,
              activity: row.detail_json
            }))
          )
        )

      return MacActivityLog.of({ record, read })
    })
  )
}

/** One Mac's life from its log: what it was metered, and how much of that was work, idle tail, or busy at a check. */
export interface MacSummary {
  readonly instanceId: string
  readonly projectId: ProjectId
  readonly startedAt?: string | undefined
  readonly endedAt?: string | undefined
  readonly reason?: MacStopReason | undefined
  readonly minutes?: number | undefined
  readonly idleTailMinutes?: number | undefined
  readonly sshSessions: number
  readonly statusChecks: number
  readonly probes: number
  readonly busyProbes: number
  /** When a check last saw it busy, or an ssh session started. */
  readonly lastUsedAt?: string | undefined
  readonly tools: ReadonlyArray<string>
}

const minutes = (ms: number) => Math.round(ms / 6000) / 10

export const summarizeMacs = (entries: ReadonlyArray<MacActivityEntry>): ReadonlyArray<MacSummary> => {
  const byInstance = new Map<string, Array<MacActivityEntry>>()
  for (const entry of entries) byInstance.set(entry.instanceId, [...(byInstance.get(entry.instanceId) ?? []), entry])
  return [...byInstance.entries()].map(([instanceId, log]) => {
    const start = log.find((e) => e.activity._tag === "Start")
    const stop = log.find((e) => e.activity._tag === "Stop")?.activity
    const used = log.filter(
      (e) =>
        e.activity._tag === "Start" ||
        e.activity._tag === "Ssh" ||
        (e.activity._tag === "Probe" && e.activity.probe?.busy === true)
    )
    const probes = log.flatMap((e) => (e.activity._tag === "Probe" && e.activity.probe ? [e.activity.probe] : []))
    return {
      instanceId,
      projectId: log[0]!.projectId,
      startedAt: start === undefined ? undefined : DateTime.formatIso(start.at),
      endedAt: stop?._tag === "Stop" ? DateTime.formatIso(stop.endedAt) : undefined,
      reason: stop?._tag === "Stop" ? stop.reason : undefined,
      minutes: stop?._tag === "Stop" ? minutes(stop.ms) : undefined,
      idleTailMinutes: stop?._tag === "Stop" ? minutes(stop.idleMs) : undefined,
      sshSessions: log.filter((e) => e.activity._tag === "Ssh").length,
      statusChecks: log.filter((e) => e.activity._tag === "Status").length,
      probes: probes.length,
      busyProbes: probes.filter((p) => p.busy).length,
      lastUsedAt: used.length === 0 ? undefined : DateTime.formatIso(used[used.length - 1]!.at),
      tools: [...new Set(probes.flatMap((p) => p.tools))].sort()
    }
  })
}
