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
  sshSessions: Schema.Int,
  /** Build and test tools running (any process of the Mac's user), by name. */
  tools: Schema.Array(Schema.String),
  /** The agent's processes (under its sessions, or left behind by them) and the CPU they use, in % of a core. */
  agentProcesses: Schema.Int,
  agentCpu: Schema.Number,
  /** Every process's CPU, in % of a core (a booted simulator counts here). */
  totalCpu: Schema.Number,
  load1: Schema.optionalKey(Schema.Number),
  simulators: Schema.Int
})
export type MacProbe = typeof MacProbe.Type

/**
 * The probe's command, for `/bin/sh` as the Mac's user. The command service runs it with a bare PATH. It prints
 * `self <pid>`, `load { 1m 5m 15m }`, `cpu <total>`, `sims <n>`, then `p <pid> <ppid> <me|other> <%cpu> <path>`
 * for the Mac user's processes outside macOS's own directories and for every sshd process.
 */
export const macProbeCommand: ReadonlyArray<string> = [
  "/bin/sh",
  "-c",
  [
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    'me=$(id -un); echo "self $$"; echo "load $(sysctl -n vm.loadavg)"',
    `ps -Ao pid=,ppid=,user=,pcpu=,comm= | awk -v me="$me" '${[
      '{ total += $4; path = $5; for (i = 6; i <= NF; i++) path = path " " $i }',
      "path ~ /\\/launchd_sim$/ { sims++ }",
      "($3 == me && path !~ /^\\/(System|usr\\/libexec|usr\\/sbin)\\//) || path ~ /\\/sshd[^\\/]*$/" +
        ' { print "p", $1, $2, ($3 == me ? "me" : "other"), $4, path }',
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
  /^\/(System|Library|Applications|usr\/libexec|usr\/sbin)\//.test(path) || path.includes("/CoreSimulator/")

interface Process {
  readonly pid: number
  readonly ppid: number
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
  let load1: number | undefined
  let totalCpu = 0
  let simulators = 0
  const processes: Array<Process> = []
  for (const line of output.split("\n")) {
    const [kind, ...rest] = line.trim().split(" ")
    if (kind === "self") self = Number(rest[0])
    else if (kind === "load") {
      const first = Number(rest.find((part) => part !== "{"))
      if (Number.isFinite(first)) load1 = first
    } else if (kind === "cpu") totalCpu = Number(rest[0]) || 0
    else if (kind === "sims") simulators = Number(rest[0]) || 0
    else if (kind === "p" && rest.length >= 5) {
      const [pid, ppid, owner, cpu, ...path] = rest
      const full = path.join(" ")
      processes.push({
        pid: Number(pid),
        ppid: Number(ppid),
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

  // One per session: the sshd process the session's command runs under (privilege separation adds a parent).
  const sessions = live.filter((p) => isSshd(p) && (children.get(p.pid) ?? []).some((child) => !isSshd(child)))
  const roots = [
    ...sessions.flatMap((s) => (children.get(s.pid) ?? []).filter((child) => !isSshd(child))),
    ...live.filter((p) => p.mine && p.ppid === 1 && !isSshd(p) && !systemOwned(p.path))
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
  return {
    busy: sessions.length > 0 || tools.length > 0 || agentCpu >= BusyCpu,
    sshSessions: sessions.length,
    tools,
    agentProcesses: agent.size,
    agentCpu,
    totalCpu: Math.round(totalCpu * 10) / 10,
    ...(load1 === undefined ? {} : { load1 }),
    simulators
  }
}
