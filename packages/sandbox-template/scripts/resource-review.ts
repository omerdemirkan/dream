/**
 * Dream's daily resource review: what it spent, on what, and what of it was waste, ranked by dollars a day.
 * Read-only: it reads the production D1, E2B, Browserbase, Namespace and R2 through the workspace's connections and
 * changes nothing. It prints no secrets.
 *
 *   node packages/sandbox-template/scripts/resource-review.ts [--day YYYY-MM-DD] [--json] [--no-e2b-log]
 *
 * `--day` is the UTC day reviewed, yesterday by default (the last complete one); what's running now (sandboxes,
 * Macs, browsers) is checked as of now. It covers:
 *
 * - spend by cost center and project, against the median of the seven days before, with spikes flagged
 * - each project's E2B machine time by cause: turns, the idle tail after them, wakes with no turn (by what woke
 *   it: a delivery, a scheduled command or task, a visit, a relay, a refresh), and refresh donors; projects whose
 *   machine time is far beyond their turn time, wakes that never make a turn, refresh churn, runs that go on long
 *   after their turn, and throwaway sandboxes that live too long
 * - sandbox sizes against what they use (E2B's metrics, and `sandbox_usage` kept hourly): large ones that never
 *   need it, standard ones at their memory ceiling or CPU bound, disks filling up
 * - Macs: idle tails, holds by something quiet the agent left running, deadline hits, probe failures, and Macs
 *   up outside any project
 * - Browserbase sessions that ran to their timeout or are still open
 * - storage: R2 buckets, media of deleted projects, D1's size
 * - the ledger itself: whether it keeps up with E2B, and whether the two agree on the day
 * - turns that ran long with little output, which keep their sandbox up the whole time
 *
 * Exits 2 when a finding needs action, 0 otherwise (1 when it couldn't run).
 */
import { exitCode, type Review, review } from "./review/analyze.ts"
import { readInputs } from "./review/sources.ts"

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const usd = (n: number) => `$${n.toFixed(2)}`
const pad = (text: string, width: number) => (text.length >= width ? text : text + " ".repeat(width - text.length))
const lpad = (text: string, width: number) => (text.length >= width ? text : " ".repeat(width - text.length) + text)

const print = (result: Review) => {
  const out: Array<string> = []
  out.push(`Dream resource review for ${result.day} (UTC), against the 7 days before`)
  out.push("")
  out.push(`${pad("spend", 12)}${lpad("day", 10)}${lpad("usual", 10)}${lpad("7 days", 10)}`)
  for (const [center, line] of Object.entries(result.spend.byCenter)) {
    out.push(
      `${pad(`  ${center}`, 12)}${lpad(usd(line.day), 10)}${lpad(usd(line.median), 10)}${lpad(usd(line.week), 10)}`
    )
  }
  const t = result.spend.total
  out.push(`${pad("  total", 12)}${lpad(usd(t.day), 10)}${lpad(usd(t.median), 10)}${lpad(usd(t.week), 10)}`)

  if (result.projects.length > 0) {
    out.push("")
    out.push("projects, most expensive first (machine time by cause)")
    for (const project of result.projects.slice(0, 12)) {
      const causes = Object.entries(project.machine)
        .filter(([, cost]) => (cost ?? 0) >= 0.005)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .map(([cause, cost]) => `${cause} ${usd(cost ?? 0)}`)
        .join(", ")
      const centers = Object.entries(project.byCenter)
        .map(([center, cost]) => `${center} ${usd(cost)}`)
        .join(", ")
      out.push(`  ${pad(project.title.slice(0, 32), 33)}${lpad(usd(project.total), 8)}  ${centers}`)
      out.push(
        `  ${" ".repeat(33)}${lpad("", 8)}  ${project.machineHours.toFixed(1)} h up, ${project.turnHours.toFixed(1)} h of turns, ${project.wakesWithoutTurn} wakes with no turn, ${project.refreshes} refreshes`
      )
      if (causes !== "") out.push(`  ${" ".repeat(43)}${causes}`)
    }
  }
  const overhead = Object.entries(result.overhead).filter(([, cost]) => cost >= 0.005)
  if (overhead.length > 0) {
    out.push(
      `  ${pad("overhead (no project)", 33)}${lpad("", 8)}  ${overhead.map(([cause, cost]) => `${cause} ${usd(cost)}`).join(", ")}`
    )
  }

  if (result.sizing.length > 0) {
    out.push("")
    out.push("sandbox sizes against use (E2B's samples and the hourly record)")
    for (const line of result.sizing) {
      out.push(
        `  ${pad(line.title.slice(0, 32), 33)}${line.vcpus} vCPU / ${line.memoryMb / 1024} GB, ${line.hoursPerDay.toFixed(1)} h up a day: CPU median ${line.cpuP50.toFixed(0)}%, p95 ${line.cpuP95.toFixed(0)}%, over 2 vCPUs ${(100 * line.busyShare).toFixed(0)}% of the time, memory peak ${(line.memPeakMb / 1024).toFixed(1)} GB, disk ${line.diskPct === undefined ? "?" : `${line.diskPct.toFixed(0)}%`} (${line.points} points)`
      )
    }
  }
  if (result.storage.buckets.length > 0 || result.storage.d1Bytes !== undefined) {
    out.push("")
    out.push(
      `storage: ${result.storage.buckets.map((b) => `R2 ${b.name} ${(b.bytes / 1e6).toFixed(1)} MB (${b.objects} objects)`).join(", ")}${result.storage.d1Bytes === undefined ? "" : `, D1 ${(result.storage.d1Bytes / 1e6).toFixed(1)} MB`}${
        result.storage.d1Tables === undefined
          ? ""
          : ` (${Object.entries(result.storage.d1Tables)
              .map(([table, rows]) => `${table} ${rows}`)
              .join(", ")} rows)`
      }`
    )
  }

  out.push("")
  if (result.findings.length === 0) out.push("nothing to look at")
  else {
    out.push("findings, by dollars a day")
    for (const finding of result.findings) {
      out.push(
        `  ${pad(finding.severity.toUpperCase(), 7)}${lpad(usd(finding.usdPerDay), 8)}  [${finding.area}] ${finding.title}`
      )
      if (finding.detail !== undefined) out.push(`  ${" ".repeat(17)}${finding.detail}`)
    }
  }
  console.log(out.join("\n"))
}

const main = async () => {
  const now = Date.now()
  const day = arg("day") ?? new Date(now - 86_400_000).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`--day wants YYYY-MM-DD, not ${day}`)
  const inputs = await readInputs({ day, now, withE2BLog: !process.argv.includes("--no-e2b-log") })
  const result = review(inputs)
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2))
  else print(result)
  process.exitCode = exitCode(result)
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error))
  process.exitCode = 1
})
