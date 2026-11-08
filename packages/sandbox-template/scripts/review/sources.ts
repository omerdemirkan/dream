/**
 * Where the resource review's data comes from, read-only: Dream's D1 (the ledger, turns, Macs' activity, projects,
 * and the telemetry in `sandbox_usage` and `sandbox_wakes`), E2B (the sandboxes now, their metrics, its lifecycle
 * log), Browserbase's sessions, Namespace's instances, and R2's bucket sizes. Each goes through the workspace's
 * connections (`cloudflare-api`, `e2b-api`, `browserbase-api`, `namespace-compute`), which add the credentials;
 * nothing here holds or prints one. E2B's sandbox detail (`GET /sandboxes/{id}`) carries the egress rules with the
 * person's credentials in them, so it is never called: the list and the metrics carry what the review needs.
 *
 * A source that can't be read is left out and named in `missing`, so the review still runs on the rest.
 */
import { Schema } from "effect"
import type {
  BrowserSession,
  Bucket,
  E2BRun,
  Inputs,
  LedgerRow,
  LiveMac,
  LiveSandbox,
  LoadPoint,
  MacEntry,
  ProjectInfo,
  Turn,
  TurnMachine,
  WakeNote
} from "./analyze.ts"

const Account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "2d98de7c4511e98d2f774c4fcc9b9b93"
const E2bApi = process.env.E2B_API_URL ?? "https://api.e2b.app"
const NamespaceApi = process.env.NAMESPACE_API_URL ?? "https://us.compute.namespaceapis.com"
const Mb = 1024 * 1024
/** D1 tables that grow with use, counted for the storage line. */
const GrowingTables = [
  "meter_events",
  "turn_usage",
  "mac_activity",
  "notifications",
  "openai_objects",
  "media",
  "attachments"
]
const DayMs = 86_400_000

const getJson = async (url: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${new URL(url).host}${new URL(url).pathname}: HTTP ${response.status}`)
  return response.json()
}
const cloudflare = (path: string, init?: RequestInit) =>
  getJson(`https://api.cloudflare.com/client/v4/accounts/${Account}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  })
const e2b = (path: string) => getJson(`${E2bApi}${path}`)

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

const D1List = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({ uuid: Schema.String, name: Schema.String, file_size: Schema.optionalKey(Schema.Finite) })
  )
})
const D1Result = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.String }))),
  result: Schema.optionalKey(Schema.Array(Schema.Struct({ results: Schema.Array(Schema.Unknown) })))
})

interface Database {
  readonly id: string
  readonly bytes: number | undefined
}

const findDatabase = async (): Promise<Database> => {
  const list = Schema.decodeUnknownSync(D1List)(await cloudflare("/d1/database?per_page=100"))
  const found = list.result.find((d) => d.name.startsWith("Dream-Database-prod"))
  if (found === undefined) throw new Error("no Dream-Database-prod in the account")
  return { id: found.uuid, bytes: found.file_size }
}

/** A read-only query (the review only ever SELECTs). */
const query = async <S extends Schema.Top>(
  database: Database,
  row: S,
  sql: string,
  params: ReadonlyArray<string> = []
): Promise<ReadonlyArray<S["Type"]>> => {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error("the review only reads")
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${Account}/d1/database/${database.id}/query`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql, params })
    }
  )
  const body = Schema.decodeUnknownSync(D1Result)(await response.json())
  if (!body.success) throw new Error(body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${response.status}`)
  const decode = Schema.decodeUnknownSync(row as unknown as Schema.Codec<S["Type"], unknown>)
  return (body.result?.[0]?.results ?? []).map((r) => decode(r))
}

const JsonRecord = <V extends Schema.Top>(value: V) => Schema.fromJsonString(Schema.Record(Schema.String, value))
const Ms = (iso: string) => Date.parse(iso)

const LedgerSql = Schema.Struct({
  id: Schema.String,
  meter: Schema.String,
  at: Schema.String,
  project_id: Schema.NullOr(Schema.String),
  center: Schema.String,
  cost_usd: Schema.Finite,
  quantities_json: JsonRecord(Schema.Finite),
  dimensions_json: JsonRecord(Schema.String)
})
/** The turn's machine summary from dreamd (agent-logs branch); absent before it, null for turns without one. */
const MachineColumn = Schema.optionalKey(Schema.NullOr(Schema.Finite))
const TurnSql = Schema.Struct({
  project_id: Schema.String,
  started_at: Schema.String,
  ended_at: Schema.String,
  output_tokens: Schema.NullOr(Schema.Finite),
  wake_id: Schema.NullOr(Schema.String),
  mem_peak_mb: MachineColumn,
  mem_total_mb: MachineColumn,
  swap_peak_mb: MachineColumn,
  swap_total_mb: MachineColumn,
  swap_in_pages: MachineColumn,
  swap_out_pages: MachineColumn,
  oom_kills: MachineColumn,
  disk_free_mb: MachineColumn
})
const ProjectSql = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  archived_at: Schema.NullOr(Schema.String),
  sandbox_id: Schema.NullOr(Schema.String)
})
const MacSql = Schema.Struct({
  instance_id: Schema.String,
  project_id: Schema.String,
  at: Schema.String,
  kind: Schema.String,
  busy: Schema.NullOr(Schema.Finite),
  reason: Schema.NullOr(Schema.String),
  detail_json: JsonRecord(Schema.Unknown)
})
const WakeSql = Schema.Struct({
  project_id: Schema.String,
  at: Schema.String,
  reason: Schema.String,
  detail: Schema.NullOr(Schema.String)
})
const UsageSql = Schema.Struct({
  sandbox_id: Schema.String,
  hour: Schema.String,
  project_id: Schema.NullOr(Schema.String),
  vcpus: Schema.Finite,
  memory_mb: Schema.Finite,
  cpu_max_pct: Schema.Finite,
  mem_max_mb: Schema.Finite,
  disk_used_max_mb: Schema.Finite,
  disk_total_mb: Schema.Finite
})

// ---------------------------------------------------------------------------
// E2B, Browserbase, Namespace, R2
// ---------------------------------------------------------------------------

const Nullish = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))
const Listed = Schema.Array(
  Schema.Struct({
    sandboxID: Schema.String,
    state: Schema.String,
    startedAt: Schema.String,
    endAt: Nullish(Schema.String),
    cpuCount: Schema.Finite,
    memoryMB: Schema.Finite,
    diskSizeMB: Nullish(Schema.Finite),
    metadata: Nullish(Schema.Record(Schema.String, Schema.String))
  })
)
const Metrics = Schema.Array(
  Schema.Struct({
    timestampUnix: Schema.Finite,
    cpuUsedPct: Schema.Finite,
    memUsed: Schema.Finite,
    diskUsed: Schema.Finite,
    diskTotal: Schema.Finite
  })
)
const LogEvents = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    sandboxId: Schema.String,
    timestamp: Schema.String,
    eventData: Nullish(
      Schema.Struct({
        sandbox_metadata: Nullish(Schema.Record(Schema.String, Schema.String)),
        execution: Nullish(
          Schema.Struct({ execution_time: Schema.Finite, memory_mb: Schema.Finite, vcpu_count: Schema.Finite })
        )
      })
    )
  })
)
const Sessions = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    startedAt: Schema.String,
    endedAt: Nullish(Schema.String),
    userMetadata: Nullish(Schema.Record(Schema.String, Schema.Unknown))
  })
)
const Instances = Schema.Struct({
  instances: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        instanceId: Schema.String,
        createdAt: Schema.String,
        deadline: Schema.optionalKey(Schema.String),
        documentedPurpose: Schema.optionalKey(Schema.String),
        shape: Schema.optionalKey(Schema.Struct({ virtualCpu: Schema.optionalKey(Schema.Finite) })),
        labels: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })))
      })
    )
  )
})
const BucketList = Schema.Struct({
  result: Schema.Struct({ buckets: Schema.Array(Schema.Struct({ name: Schema.String })) })
})
const BucketUsage = Schema.Struct({
  result: Schema.Struct({ payloadSize: Schema.String, objectCount: Schema.String })
})

/** E2B's paused and killed events since `sinceMs`, newest first, as runs. */
const readLog = async (sinceMs: number): Promise<ReadonlyArray<E2BRun>> => {
  const runs = new Map<string, E2BRun>()
  for (let page = 0; page < 200; page++) {
    const batch = Schema.decodeUnknownSync(LogEvents)(
      await e2b(
        `/events/sandboxes?limit=100&offset=${page * 100}&types=sandbox.lifecycle.paused&types=sandbox.lifecycle.killed`
      )
    )
    for (const event of batch) {
      const execution = event.eventData?.execution
      if (execution === undefined || execution === null) continue
      runs.set(event.id, {
        sandbox: event.sandboxId,
        end: Ms(event.timestamp),
        ms: execution.execution_time,
        vcpus: execution.vcpu_count,
        memoryMb: execution.memory_mb,
        metadata: event.eventData?.sandbox_metadata ?? {}
      })
    }
    if (batch.length < 100 || batch.every((event) => Ms(event.timestamp) < sinceMs)) break
  }
  return [...runs.values()].filter((run) => run.end >= sinceMs)
}

// ---------------------------------------------------------------------------
// Everything
// ---------------------------------------------------------------------------

const machineOf = (row: typeof TurnSql.Type): TurnMachine | undefined => {
  const fields: TurnMachine = {
    memPeakMb: row.mem_peak_mb ?? undefined,
    memTotalMb: row.mem_total_mb ?? undefined,
    swapPeakMb: row.swap_peak_mb ?? undefined,
    swapTotalMb: row.swap_total_mb ?? undefined,
    swapInPages: row.swap_in_pages ?? undefined,
    swapOutPages: row.swap_out_pages ?? undefined,
    oomKills: row.oom_kills ?? undefined,
    diskFreeMb: row.disk_free_mb ?? undefined
  }
  return Object.values(fields).some((value) => value !== undefined) ? fields : undefined
}

export interface ReadOptions {
  readonly day: string
  readonly now: number
  /** E2B's lifecycle log is the slowest read (a page per 100 runs); it only cross-checks the ledger. */
  readonly withE2BLog: boolean
}

export const readInputs = async (options: ReadOptions): Promise<Inputs> => {
  const missing: Array<string> = []
  const attempt = async <A>(name: string, read: () => Promise<A>): Promise<A | undefined> => {
    try {
      return await read()
    } catch (error) {
      missing.push(`${name} (${error instanceof Error ? error.message : String(error)})`)
      return undefined
    }
  }
  const d0 = Date.parse(`${options.day}T00:00:00Z`)
  const since = new Date(d0 - 8 * DayMs).toISOString()
  const database = await findDatabase()

  const [ledger, turns, olderTurns, projects, mac, wakes, usage, live, browsers, macs, buckets, e2bLog, tables] =
    await Promise.all([
      attempt("the ledger (meter_events)", () =>
        query(
          database,
          LedgerSql,
          "SELECT id, meter, at, project_id, center, cost_usd, quantities_json, dimensions_json FROM meter_events WHERE at >= ?",
          [since]
        )
      ),
      attempt("turns (turn_usage)", () =>
        query(database, TurnSql, "SELECT * FROM turn_usage WHERE ended_at >= ?", [since])
      ),
      // Turns from before `turn_usage` (2026-11-06) are only in `usage_events`, whose end has a 5-minute idle tail.
      attempt("older turns (usage_events)", () =>
        query(
          database,
          Schema.Struct({ project_id: Schema.String, started_at: Schema.String, ended_at: Schema.String }),
          "SELECT project_id, started_at, ended_at FROM usage_events WHERE kind = 'sandbox' AND ended_at >= ?",
          [since]
        )
      ),
      attempt("projects", () => query(database, ProjectSql, "SELECT id, title, archived_at, sandbox_id FROM projects")),
      attempt("Macs' activity (mac_activity)", () =>
        query(
          database,
          MacSql,
          "SELECT instance_id, project_id, at, kind, busy, reason, detail_json FROM mac_activity WHERE at >= ?",
          [since]
        )
      ),
      attempt("wake notes (sandbox_wakes; deployed with the resource review)", () =>
        query(database, WakeSql, "SELECT project_id, at, reason, detail FROM sandbox_wakes WHERE at >= ? ORDER BY at", [
          since
        ])
      ),
      attempt("sandbox usage (sandbox_usage; deployed with the resource review)", () =>
        query(
          database,
          UsageSql,
          "SELECT sandbox_id, hour, project_id, vcpus, memory_mb, cpu_max_pct, mem_max_mb, disk_used_max_mb, disk_total_mb FROM sandbox_usage WHERE hour >= ?",
          [since]
        )
      ),
      attempt("E2B's sandboxes", async () =>
        Schema.decodeUnknownSync(Listed)(await e2b("/v2/sandboxes?state=running,paused&limit=100"))
      ),
      attempt("Browserbase's sessions", async () =>
        Schema.decodeUnknownSync(Sessions)(await getJson("https://api.browserbase.com/v1/sessions"))
      ),
      attempt("Namespace's instances", async () =>
        Schema.decodeUnknownSync(Instances)(
          await getJson(`${NamespaceApi}/namespace.cloud.compute.v1beta.ComputeService/ListInstances`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}"
          })
        )
      ),
      attempt("R2's buckets", async () => {
        const list = Schema.decodeUnknownSync(BucketList)(await cloudflare("/r2/buckets"))
        return Promise.all(
          list.result.buckets.map(async ({ name }): Promise<Bucket> => {
            const usage = Schema.decodeUnknownSync(BucketUsage)(await cloudflare(`/r2/buckets/${name}/usage`))
            return { name, bytes: Number(usage.result.payloadSize), objects: Number(usage.result.objectCount) }
          })
        )
      }),
      options.withE2BLog ? attempt("E2B's lifecycle log", () => readLog(d0 - DayMs)) : Promise.resolve(undefined),
      attempt("D1's table sizes", async () => {
        // One at a time: D1 refuses a compound SELECT of more than a few terms.
        const counts: Array<readonly [string, number]> = []
        for (const table of GrowingTables) {
          const [row] = await query(database, Schema.Struct({ n: Schema.Finite }), `SELECT COUNT(*) AS n FROM ${table}`)
          counts.push([table, row?.n ?? 0])
        }
        return Object.fromEntries(counts)
      })
    ])

  const liveSandboxes: Array<LiveSandbox> = (live ?? []).map((s) => ({
    id: s.sandboxID,
    state: s.state,
    startedAt: Ms(s.startedAt),
    endAt: s.endAt === undefined || s.endAt === null ? undefined : Ms(s.endAt),
    vcpus: s.cpuCount,
    memoryMb: s.memoryMB,
    diskMb: s.diskSizeMB ?? undefined,
    metadata: s.metadata ?? {}
  }))

  // Load: what's kept per hour, and E2B's own samples for the project sandboxes it still has (finer, but only
  // while the sandbox exists).
  const load: Array<LoadPoint> = (usage ?? []).map((row) => ({
    sandbox: row.sandbox_id,
    project: row.project_id ?? undefined,
    at: Ms(row.hour),
    vcpus: row.vcpus,
    memoryMb: row.memory_mb,
    cpuPct: row.cpu_max_pct,
    memMb: row.mem_max_mb,
    diskMb: row.disk_used_max_mb,
    diskTotalMb: row.disk_total_mb
  }))
  const projectSandboxes = liveSandboxes.filter(
    (s) => s.metadata.projectId !== undefined && s.metadata.purpose === undefined
  )
  for (const sandbox of projectSandboxes) {
    const samples = await attempt(`E2B's metrics for ${sandbox.id}`, async () =>
      Schema.decodeUnknownSync(Metrics)(await e2b(`/sandboxes/${sandbox.id}/metrics`))
    )
    for (const sample of samples ?? []) {
      load.push({
        sandbox: sandbox.id,
        project: sandbox.metadata.projectId,
        at: sample.timestampUnix * 1000,
        vcpus: sandbox.vcpus,
        memoryMb: sandbox.memoryMb,
        cpuPct: sample.cpuUsedPct,
        memMb: sample.memUsed / Mb,
        diskMb: sample.diskUsed / Mb,
        diskTotalMb: sample.diskTotal / Mb
      })
    }
  }

  const ledgerRows: Array<LedgerRow> = (ledger ?? []).map((row) => ({
    id: row.id,
    meter: row.meter,
    at: Ms(row.at),
    project: row.project_id ?? undefined,
    center: row.center,
    cost: row.cost_usd,
    quantities: row.quantities_json,
    dimensions: row.dimensions_json
  }))
  const turnRows: Array<Turn> = (turns ?? []).map((row) => ({
    project: row.project_id,
    start: Ms(row.started_at),
    end: Ms(row.ended_at),
    outputTokens: row.output_tokens ?? undefined,
    task: row.wake_id !== null,
    machine: machineOf(row)
  }))
  const recorded = new Set(turnRows.map((turn) => `${turn.project} ${turn.start}`))
  for (const row of olderTurns ?? []) {
    const start = Ms(row.started_at)
    if (recorded.has(`${row.project_id} ${start}`)) continue
    turnRows.push({ project: row.project_id, start, end: Math.max(start, Ms(row.ended_at) - 5 * 60_000), task: false })
  }
  const projectRows: Array<ProjectInfo> = (projects ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    archived: row.archived_at !== null,
    sandboxId: row.sandbox_id ?? undefined
  }))
  const macRows: Array<MacEntry> = (mac ?? []).map((row) => ({
    instance: row.instance_id,
    project: row.project_id,
    at: Ms(row.at),
    kind: row.kind,
    busy: row.busy === null ? undefined : row.busy === 1,
    reason: row.reason ?? undefined,
    detail: row.detail_json
  }))
  const wakeRows: Array<WakeNote> | undefined = wakes?.map((row) => ({
    project: row.project_id,
    at: Ms(row.at),
    reason: row.reason,
    detail: row.detail ?? undefined
  }))
  const browserRows: Array<BrowserSession> | undefined = browsers?.map((s) => {
    const project = s.userMetadata?.dreamProject
    return {
      id: s.id,
      status: s.status,
      project: typeof project === "string" ? project : undefined,
      start: Ms(s.startedAt),
      end: s.endedAt === undefined || s.endedAt === null ? undefined : Ms(s.endedAt)
    }
  })
  const macRowsLive: Array<LiveMac> | undefined = macs?.instances?.map((i) => ({
    id: i.instanceId,
    created: Ms(i.createdAt),
    deadline: i.deadline === undefined ? undefined : Ms(i.deadline),
    vcpus: i.shape?.virtualCpu ?? 4,
    purpose: i.documentedPurpose,
    labels: Object.fromEntries((i.labels ?? []).map((l) => [l.name, l.value]))
  }))

  return {
    now: options.now,
    day: options.day,
    ledger: ledgerRows,
    turns: turnRows,
    projects: projectRows,
    mac: macRows,
    wakes: wakeRows,
    live: liveSandboxes,
    load,
    browsers: browserRows,
    macs: macRowsLive ?? (macs === undefined ? undefined : []),
    buckets,
    d1Bytes: database.bytes,
    d1Tables: tables,
    e2bLog,
    missing
  }
}
