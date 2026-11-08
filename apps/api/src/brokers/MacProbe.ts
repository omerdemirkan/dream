/**
 * What's running on a rented Mac, read through Namespace's command service (no ssh, about half a second): the
 * agent's ssh sessions, the processes it started, build tools at work, CPU and booted simulators. The ProjectDO
 * runs it on each check of a running Mac, counts a busy Mac as in use, and keeps what it saw in the Mac's activity
 * log (`db/MacActivity.ts`).
 *
 * The agent's processes are the ones under an ssh session and the ones its sessions left behind (`nohup`, `&`): its
 * user's processes that launchd adopted, other than macOS's and Xcode's own services. A booted simulator isn't one:
 * a simulator with an app open burns a core or more with nobody using it, so its processes never make a Mac busy.
 */
import { Schema } from "effect"

export const MacProbe = Schema.Struct({
  /** Something the agent runs is at work: an ssh session is open, a build tool runs, or its processes use CPU. */
  busy: Schema.Boolean,
  /** Commands running over ssh (`dream mac ssh`, `dream mac cp`) right now. */
  sshSessions: Schema.Int,
  /** Build and test tools running (any process of the Mac's user), by name. */
  tools: Schema.Array(Schema.String),
  /** The agent's processes (under its sessions, or left behind by them) and the CPU they use, in % of a core. */
  agentProcesses: Schema.Int,
  agentCpu: Schema.Number,
  /**
   * Not busy, but the agent left something running on it (a script between two builds, a wait loop, a server): it
   * may be about to work again, so the Mac isn't stopped for being quiet, only after a longer wait.
   */
  lingering: Schema.Boolean,
  /** Every process's CPU, in % of a core (a booted simulator counts here). */
  totalCpu: Schema.Number,
  load1: Schema.optionalKey(Schema.Number),
  simulators: Schema.Int
})
export type MacProbe = typeof MacProbe.Type

/**
 * The probe's command, for `/bin/sh` as the Mac's user. The command service runs it with a bare PATH. It prints
 * `self <pid> <ppid>`, `load { 1m 5m 15m }`, `cpu <total>`, `sims <n>`, then `p <pid> <ppid> <pgid> <me|other>
 * <%cpu> <command>` for the Mac user's processes outside macOS's and the simulators' own directories, and for every
 * sshd process.
 *
 * On Namespace's Macs (checked 2026-11-08, macOS 27) there is no sshd session: Namespace's agent in the VM
 * (`/opt/namespace/vmguest`) runs each ssh command as a child of its own, as it runs this probe. So the probe's
 * parent tells which processes are ssh commands. A process an ssh command left running (`cmd &`) goes to launchd
 * (pid 1), under the bare name it was started by (`sleep`, not `/bin/sleep`), as some of macOS's own daemons are
 * (`cloudphotod`). What tells them apart is the process group: launchd starts each daemon as the leader of its own,
 * and what an ssh command left keeps the command's. macOS's `nohup` refuses to run there ("can't detach from
 * console"); `cmd > log 2>&1 < /dev/null &` works.
 */
export const macProbeCommand: ReadonlyArray<string> = [
  "/bin/sh",
  "-c",
  [
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    'me=$(id -un); echo "self $$ $PPID"; echo "load $(sysctl -n vm.loadavg)"',
    `ps -Ao pid=,ppid=,pgid=,user=,pcpu=,comm= | awk -v me="$me" '${[
      '{ total += $5; path = $6; for (i = 7; i <= NF; i++) path = path " " $i }',
      "path ~ /(^|\\/)launchd_sim$/ { sims++ }",
      "($4 == me && path !~ /^\\/(System|usr\\/libexec|usr\\/sbin)\\// && path !~ /\\/CoreSimulator\\//) || path ~ /\\/sshd[^\\/]*$/" +
        ' { print "p", $1, $2, $3, ($4 == me ? "me" : "other"), $5, path }',
      'END { printf "cpu %.1f\\nsims %d\\n", total, sims }'
    ].join(" ")}'`
  ].join("; ")
]

/** Build and test tools whose running process means the Mac is at work, whoever started it. */
const BuildTools = new Set([
  "xcodebuild",
  "xctest",
  "simctl",
  "swift-build",
  "swift-frontend",
  "swift-driver",
  "swiftc",
  "clang",
  "ld",
  "ibtool",
  "actool",
  "codesign",
  "pod",
  "fastlane",
  "xcodegen",
  "tuist",
  "carthage"
])

/** The agent's processes use at least this much CPU (% of a core) when they're working rather than waiting. */
const BusyCpu = 5

/** Processes launchd adopts that are macOS's, Xcode's or the simulators' own, not something the agent left. */
const systemOwned = (path: string) =>
  /^\/(System|Library|Applications|usr\/libexec|usr\/sbin)\//.test(path) ||
  path.includes("/CoreSimulator/") ||
  LaunchdHelpers.has(path)

/** launchd's helpers and a simulator's launchd, which run as the user under a bare name. */
const LaunchdHelpers = new Set(["xpcproxy", "launchd_sim"])

interface Process {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly mine: boolean
  readonly cpu: number
  readonly name: string
  readonly path: string
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const isSshd = (process: Process) => process.name.startsWith("sshd")

/** Reads the probe's output; lines it doesn't know are skipped, so a partial answer still says what it can. */
export const parseMacProbe = (output: string): MacProbe => {
  let self: number | undefined
  let runner: number | undefined
  let load1: number | undefined
  let totalCpu = 0
  let simulators = 0
  const processes: Array<Process> = []
  for (const line of output.split("\n")) {
    const [kind, ...rest] = line.trim().split(" ")
    if (kind === "self") {
      self = Number(rest[0])
      if (rest[1] !== undefined) runner = Number(rest[1])
    } else if (kind === "load") {
      const first = Number(rest.find((part) => part !== "{"))
      if (Number.isFinite(first)) load1 = first
    } else if (kind === "cpu") totalCpu = Number(rest[0]) || 0
    else if (kind === "sims") simulators = Number(rest[0]) || 0
    else if (kind === "p" && rest.length >= 6) {
      const [pid, ppid, pgid, owner, cpu, ...path] = rest
      const full = path.join(" ")
      processes.push({
        pid: Number(pid),
        ppid: Number(ppid),
        pgid: Number(pgid),
        mine: owner === "me",
        cpu: Number(cpu) || 0,
        name: baseName(full),
        path: full
      })
    }
  }
  // The probe's own shell and what it ran aren't the agent's.
  const live = processes.filter((p) => p.pid !== self && p.ppid !== self)
  const children = new Map<number, Array<Process>>()
  for (const p of live) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])

  // One per ssh command: the user's processes Namespace's agent started besides this probe, or, with a plain sshd,
  // the session's command under it (privilege separation adds a parent).
  const commands = runner === undefined || runner <= 1 ? [] : live.filter((p) => p.mine && p.ppid === runner)
  const sshdSessions = live.filter((p) => isSshd(p) && (children.get(p.pid) ?? []).some((child) => !isSshd(child)))
  const sessionCount = commands.length + sshdSessions.length
  const roots = [
    ...commands,
    ...sshdSessions.flatMap((s) => (children.get(s.pid) ?? []).filter((child) => !isSshd(child))),
    // Left behind: adopted by launchd but still in another process's group, unlike launchd's own jobs.
    ...live.filter((p) => p.mine && p.ppid === 1 && p.pgid !== p.pid && !isSshd(p) && !systemOwned(p.path))
  ]
  const agent = new Map<number, Process>()
  const visit = (p: Process) => {
    if (agent.has(p.pid)) return
    agent.set(p.pid, p)
    for (const child of children.get(p.pid) ?? []) visit(child)
  }
  roots.forEach(visit)

  const tools = [...new Set(live.filter((p) => p.mine && BuildTools.has(p.name)).map((p) => p.name))].sort()
  const agentCpu = Math.round([...agent.values()].reduce((sum, p) => sum + p.cpu, 0) * 10) / 10
  const busy = sessionCount > 0 || tools.length > 0 || agentCpu >= BusyCpu
  return {
    busy,
    sshSessions: sessionCount,
    tools,
    agentProcesses: agent.size,
    agentCpu,
    lingering: !busy && agent.size > 0,
    totalCpu: Math.round(totalCpu * 10) / 10,
    ...(load1 === undefined ? {} : { load1 }),
    simulators
  }
}
