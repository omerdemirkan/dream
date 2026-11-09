/**
 * What Dream's E2B sandboxes cost, per day and per cause, from E2B's own lifecycle log (`GET /events/sandboxes`):
 * every pause and kill there carries how long that run lasted and its size, so the bill can be rebuilt run by run. It
 * matched E2B's usage page to within 3% (Nov 2026).
 *
 *   node packages/sandbox-template/scripts/costs.ts [--days 7] [--budget <usd a day>] [--day YYYY-MM-DD] [--json]
 *
 * Each run is split by what it was for:
 *
 * - turns: a project's sandbox while one of its turns ran (from `turn_usage` in D1)
 * - idle after turns: the rest of a run that had a turn in it (the tail after a turn, starting up, post-turn checks)
 * - wakes with no turn: a project's runs with no turn at all (scheduled checks, app visits, relay deliveries)
 * - refresh donors, sign-ins: the short-lived sandboxes the Worker makes for refreshes and model sign-ins
 * - dev and test: everything without an owner (template checks, probes, QA tools; see `devSandboxMetadata`)
 *
 * It then looks for surprises in the last day: a total over `--budget` or over twice the days before, a project
 * waking dozens of times without a turn (a schedule that's too frequent), a throwaway sandbox up for over an hour.
 * It prints them and exits with code 2, so a daily job can raise them; 0 otherwise.
 *
 * Needs the workspace's `e2b-api` connection (or E2B_API_KEY). Turns come from D1 through the `cloudflare-api`
 * connection with read-only queries; without it, project time isn't split into turns and idle. Prints no secrets:
 * it reads only ids, times, sizes and the metadata Dream sets.
 */
import { Schema } from "effect"

const Prices = { vcpuSecond: 0.000014, gibSecond: 0.0000045 } as const
const Account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "2d98de7c4511e98d2f774c4fcc9b9b93"
const E2bApi = process.env.E2B_API_URL ?? "https://api.e2b.app"
const e2bHeaders: Record<string, string> =
  process.env.E2B_API_KEY === undefined ? {} : { "X-API-KEY": process.env.E2B_API_KEY }

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const days = Number(arg("days") ?? 7)
const budget = arg("budget") === undefined ? undefined : Number(arg("budget"))
const asJson = process.argv.includes("--json")

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const Event = Schema.Struct({
  id: Schema.String,
  sandboxId: Schema.String,
  timestamp: Schema.String,
  type: Schema.String,
  sandboxTemplateId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  eventData: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        sandbox_metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
        execution: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              execution_time: Schema.Number,
              memory_mb: Schema.Number,
              vcpu_count: Schema.Number,
              started_at: Schema.String
            })
          )
        )
      })
    )
  )
})
const Events = Schema.Array(Event)
const Templates = Schema.Array(Schema.Struct({ templateID: Schema.String, aliases: Schema.Array(Schema.String) }))
const Running = Schema.Array(
  Schema.Struct({
    sandboxID: Schema.String,
    templateID: Schema.String,
    startedAt: Schema.String,
    cpuCount: Schema.Number,
    memoryMB: Schema.Number,
    metadata: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String)))
  })
)
const D1Result = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.optionalKey(Schema.Array(Schema.Struct({ results: Schema.Array(Schema.Unknown) })))
})
const D1List = Schema.Struct({
  result: Schema.Array(Schema.Struct({ uuid: Schema.String, name: Schema.String }))
})
const TurnRow = Schema.Struct({ project_id: Schema.String, started_at: Schema.String, ended_at: Schema.String })

const e2b = async (path: string): Promise<{ readonly body: unknown; readonly headers: Headers }> => {
  const response = await fetch(`${E2bApi}${path}`, { headers: e2bHeaders })
  if (!response.ok) throw new Error(`E2B ${path.split("?")[0]}: HTTP ${response.status}`)
  return { body: await response.json(), headers: response.headers }
}

/** Every lifecycle event since `sinceMs`. E2B returns them newest first, a page at a time. */
const readEvents = async (sinceMs: number) => {
  const all: Array<typeof Event.Type> = []
  for (let page = 0; page < 500; page++) {
    const batch = Schema.decodeUnknownSync(Events)((await e2b(`/events/sandboxes?limit=100&offset=${page * 100}`)).body)
    all.push(...batch)
    if (batch.length < 100 || batch.every((event) => Date.parse(event.timestamp) < sinceMs)) break
  }
  return [...new Map(all.map((event) => [event.id, event])).values()]
}

const cloudflare = async (path: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${Account}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      // The workspace's connection adds the token; elsewhere it comes from the environment.
      ...(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_API_TOKEN !== "anything"
        ? { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }
        : {}),
      ...(init?.headers ?? {})
    }
  })
  if (!response.ok) throw new Error(`Cloudflare ${path}: HTTP ${response.status}`)
  return response.json()
}

/** Turns since `sinceMs`, from the production D1. Read-only; `undefined` when D1 can't be read. */
const readTurns = async (sinceMs: number) => {
  try {
    const databases = Schema.decodeUnknownSync(D1List)(await cloudflare("/d1/database?per_page=100"))
    const database = databases.result.find((d) => d.name.startsWith("Dream-Database-prod"))
    if (database === undefined) return undefined
    const since = new Date(sinceMs - 24 * 3_600_000).toISOString()
    const body = Schema.decodeUnknownSync(D1Result)(
      await cloudflare(`/d1/database/${database.uuid}/query`, {
        method: "POST",
        body: JSON.stringify({
          sql: "SELECT project_id, started_at, ended_at FROM turn_usage WHERE ended_at >= ?",
          params: [since]
        })
      })
    )
    const rows = (body.result?.[0]?.results ?? []).map((row) => Schema.decodeUnknownSync(TurnRow)(row))
    // Turns from before `turn_usage` existed are only in `usage_events`, whose end included a 5-minute idle tail.
    const older = Schema.decodeUnknownSync(D1Result)(
      await cloudflare(`/d1/database/${database.uuid}/query`, {
        method: "POST",
        body: JSON.stringify({
          sql: "SELECT project_id, started_at, ended_at FROM usage_events WHERE kind = 'sandbox' AND ended_at >= ?",
          params: [since]
        })
      })
    )
    const recorded = new Set(rows.map((row) => `${row.project_id} ${Date.parse(row.started_at)}`))
    const turns = new Map<string, Array<Interval>>()
    const add = (projectId: string, interval: Interval) => {
      const list = turns.get(projectId) ?? []
      list.push(interval)
      turns.set(projectId, list)
    }
    for (const row of rows) add(row.project_id, [Date.parse(row.started_at), Date.parse(row.ended_at)])
    for (const row of (older.result?.[0]?.results ?? []).map((r) => Schema.decodeUnknownSync(TurnRow)(r))) {
      const start = Date.parse(row.started_at)
      if (recorded.has(`${row.project_id} ${start}`)) continue
      add(row.project_id, [start, Math.max(start, Date.parse(row.ended_at) - 5 * 60_000)])
    }
    return turns
  } catch (error) {
    console.error(`(Couldn't read turns from D1, so project time isn't split into turns and idle: ${String(error)})`)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

type Interval = readonly [number, number]
const Causes = [
  "turns",
  "idle after turns",
  "wakes with no turn",
  "project, turns unknown",
  "refresh donors",
  "sign-ins",
  "dev and test"
] as const
type Cause = (typeof Causes)[number]

interface Run {
  readonly sandboxId: string
  readonly start: number
  readonly end: number
  readonly perSecond: number
  readonly metadata: Readonly<Record<string, string>>
  readonly template: string
  readonly running: boolean
}

const overlap = ([a, b]: Interval, [c, d]: Interval) => Math.max(0, Math.min(b, d) - Math.max(a, c))
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
/** `interval` cut at UTC midnights. */
const byDay = ([start, end]: Interval): Array<Interval> => {
  const pieces: Array<Interval> = []
  for (let at = start; at < end; ) {
    const midnight = Date.parse(`${dayOf(at)}T00:00:00Z`) + 86_400_000
    const next = Math.min(end, midnight)
    pieces.push([at, next])
    at = next
  }
  return pieces
}

interface DayLine {
  readonly day: string
  readonly cost: Record<Cause, number>
  runs: number
  /** Per project: cost, and runs with no turn. */
  readonly projects: Map<string, { cost: number; wakes: number }>
  /** Throwaway runs over an hour. */
  readonly longDev: Array<{ sandboxId: string; hours: number; label: string }>
}

const emptyLine = (day: string): DayLine => ({
  day,
  cost: Object.fromEntries(Causes.map((cause) => [cause, 0])) as Record<Cause, number>,
  runs: 0,
  projects: new Map(),
  longDev: []
})

const split = (runs: ReadonlyArray<Run>, turns: Map<string, Array<Interval>> | undefined) => {
  const lines = new Map<string, DayLine>()
  const line = (day: string) => {
    const existing = lines.get(day)
    if (existing !== undefined) return existing
    const fresh = emptyLine(day)
    lines.set(day, fresh)
    return fresh
  }
  for (const run of runs) {
    const meta = run.metadata
    const projectId = meta.projectId
    const purpose = meta.purpose
    const own = projectId === undefined ? [] : (turns?.get(projectId) ?? [])
    const hadTurn = own.some((turn) => overlap(turn, [run.start, run.end]) > 0)
    line(dayOf(run.start)).runs += 1
    for (const piece of byDay([run.start, run.end])) {
      const day = line(dayOf(piece[0]))
      const seconds = (piece[1] - piece[0]) / 1000
      const cost = seconds * run.perSecond
      if (purpose === "refresh-donor") day.cost["refresh donors"] += cost
      else if (purpose === "model-connect") day.cost["sign-ins"] += cost
      else if (projectId !== undefined) {
        const project = day.projects.get(projectId) ?? { cost: 0, wakes: 0 }
        project.cost += cost
        day.projects.set(projectId, project)
        if (turns === undefined) day.cost["project, turns unknown"] += cost
        else if (!hadTurn) day.cost["wakes with no turn"] += cost
        else {
          const working = own.reduce((sum, turn) => sum + overlap(turn, piece), 0) / 1000
          day.cost.turns += Math.min(seconds, working) * run.perSecond
          day.cost["idle after turns"] += Math.max(0, seconds - working) * run.perSecond
        }
      } else day.cost["dev and test"] += cost
    }
    if (projectId !== undefined && purpose === undefined && turns !== undefined && !hadTurn) {
      const project = line(dayOf(run.start)).projects.get(projectId) ?? { cost: 0, wakes: 0 }
      project.wakes += 1
      line(dayOf(run.start)).projects.set(projectId, project)
    }
    const hours = (run.end - run.start) / 3_600_000
    if (projectId === undefined && meta.userId === undefined && hours > 1) {
      line(dayOf(run.start)).longDev.push({
        sandboxId: run.sandboxId,
        hours,
        label: `${meta.script ?? meta.purpose ?? "unlabeled"} on ${run.template}${run.running ? ", still running" : ""}`
      })
    }
  }
  return [...lines.values()].sort((a, b) => a.day.localeCompare(b.day))
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const total = (line: DayLine) => Causes.reduce((sum, cause) => sum + line.cost[cause], 0)
const usd = (n: number) => `$${n.toFixed(2)}`

const surprises = (lines: ReadonlyArray<DayLine>, today: string) => {
  const found: Array<string> = []
  const last = lines.find((line) => line.day === today)
  if (last === undefined) return found
  const before = lines.filter((line) => line.day < today).map(total)
  const usual = before.length === 0 ? undefined : [...before].sort((a, b) => a - b)[Math.floor(before.length / 2)]
  const spent = total(last)
  if (budget !== undefined && spent > budget) found.push(`${today} cost ${usd(spent)}, over the ${usd(budget)} budget`)
  if (usual !== undefined && spent > 1 && spent > 2 * usual) {
    found.push(`${today} cost ${usd(spent)}, more than twice the usual ${usd(usual)} a day`)
  }
  for (const [projectId, project] of last.projects) {
    if (project.wakes >= 24) {
      found.push(
        `${projectId} woke ${project.wakes} times without a turn (${usd(project.cost)}): a frequent schedule, or something polling its app?`
      )
    }
  }
  for (const run of last.longDev) {
    found.push(`throwaway sandbox ${run.sandboxId} (${run.label}) was up ${run.hours.toFixed(1)} h`)
  }
  return found
}

const main = async () => {
  const nowMs = Date.now()
  const today = arg("day") ?? dayOf(nowMs)
  const sinceMs = Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000
  const [events, templates, running, turns] = await Promise.all([
    readEvents(sinceMs),
    e2b("/templates").then((r) => Schema.decodeUnknownSync(Templates)(r.body)),
    e2b("/v2/sandboxes?state=running&limit=100").then((r) => Schema.decodeUnknownSync(Running)(r.body)),
    readTurns(sinceMs)
  ])
  const names = new Map(templates.map((t) => [t.templateID, t.aliases[0] ?? t.templateID]))
  const metadata = new Map<string, Record<string, string>>()
  for (const event of events) {
    const meta = event.eventData?.sandbox_metadata
    if (meta) metadata.set(event.sandboxId, { ...metadata.get(event.sandboxId), ...meta })
  }
  const runs: Array<Run> = []
  for (const event of events) {
    const execution = event.eventData?.execution
    if (!execution || (!event.type.endsWith(".paused") && !event.type.endsWith(".killed"))) continue
    const start = Date.parse(execution.started_at)
    const end = start + execution.execution_time
    if (end < sinceMs) continue
    runs.push({
      sandboxId: event.sandboxId,
      start: Math.max(start, sinceMs),
      end,
      perSecond: execution.vcpu_count * Prices.vcpuSecond + (execution.memory_mb / 1024) * Prices.gibSecond,
      metadata: metadata.get(event.sandboxId) ?? {},
      template: names.get(event.sandboxTemplateId ?? "") ?? event.sandboxTemplateId ?? "?",
      running: false
    })
  }
  // Runs still going have no end event yet: count them up to now.
  for (const sandbox of running) {
    const start = Math.max(Date.parse(sandbox.startedAt), sinceMs)
    runs.push({
      sandboxId: sandbox.sandboxID,
      start,
      end: nowMs,
      perSecond: sandbox.cpuCount * Prices.vcpuSecond + (sandbox.memoryMB / 1024) * Prices.gibSecond,
      metadata: sandbox.metadata ?? metadata.get(sandbox.sandboxID) ?? {},
      template: names.get(sandbox.templateID) ?? sandbox.templateID,
      running: true
    })
  }
  const lines = split(runs, turns).filter((line) => line.day >= dayOf(sinceMs) && line.day <= today)
  const found = surprises(lines, today)

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          days: lines.map((line) => ({
            day: line.day,
            total: total(line),
            runs: line.runs,
            ...line.cost,
            projects: Object.fromEntries(line.projects)
          })),
          surprises: found
        },
        null,
        2
      )
    )
  } else {
    const shown = Causes.filter((cause) => lines.some((line) => line.cost[cause] > 0.005))
    console.log(["day       ", "  total", "  runs", ...shown.map((c) => `  ${c}`)].join(""))
    for (const line of lines) {
      console.log(
        [
          line.day,
          usd(total(line)).padStart(7),
          String(line.runs).padStart(6),
          ...shown.map((cause) => usd(line.cost[cause]).padStart(cause.length + 2))
        ].join("")
      )
    }
    const last = lines.at(-1)
    if (last !== undefined && last.projects.size > 0) {
      console.log(`\nprojects on ${last.day}, most expensive first:`)
      for (const [projectId, project] of [...last.projects].sort((a, b) => b[1].cost - a[1].cost).slice(0, 8)) {
        console.log(`  ${projectId}  ${usd(project.cost)}  ${project.wakes} wakes with no turn`)
      }
    }
    console.log(found.length === 0 ? "\nnothing surprising" : `\nsurprises:\n${found.map((f) => `  ${f}`).join("\n")}`)
  }
  process.exitCode = found.length === 0 ? 0 : 2
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error))
  process.exitCode = 1
})
