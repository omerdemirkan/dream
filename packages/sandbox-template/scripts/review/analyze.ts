/**
 * The resource review's judgment, apart from where its data comes from (`sources.ts`), so it can be tested on fixed
 * inputs: what Dream spent on a day against the week before, where each project's machine time went, which
 * sandboxes are the wrong size, what the Macs and browsers were left doing, how storage grows, and whether the
 * ledger itself keeps up. Every finding carries an estimate of what it costs a day, and the findings come out
 * ranked by it.
 *
 * Prices repeat `apps/api/src/metering/Prices.ts` (2026-11-08), which this package can't import.
 */

export const Prices = {
  vcpuSecond: 0.000014,
  gibSecond: 0.0000045,
  /** Namespace macOS, per minute by vCPUs; another shape at the 4-vCPU rate per vCPU. */
  macMinute: { 4: 0.06, 6: 0.09, 8: 0.12 } as Readonly<Record<number, number>>,
  browserHour: 0.12
} as const

/** What a sandbox of this size costs an hour. */
export const sandboxHourly = (vcpus: number, memoryMb: number) =>
  3600 * (vcpus * Prices.vcpuSecond + (memoryMb / 1024) * Prices.gibSecond)
export const macHourly = (vcpus: number) =>
  60 * (Prices.macMinute[vcpus] ?? (vcpus * (Prices.macMinute[4] ?? 0.06)) / 4)

/** The two sandbox sizes (`SandboxSize` in packages/domain/src/Sandbox.ts). */
export const Standard = { vcpus: 2, memoryMb: 4096 } as const
export const Large = { vcpus: 4, memoryMb: 8192 } as const

const MinuteMs = 60_000
/** A sample under this much CPU (of all its vCPUs) counts as the sandbox sitting idle. */
export const IdleCpuPct = 5
const HourMs = 3_600_000
const DayMs = 86_400_000

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface LedgerRow {
  readonly id: string
  readonly meter: string
  /** Epoch ms: a run's end, a session's end, a storage day's last millisecond. */
  readonly at: number
  readonly project?: string | undefined
  readonly center: string
  readonly cost: number
  readonly quantities: Readonly<Record<string, number>>
  readonly dimensions: Readonly<Record<string, string>>
}

export interface Turn {
  readonly project: string
  readonly start: number
  readonly end: number
  readonly outputTokens?: number | undefined
  /** A scheduled task's session rather than a turn. */
  readonly task: boolean
}

export interface ProjectInfo {
  readonly id: string
  readonly title: string
  readonly archived: boolean
  readonly sandboxId?: string | undefined
}

export interface MacEntry {
  readonly instance: string
  readonly project: string
  readonly at: number
  readonly kind: string
  readonly busy?: boolean | undefined
  readonly reason?: string | undefined
  /** The `MacActivity` as stored. */
  readonly detail: Readonly<Record<string, unknown>>
}

export interface WakeNote {
  readonly project: string
  readonly at: number
  readonly reason: string
  readonly detail?: string | undefined
}

/** A sandbox E2B lists now. */
export interface LiveSandbox {
  readonly id: string
  readonly state: string
  /** When it last started or resumed. */
  readonly startedAt: number
  /** For a paused one, when it paused; for a running one, when it will. */
  readonly endAt?: number | undefined
  readonly vcpus: number
  readonly memoryMb: number
  readonly diskMb?: number | undefined
  readonly metadata: Readonly<Record<string, string>>
}

/** A point of a sandbox's load: one of E2B's samples, or an hour kept in `sandbox_usage` (its peaks). */
export interface LoadPoint {
  readonly sandbox: string
  readonly project?: string | undefined
  readonly at: number
  readonly vcpus: number
  readonly memoryMb: number
  readonly cpuPct: number
  readonly memMb: number
  readonly diskMb: number
  readonly diskTotalMb: number
}

export interface BrowserSession {
  readonly id: string
  readonly status: string
  readonly project?: string | undefined
  readonly start: number
  readonly end?: number | undefined
}

export interface LiveMac {
  readonly id: string
  readonly created: number
  readonly deadline?: number | undefined
  readonly vcpus: number
  readonly purpose?: string | undefined
  readonly labels: Readonly<Record<string, string>>
}

export interface Bucket {
  readonly name: string
  readonly bytes: number
  readonly objects: number
}

/** A run from E2B's own log (7 days), for the cross-check and to name throwaway sandboxes. */
export interface E2BRun {
  readonly sandbox: string
  readonly end: number
  readonly ms: number
  readonly vcpus: number
  readonly memoryMb: number
  readonly metadata: Readonly<Record<string, string>>
}

export interface Inputs {
  readonly now: number
  /** The day reviewed, `YYYY-MM-DD` (UTC). */
  readonly day: string
  readonly ledger: ReadonlyArray<LedgerRow>
  readonly turns: ReadonlyArray<Turn>
  readonly projects: ReadonlyArray<ProjectInfo>
  readonly mac: ReadonlyArray<MacEntry>
  /** Undefined when the table isn't there yet (before the telemetry was deployed). */
  readonly wakes?: ReadonlyArray<WakeNote> | undefined
  readonly live: ReadonlyArray<LiveSandbox>
  readonly load: ReadonlyArray<LoadPoint>
  readonly browsers?: ReadonlyArray<BrowserSession> | undefined
  readonly macs?: ReadonlyArray<LiveMac> | undefined
  readonly buckets?: ReadonlyArray<Bucket> | undefined
  readonly d1Bytes?: number | undefined
  /** Rows in D1's growing tables. */
  readonly d1Tables?: Readonly<Record<string, number>> | undefined
  readonly e2bLog?: ReadonlyArray<E2BRun> | undefined
  /** Sources that couldn't be read, for the report to say so. */
  readonly missing: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type Severity = "action" | "watch" | "info"

export interface Finding {
  readonly severity: Severity
  readonly area:
    | "spend"
    | "machine time"
    | "sandboxes"
    | "sizing"
    | "macs"
    | "browsers"
    | "storage"
    | "ledger"
    | "turns"
  /** What it costs (or would save) a day, in dollars, as well as it can be told. */
  readonly usdPerDay: number
  readonly title: string
  readonly detail?: string | undefined
}

export type MachineCause =
  | "turns"
  | "idle after turns"
  | "wake: delivery"
  | "wake: scheduled command"
  | "wake: scheduled task"
  | "wake: visit"
  | "wake: relay"
  | "wake: refresh"
  | "wake: move"
  | "wake: unexplained"
  | "refresh donors"

export interface ProjectDay {
  readonly project: string
  readonly title: string
  readonly total: number
  readonly byCenter: Record<string, number>
  /** E2B dollars by cause. */
  readonly machine: Partial<Record<MachineCause, number>>
  readonly machineHours: number
  readonly turnHours: number
  readonly wakesWithoutTurn: number
  readonly refreshes: number
}

export interface SizingLine {
  readonly project: string
  readonly title: string
  readonly sandbox: string
  readonly vcpus: number
  readonly memoryMb: number
  readonly points: number
  readonly cpuP50: number
  readonly cpuP95: number
  /** The share of points using more than a standard sandbox's two vCPUs (all of them, on a standard one). */
  readonly busyShare: number
  readonly memPeakMb: number
  readonly diskPct?: number | undefined
  readonly hoursPerDay: number
}

export interface Review {
  readonly day: string
  readonly spend: {
    readonly byCenter: Record<string, { readonly day: number; readonly median: number; readonly week: number }>
    readonly total: { readonly day: number; readonly median: number; readonly week: number }
  }
  readonly projects: ReadonlyArray<ProjectDay>
  readonly overhead: Record<string, number>
  readonly sizing: ReadonlyArray<SizingLine>
  readonly storage: {
    readonly buckets: ReadonlyArray<Bucket>
    readonly d1Bytes?: number | undefined
    readonly d1Tables?: Readonly<Record<string, number>> | undefined
  }
  readonly findings: ReadonlyArray<Finding>
  readonly missing: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`)
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
export const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
export const percentile = (values: ReadonlyArray<number>, p: number) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!
}
const usd = (n: number) => `$${n.toFixed(2)}`
const add = <K extends string>(record: Partial<Record<K, number>>, key: K, amount: number) => {
  record[key] = (record[key] ?? 0) + amount
}

/** A run's start and end, from its ledger row (the row's `at` is the run's end). */
const runSpan = (row: LedgerRow): readonly [number, number] => [row.at - (row.quantities.ms ?? 0), row.at]
const isProjectRun = (row: LedgerRow) => row.meter === "sandbox_run" && row.dimensions.cause === "project"

const wakeCause: Record<string, MachineCause> = {
  delivery: "wake: delivery",
  "wake-run": "wake: scheduled command",
  "wake-task": "wake: scheduled task",
  visit: "wake: visit",
  relay: "wake: relay",
  refresh: "wake: refresh",
  move: "wake: move"
}

/** A note that explains a run: the first one from just before it started to its end. */
const NoteLead = 20_000
export const explainRun = (notes: ReadonlyArray<WakeNote>, start: number, end: number): MachineCause => {
  const note = notes.find((n) => n.at >= start - NoteLead && n.at <= end)
  return note === undefined ? "wake: unexplained" : (wakeCause[note.reason] ?? "wake: unexplained")
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

export const review = (inputs: Inputs): Review => {
  const findings: Array<Finding> = []
  const d0 = dayStart(inputs.day)
  const d1 = d0 + DayMs
  const titles = new Map(inputs.projects.map((p) => [p.id, p.title]))
  const known = new Set(inputs.projects.map((p) => p.id))
  const title = (id: string | undefined) =>
    id === undefined ? "no project" : (titles.get(id) ?? (id.startsWith("prj_dev_") ? id : `deleted ${id}`))

  // --- Spend: the day against the seven before it -------------------------------------------------
  const centers = [...new Set(inputs.ledger.map((row) => row.center))].sort()
  const dailyByCenter = (center: string | undefined, from: number, project?: string) => {
    const days: Array<number> = []
    for (let start = from; start < from + 7 * DayMs; start += DayMs) {
      days.push(
        inputs.ledger
          .filter(
            (row) =>
              (center === undefined || row.center === center) &&
              (project === undefined || row.project === project) &&
              row.at >= start &&
              row.at < start + DayMs
          )
          .reduce((sum, row) => sum + row.cost, 0)
      )
    }
    return days
  }
  const dayCost = (center: string | undefined, project?: string) =>
    inputs.ledger
      .filter(
        (row) =>
          (center === undefined || row.center === center) &&
          (project === undefined || row.project === project) &&
          row.at >= d0 &&
          row.at < d1
      )
      .reduce((sum, row) => sum + row.cost, 0)
  const spendLine = (center: string | undefined) => {
    const before = dailyByCenter(center, d0 - 7 * DayMs)
    // Days before the ledger had anything don't count toward what's usual.
    const firstAt = Math.min(...inputs.ledger.map((row) => row.at))
    const counted = before.filter((_, i) => d0 - (7 - i) * DayMs + DayMs > firstAt)
    return { day: dayCost(center), median: median(counted), week: before.reduce((a, b) => a + b, 0) }
  }
  const byCenter = Object.fromEntries(centers.map((center) => [center, spendLine(center)]))
  const total = spendLine(undefined)
  const spike = (line: { day: number; median: number }) => line.day > 1 && line.day > 2 * line.median + 0.5
  const spiked = new Set<string>()
  for (const [center, line] of Object.entries(byCenter)) {
    if (spike(line)) {
      spiked.add(center)
      findings.push({
        severity: "action",
        area: "spend",
        usdPerDay: line.day - line.median,
        title: `${center} spend ${usd(line.day)} on ${inputs.day}, against a usual ${usd(line.median)} a day`,
        detail: "See the projects below for where it went."
      })
    }
  }

  // --- Projects: spend, and where their machine time went ------------------------------------------
  const projectIds = [
    ...new Set(
      inputs.ledger
        .filter((row) => row.project !== undefined && row.at >= d0 && row.at < d1 + HourMs)
        .map((row) => row.project!)
    )
  ]
  const turnsOf = (project: string) => inputs.turns.filter((turn) => turn.project === project)
  const notesOf = (project: string) =>
    (inputs.wakes ?? []).filter((note) => note.project === project).sort((a, b) => a.at - b.at)
  const projects: Array<ProjectDay> = []
  for (const project of projectIds) {
    const rows = inputs.ledger.filter((row) => row.project === project)
    const byProjectCenter: Record<string, number> = {}
    for (const row of rows) if (row.at >= d0 && row.at < d1) add(byProjectCenter, row.center, row.cost)
    const machine: Partial<Record<MachineCause, number>> = {}
    const turns = turnsOf(project)
    const notes = notesOf(project)
    let machineMs = 0
    let wakesWithoutTurn = 0
    let refreshes = 0
    let tailMs = 0
    let tails = 0
    for (const row of rows) {
      if (row.meter !== "sandbox_run") continue
      const [start, end] = runSpan(row)
      const inDay = overlap(start, end, d0, d1)
      if (inDay === 0) continue
      const perMs = row.cost / Math.max(1, end - start)
      if (row.dimensions.cause === "refresh") {
        add(machine, "refresh donors", inDay * perMs)
        if (end >= d0 && end < d1) refreshes += 1
        continue
      }
      if (row.dimensions.cause !== "project") continue
      machineMs += inDay
      const working = turns.reduce(
        (sum, turn) => sum + overlap(Math.max(start, d0), Math.min(end, d1), turn.start, turn.end),
        0
      )
      const hadTurn = turns.some((turn) => overlap(start, end, turn.start, turn.end) > 0)
      if (hadTurn) {
        add(machine, "turns", Math.min(inDay, working) * perMs)
        add(machine, "idle after turns", Math.max(0, inDay - working) * perMs)
        const lastEnd = Math.max(...turns.filter((turn) => turn.start < end && turn.end > start).map((t) => t.end))
        if (lastEnd < end) {
          tailMs += end - lastEnd
          tails += 1
        }
      } else {
        const cause = inputs.wakes === undefined ? "wake: unexplained" : explainRun(notes, start, end)
        add(machine, cause, inDay * perMs)
        if (end >= d0 && end < d1) wakesWithoutTurn += 1
      }
    }
    const turnMs = turns.reduce((sum, turn) => sum + overlap(turn.start, turn.end, d0, d1), 0)
    const line: ProjectDay = {
      project,
      title: title(project),
      total: Object.values(byProjectCenter).reduce((a, b) => a + b, 0),
      byCenter: byProjectCenter,
      machine,
      machineHours: machineMs / HourMs,
      turnHours: turnMs / HourMs,
      wakesWithoutTurn,
      refreshes
    }
    projects.push(line)

    const projectSpend = { day: line.total, median: median(dailyByCenter(undefined, d0 - 7 * DayMs, project)) }
    // A project's spike in a center that spiked as a whole is the same news.
    const mainCenter = Object.entries(byProjectCenter).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (spike(projectSpend) && (mainCenter === undefined || !spiked.has(mainCenter))) {
      findings.push({
        severity: "watch",
        area: "spend",
        usdPerDay: projectSpend.day - projectSpend.median,
        title: `${line.title} cost ${usd(projectSpend.day)}, against a usual ${usd(projectSpend.median)} a day`,
        detail: Object.entries(byProjectCenter)
          .map(([center, cost]) => `${center} ${usd(cost)}`)
          .join(", ")
      })
    }
    const wakeCost = Object.entries(machine)
      .filter(([cause]) => cause.startsWith("wake:"))
      .reduce((sum, [, cost]) => sum + (cost ?? 0), 0)
    const idleCost = machine["idle after turns"] ?? 0
    const machineCost = Object.values(machine).reduce((sum, cost) => sum + (cost ?? 0), 0)
    if (machineCost > 0.5 && wakeCost + idleCost > 0.6 * machineCost) {
      findings.push({
        severity: "action",
        area: "machine time",
        usdPerDay: wakeCost + idleCost,
        title: `${line.title}: ${line.machineHours.toFixed(1)} h of machine time for ${line.turnHours.toFixed(1)} h of turns`,
        detail: `${usd(wakeCost + idleCost)} of ${usd(machineCost)} was outside turns: ${describeMachine(machine)}.`
      })
    }
    if (wakesWithoutTurn >= 24) {
      findings.push({
        severity: wakeCost > 0.25 ? "action" : "watch",
        area: "machine time",
        usdPerDay: wakeCost,
        title: `${line.title} woke ${wakesWithoutTurn} times without a turn (${usd(wakeCost)})`,
        detail: `A frequent schedule, or something polling its app? ${describeMachine(machine, "wake:")}.`
      })
    }
    const unexplained = machine["wake: unexplained"] ?? 0
    if (inputs.wakes !== undefined && unexplained > 0.1) {
      findings.push({
        severity: "watch",
        area: "machine time",
        usdPerDay: unexplained,
        title: `${line.title}: ${usd(unexplained)} of wakes with no turn and nothing noted that woke it`,
        detail:
          "Neither a delivery, a visit, a relay nor a refresh came just before: E2B auto-resumed it on traffic Dream didn't send?"
      })
    }
    if (refreshes > 8) {
      findings.push({
        severity: "watch",
        area: "machine time",
        usdPerDay: (machine["refresh donors"] ?? 0) + (machine["wake: refresh"] ?? 0),
        title: `${line.title} was refreshed ${refreshes} times`,
        detail:
          "Each template build refreshes every project once; more means builds went out often, or refreshes failed and retried."
      })
    }
    if (tails >= 3 && tailMs / tails > 4 * MinuteMs) {
      findings.push({
        severity: "watch",
        area: "machine time",
        usdPerDay: idleCost,
        title: `${line.title}: runs went on ${(tailMs / tails / MinuteMs).toFixed(1)} min after their last turn, on average`,
        detail: "The tail after a turn is meant to be 90 s (TurnTail); something kept the sandbox up."
      })
    }
  }
  projects.sort((a, b) => b.total - a.total)

  // Overhead: what no project caused, by cause.
  const overhead: Record<string, number> = {}
  for (const row of inputs.ledger) {
    if (row.meter !== "sandbox_run" || row.at < d0 || row.at >= d1 || row.project !== undefined) continue
    add(overhead, row.dimensions.cause ?? "other", row.cost)
  }
  if ((overhead.dev ?? 0) + (overhead["harness-check"] ?? 0) > 3) {
    findings.push({
      severity: "watch",
      area: "machine time",
      usdPerDay: (overhead.dev ?? 0) + (overhead["harness-check"] ?? 0),
      title: `Throwaway sandboxes (checks, probes, builds) cost ${usd((overhead.dev ?? 0) + (overhead["harness-check"] ?? 0))}`,
      detail: "Development spend: worth knowing which script, if it keeps up."
    })
  }

  // --- Throwaway and stray sandboxes --------------------------------------------------------------
  const scriptOf = (metadata: Readonly<Record<string, string>>) => metadata.script ?? metadata.purpose ?? "unlabeled"
  for (const run of inputs.ledger) {
    if (run.meter !== "sandbox_run" || run.at < d0 || run.at >= d1) continue
    const cause = run.dimensions.cause
    if (cause !== "dev" && cause !== "harness-check") continue
    const ms = run.quantities.ms ?? 0
    if (ms <= HourMs) continue
    const logged = inputs.e2bLog?.find((r) => r.sandbox === run.dimensions.sandbox)
    findings.push({
      severity: "action",
      area: "sandboxes",
      usdPerDay: run.cost,
      title: `Throwaway sandbox ${run.dimensions.sandbox} ran ${(ms / HourMs).toFixed(1)} h in one go (${usd(run.cost)})`,
      detail: `${logged === undefined ? "" : `${scriptOf(logged.metadata)}. `}The reaper kills unowned sandboxes an hour after they start; this one outlived that.`
    })
  }
  for (const sandbox of inputs.live) {
    const project = sandbox.metadata.projectId
    const purpose = sandbox.metadata.purpose
    const rate = sandboxHourly(sandbox.vcpus, sandbox.memoryMb)
    const upMs = inputs.now - sandbox.startedAt
    if (project === undefined || purpose === "refresh-donor") {
      if (sandbox.state === "running" && upMs > HourMs && sandbox.metadata.reaper !== "skip") {
        findings.push({
          severity: "action",
          area: "sandboxes",
          usdPerDay: rate * 24,
          title: `Throwaway sandbox ${sandbox.id} (${scriptOf(sandbox.metadata)}) has been up ${(upMs / HourMs).toFixed(1)} h`,
          detail: `${usd(rate)} an hour while it runs. The reaper should have killed it.`
        })
      }
      continue
    }
    if (!known.has(project)) {
      findings.push({
        severity: sandbox.state === "running" ? "action" : "watch",
        area: "sandboxes",
        usdPerDay: sandbox.state === "running" ? rate * 24 : 0,
        title: `Sandbox ${sandbox.id} is ${sandbox.state}, but its project ${project} is gone`,
        detail: "Deleting a project should kill its sandbox."
      })
      continue
    }
    if (sandbox.state !== "running") continue
    const lastTurnEnd = Math.max(0, ...turnsOf(project).map((turn) => turn.end))
    const turnRunning = turnsOf(project).some((turn) => turn.end >= inputs.now - MinuteMs)
    const quietMs = inputs.now - Math.max(sandbox.startedAt, lastTurnEnd)
    if (!turnRunning && quietMs > 30 * MinuteMs && upMs > 30 * MinuteMs) {
      findings.push({
        severity: "watch",
        area: "sandboxes",
        usdPerDay: rate * (quietMs / HourMs),
        title: `${title(project)}'s sandbox has been up ${(upMs / MinuteMs).toFixed(0)} min, with no turn for ${(quietMs / MinuteMs).toFixed(0)}`,
        detail:
          "Either a turn is running that hasn't reported yet, or something keeps it awake (a long --run command, an app in use)."
      })
    }
  }

  // --- Sizing ---------------------------------------------------------------------------------------
  const sizing: Array<SizingLine> = []
  const weekStart = d1 - 7 * DayMs
  for (const project of inputs.projects) {
    const sandbox = inputs.live.find((s) => s.metadata.projectId === project.id && s.metadata.purpose === undefined)
    if (sandbox === undefined) continue
    const points = inputs.load.filter((p) => p.sandbox === sandbox.id)
    const runHours =
      inputs.ledger
        .filter((row) => isProjectRun(row) && row.project === project.id && row.at >= weekStart && row.at < d1)
        .reduce((sum, row) => sum + (row.quantities.ms ?? 0), 0) /
      HourMs /
      7
    const latest = points.reduce<LoadPoint | undefined>((a, p) => (a === undefined || p.at > a.at ? p : a), undefined)
    const line: SizingLine = {
      project: project.id,
      title: project.title,
      sandbox: sandbox.id,
      vcpus: sandbox.vcpus,
      memoryMb: sandbox.memoryMb,
      points: points.length,
      cpuP50: percentile(
        points.map((p) => p.cpuPct),
        0.5
      ),
      cpuP95: percentile(
        points.map((p) => p.cpuPct),
        0.95
      ),
      busyShare:
        points.length === 0
          ? 0
          : points.filter((p) => (p.cpuPct * p.vcpus) / 100 > Standard.vcpus * 0.9).length / points.length,
      memPeakMb: Math.max(0, ...points.map((p) => p.memMb)),
      diskPct:
        latest === undefined || latest.diskTotalMb === 0 ? undefined : (100 * latest.diskMb) / latest.diskTotalMb,
      hoursPerDay: runHours
    }
    sizing.push(line)
    if (points.length < 12) continue
    // CPU-bound work costs the same on either size (twice the vCPUs for half the time), so what a smaller size
    // saves is the time it would have been idle or light: the points that would have fit in two vCPUs.
    const saving =
      (sandboxHourly(sandbox.vcpus, sandbox.memoryMb) - sandboxHourly(Standard.vcpus, Standard.memoryMb)) *
      runHours *
      (1 - line.busyShare)
    if (sandbox.vcpus > Standard.vcpus && line.memPeakMb < 0.75 * Standard.memoryMb && line.busyShare < 0.2) {
      findings.push({
        severity: saving > 0.05 ? "action" : "watch",
        area: "sizing",
        usdPerDay: saving,
        title: `${project.title} runs on ${sandbox.vcpus} vCPU / ${sandbox.memoryMb / 1024} GB but rarely needs it`,
        detail: `Peak memory ${(line.memPeakMb / 1024).toFixed(1)} GB; more than two vCPUs busy in ${(100 * line.busyShare).toFixed(0)}% of ${points.length} points (CPU median ${line.cpuP50.toFixed(0)}%); ${runHours.toFixed(1)} h up a day. A standard sandbox would save about ${usd(saving)} a day, and run its bursts at half speed (\`dream machine move standard\`).`
      })
    }
    if (line.memPeakMb > 0.9 * sandbox.memoryMb) {
      findings.push({
        severity: "watch",
        area: "sizing",
        usdPerDay: 0,
        title: `${project.title} reached ${(line.memPeakMb / 1024).toFixed(1)} of ${sandbox.memoryMb / 1024} GB of memory`,
        detail:
          "Near the ceiling it swaps (E2B doesn't report swap): slower turns, and a candidate for the large size if it keeps happening."
      })
    }
    const flatOut = points.filter((p) => p.cpuPct > 90).length / points.length
    if (flatOut > 0.25) {
      findings.push({
        severity: "watch",
        area: "sizing",
        usdPerDay: 0,
        title: `${project.title} runs its ${sandbox.vcpus} vCPUs flat out ${(100 * flatOut).toFixed(0)}% of the time it's up`,
        detail: "Turns wait on CPU; the large size would finish them sooner."
      })
    }
    if (line.diskPct !== undefined && line.diskPct > 70) {
      findings.push({
        severity: line.diskPct > 85 ? "action" : "watch",
        area: "sizing",
        usdPerDay: 0,
        title: `${project.title}'s disk is ${line.diskPct.toFixed(0)}% full`,
        detail: "A full disk fails builds and installs; caches under /home/user are the usual culprit."
      })
    }
  }

  // --- Macs -----------------------------------------------------------------------------------------
  const macRows = inputs.ledger.filter((row) => row.meter === "mac_session" && row.at >= d0 && row.at < d1)
  for (const row of macRows) {
    const instance = row.dimensions.instance ?? row.id
    const minutes = (row.quantities.ms ?? 0) / MinuteMs
    const rate = macHourly(row.quantities.vcpus ?? 4)
    const idleMinutes = (row.quantities.idle_ms ?? 0) / MinuteMs
    if (row.dimensions.stop_reason === "deadline") {
      findings.push({
        severity: "action",
        area: "macs",
        usdPerDay: row.cost,
        title: `${title(row.project)}'s Mac ${instance} ran to its deadline (${minutes.toFixed(0)} min, ${usd(row.cost)})`,
        detail:
          "Namespace destroyed it at its cap: either hours of real work, or Dream kept it alive for nothing. Its activity log says which."
      })
    }
    if (idleMinutes > 10) {
      findings.push({
        severity: idleMinutes > 30 ? "action" : "watch",
        area: "macs",
        usdPerDay: (idleMinutes / 60) * rate,
        title: `${title(row.project)}'s Mac ${instance} sat idle ${idleMinutes.toFixed(0)} min before it stopped (${row.dimensions.stop_reason ?? "?"})`,
        detail: `${usd((idleMinutes / 60) * rate)} of its ${usd(row.cost)} was the idle tail.`
      })
    }
    if (row.dimensions.source === "usage_events" && minutes > 60) {
      findings.push({
        severity: "info",
        area: "macs",
        usdPerDay: row.cost,
        title: `${title(row.project)}'s Mac ${instance} ran ${minutes.toFixed(0)} min (${usd(row.cost)}), before Macs had an activity log`,
        detail: "Nothing tells its work from idle time; Macs since 2026-11-08 have their probes logged."
      })
    }
  }
  const instances = [...new Set(inputs.mac.filter((e) => e.at >= d0 - HourMs && e.at < d1).map((e) => e.instance))]
  for (const instance of instances) {
    const entries = inputs.mac.filter((e) => e.instance === instance)
    const probes = entries.filter((e) => e.kind === "probe")
    const failed = probes.filter((e) => e.detail.failure !== undefined)
    const lingering = probes.filter((e) => {
      const probe = e.detail.probe as { busy?: boolean; lingering?: boolean } | undefined
      return probe?.busy === false && probe.lingering === true
    })
    const project = entries[0]?.project
    const rate = macHourly(4)
    if (lingering.length >= 3) {
      const minutes = lingering.length * 5
      findings.push({
        severity: lingering.length >= 9 ? "action" : "watch",
        area: "macs",
        usdPerDay: (minutes / 60) * rate,
        title: `${title(project)}'s Mac ${instance} was held about ${minutes} min by something quiet the agent left running`,
        detail:
          "A leftover job keeps the Mac for up to an hour (MacHeldTimeout). Worth seeing what it was, in the probe details."
      })
    }
    if (failed.length >= 3) {
      findings.push({
        severity: "watch",
        area: "macs",
        usdPerDay: ((failed.length * 5) / 60) * rate,
        title: `${title(project)}'s Mac ${instance}: ${failed.length} of ${probes.length} probes failed`,
        detail: `A failing probe holds the Mac for an hour. First failure: ${String(failed[0]?.detail.failure).slice(0, 160)}`
      })
    }
  }
  const tracked = new Set(inputs.mac.map((e) => e.instance))
  for (const mac of inputs.macs ?? []) {
    const upMs = inputs.now - mac.created
    const rate = macHourly(mac.vcpus)
    if (tracked.has(mac.id) || upMs < 30 * MinuteMs) continue
    const left = mac.deadline === undefined ? 4 : Math.max(0, (mac.deadline - inputs.now) / HourMs)
    findings.push({
      severity: "action",
      area: "macs",
      usdPerDay: rate * (upMs / HourMs + left),
      title: `A Mac outside Dream's projects (${mac.id}, ${mac.vcpus} vCPU) has been up ${(upMs / HourMs).toFixed(1)} h`,
      detail: `${
        mac.purpose ??
        Object.entries(mac.labels)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
      }. ${usd(rate)} an hour; ${left.toFixed(1)} h to its deadline. No project meters it.`
    })
  }

  // --- Browsers -------------------------------------------------------------------------------------
  for (const session of inputs.browsers ?? []) {
    const end = session.end ?? inputs.now
    const hours = (end - session.start) / HourMs
    if (session.status === "TIMED_OUT" && session.start >= d0 && session.start < d1) {
      findings.push({
        severity: "watch",
        area: "browsers",
        usdPerDay: hours * Prices.browserHour,
        title: `${title(session.project)}'s browser ${session.id} ran to its timeout (${(hours * 60).toFixed(0)} min)`,
        detail: "Nobody stopped it: the agent didn't call `dream browser stop`, and Dream doesn't stop an idle one."
      })
    }
    if (session.status === "RUNNING" && hours > 0.5) {
      findings.push({
        severity: "action",
        area: "browsers",
        usdPerDay: hours * Prices.browserHour,
        title: `${title(session.project)}'s browser ${session.id} has been running ${(hours * 60).toFixed(0)} min`,
        detail: "Still open now."
      })
    }
  }

  // --- Storage --------------------------------------------------------------------------------------
  const lastStorage = new Map<string, LedgerRow>()
  for (const row of inputs.ledger) {
    if (row.meter !== "storage_day" || row.project === undefined) continue
    const previous = lastStorage.get(row.project)
    if (previous === undefined || row.at > previous.at) lastStorage.set(row.project, row)
  }
  const orphaned = [...lastStorage.values()].filter(
    (row) => !known.has(row.project!) && !row.project!.startsWith("prj_dev_")
  )
  if (orphaned.length > 0) {
    const bytes = orphaned.reduce((sum, row) => sum + (row.quantities.bytes ?? 0), 0)
    findings.push({
      severity: "watch",
      area: "storage",
      usdPerDay: (bytes / 1e9) * (0.015 / 30),
      title: `${orphaned.length} deleted project(s) still have ${(bytes / 1e6).toFixed(1)} MB of media stored`,
      detail: `${orphaned.map((row) => row.project).join(", ")}: deleted before deletion removed media, or the delete failed partway.`
    })
  }
  for (const bucket of inputs.buckets ?? []) {
    if (bucket.bytes > 5e9) {
      findings.push({
        severity: "watch",
        area: "storage",
        usdPerDay: (Math.max(0, bucket.bytes - 10e9) / 1e9) * (0.015 / 30),
        title: `R2 bucket ${bucket.name} holds ${(bucket.bytes / 1e9).toFixed(1)} GB in ${bucket.objects} objects`,
        detail: "R2 is free to 10 GB across the account."
      })
    }
  }
  if (inputs.d1Bytes !== undefined && inputs.d1Bytes > 1e9) {
    findings.push({
      severity: "watch",
      area: "storage",
      usdPerDay: 0,
      title: `D1 is ${(inputs.d1Bytes / 1e9).toFixed(2)} GB`,
      detail: "D1 databases cap at 10 GB."
    })
  }

  // --- Turns that kept a sandbox up with little to show -----------------------------------------------
  // A turn held for background work (up to three hours, `limits.long` in dreamd's harness/Background.ts) keeps the
  // sandbox up whether or not that work does anything. The sandbox's CPU says whether it did; without samples, the
  // turn's output does.
  for (const turn of inputs.turns) {
    if (turn.end < d0 || turn.end >= d1) continue
    const minutes = (turn.end - turn.start) / MinuteMs
    if (minutes < 45) continue
    const sandbox = inputs.live.find((s) => s.metadata.projectId === turn.project && s.metadata.purpose === undefined)
    const rate = sandboxHourly(sandbox?.vcpus ?? Standard.vcpus, sandbox?.memoryMb ?? Standard.memoryMb)
    const during = inputs.load.filter((p) => p.project === turn.project && p.at >= turn.start && p.at <= turn.end)
    const kind = turn.task ? "task" : "turn"
    if (during.length >= 6) {
      const idleMinutes = (during.filter((p) => p.cpuPct < IdleCpuPct).length / during.length) * minutes
      if (idleMinutes < 45) continue
      findings.push({
        severity: "watch",
        area: "turns",
        usdPerDay: (idleMinutes / 60) * rate,
        title: `${title(turn.project)}: a ${minutes.toFixed(0)}-min ${kind} left its sandbox idle for about ${idleMinutes.toFixed(0)} min`,
        detail: `CPU under ${IdleCpuPct}% in ${during.filter((p) => p.cpuPct < IdleCpuPct).length} of ${during.length} samples. A turn held for background work that waits (a sleep loop, a Monitor on something slow) keeps the sandbox up the whole time.`
      })
    } else if (turn.outputTokens !== undefined && turn.outputTokens / minutes < 100) {
      findings.push({
        severity: "watch",
        area: "turns",
        usdPerDay: (minutes / 60) * rate,
        title: `${title(turn.project)}: a ${minutes.toFixed(0)}-min ${kind} wrote only ${turn.outputTokens} tokens`,
        detail: "A turn waiting on something (a hung command, a long sleep) keeps its sandbox up the whole time."
      })
    }
  }

  // --- The ledger itself --------------------------------------------------------------------------------
  const lastRun = Math.max(0, ...inputs.ledger.filter((row) => row.meter === "sandbox_run").map((row) => row.at))
  const lastE2B = Math.max(0, ...(inputs.e2bLog ?? []).map((run) => run.end))
  if (lastE2B > 0 && lastE2B - lastRun > 2 * HourMs) {
    findings.push({
      severity: "action",
      area: "ledger",
      usdPerDay: 0,
      title: `The ledger's last sandbox run is ${((inputs.now - lastRun) / HourMs).toFixed(1)} h old, but E2B has newer ones`,
      detail:
        "Neither the webhook nor the hourly backfill is recording: check the Worker's logs and the webhook (POST /admin/metering/e2b-webhook)."
    })
  }
  if (inputs.e2bLog !== undefined && inputs.now - d0 < 6 * DayMs) {
    const fromLog = inputs.e2bLog
      .filter((run) => run.end >= d0 && run.end < d1)
      .reduce(
        (sum, run) =>
          sum + (run.ms / 1000) * (run.vcpus * Prices.vcpuSecond + (run.memoryMb / 1024) * Prices.gibSecond),
        0
      )
    const fromLedger = byCenter.sandbox?.day ?? 0
    if (Math.abs(fromLog - fromLedger) > Math.max(0.25, 0.1 * fromLog)) {
      findings.push({
        severity: "watch",
        area: "ledger",
        usdPerDay: Math.abs(fromLog - fromLedger),
        title: `The ledger has ${usd(fromLedger)} of sandbox time on ${inputs.day}; E2B's log says ${usd(fromLog)}`,
        detail: "Runs missing from the ledger (or counted twice): the backfill should close the gap within the hour."
      })
    }
  }
  for (const source of inputs.missing) {
    findings.push({
      severity: "info",
      area: "ledger",
      usdPerDay: 0,
      title: `Couldn't read ${source}`,
      detail: undefined
    })
  }

  const rank: Record<Severity, number> = { action: 0, watch: 1, info: 2 }
  findings.sort((a, b) => b.usdPerDay - a.usdPerDay || rank[a.severity] - rank[b.severity])
  return {
    day: inputs.day,
    spend: { byCenter, total },
    projects,
    overhead,
    sizing,
    storage: { buckets: inputs.buckets ?? [], d1Bytes: inputs.d1Bytes, d1Tables: inputs.d1Tables },
    findings,
    missing: inputs.missing
  }
}

const describeMachine = (machine: Partial<Record<MachineCause, number>>, prefix = "") =>
  Object.entries(machine)
    .filter(([cause, cost]) => cause.startsWith(prefix) && (cost ?? 0) >= 0.005)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([cause, cost]) => `${cause} ${usd(cost ?? 0)}`)
    .join(", ")

/** Exit code for a daily job: 2 when something needs action. */
export const exitCode = (result: Review) => (result.findings.some((f) => f.severity === "action") ? 2 : 0)
