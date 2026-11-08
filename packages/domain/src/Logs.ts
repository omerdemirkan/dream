/**
 * The project's log: what Dream saw happen to what the agent built, kept where the agent can read it with
 * `dream logs`, so it can notice trouble and work out its cause without the person relaying it.
 *
 * It has two halves, which the CLI merges by time. dreamd writes the sandbox's half to `~/.dream/logs/<source>.jsonl`
 * (the output of servers the agent starts, scheduled commands and tasks, relay deliveries to the app, the machine,
 * and dreamd's own events), which outlives sleeps, refreshes and moves with the home directory. The ProjectDO keeps
 * the half only the Worker sees (requests to the published app, notifications the apps send, relay connections,
 * refreshes and visits that never reached the app), which `SandboxRpcs.ReadLog` returns.
 */
import { DateTime, Schema } from "effect"

/**
 * Where an entry comes from:
 * - `gateway`: a request to the published app, as Dream's gateway saw it (status, time to answer, or why it never
 *   reached the app);
 * - `app`: a line a server the agent started wrote to its output (`name` is its log file's name);
 * - `run`, `task`: a scheduled `--run` command or `--task` finishing, with its output or report (`name`: the wake);
 * - `relay`: a relay's event handed to the app, or the relay's connection failing (`name`: the relay);
 * - `notify`: a notification an app sent with `dream notify`, and what became of it (`name`: the app);
 * - `machine`: memory, swap or disk running short, or the kernel killing a process for memory;
 * - `dream`: Dream itself: dreamd starting and restarting, refreshes, sleeps and wakes, background work it stopped,
 *   the check of the published URL after a turn.
 */
export const LogSource = Schema.Literals(["gateway", "app", "run", "task", "relay", "notify", "machine", "dream"])
export type LogSource = typeof LogSource.Type
export const LogSources: ReadonlyArray<LogSource> = LogSource.literals

/** `warn` and `error` are what `dream logs --errors` shows. */
export const LogLevel = Schema.Literals(["info", "warn", "error"])
export type LogLevel = typeof LogLevel.Type

/**
 * One reading of the machine, which dreamd takes about once a minute while the sandbox is awake and writes to
 * `machine.jsonl` (an entry with `sample`). Sizes are in MB. Stable: read by tools outside the agent too.
 */
export const MachineSample = Schema.Struct({
  memoryTotalMb: Schema.Int,
  /** The kernel's MemAvailable: what new work can use without swapping. */
  memoryAvailableMb: Schema.Int,
  swapTotalMb: Schema.Int,
  swapUsedMb: Schema.Int,
  /** The file system holding the home directory. */
  diskTotalMb: Schema.Int,
  diskFreeMb: Schema.Int,
  /** The one-minute load average, and the CPUs it compares with. */
  load1: Schema.Number,
  cpus: Schema.Int,
  /** Processes the kernel has killed for memory since the sandbox booted (`/proc/vmstat` `oom_kill`). */
  oomKills: Schema.Int
})
export type MachineSample = typeof MachineSample.Type

export const LogEntry = Schema.Struct({
  at: Schema.DateTimeUtc,
  source: LogSource,
  level: LogLevel,
  /** One line. */
  text: Schema.String,
  /** What it's about within its source: an app log's name, a wake id, a relay id, an app id. */
  name: Schema.optionalKey(Schema.String),
  /** Further lines: a command's output, a task's report, what a page check saw. */
  detail: Schema.optionalKey(Schema.String),
  /** `machine`: the reading this entry reports. Routine readings show only when `machine` is asked for. */
  sample: Schema.optionalKey(MachineSample)
})
export type LogEntry = typeof LogEntry.Type

/** Where dreamd writes the sandbox's half: `<source>.jsonl`, and the one before it, `<source>.1.jsonl`. */
export const LogDir = "/home/user/.dream/logs"

/**
 * Where servers the agent starts write their output, by convention (`… >> ~/logs/web.log 2>&1`): dreamd adds what
 * they write to the project's log as `app` entries named after the file. It does the same for any file a server
 * listening on a port writes its output to, wherever it is.
 */
export const AppLogDir = "/home/user/logs"

/** Which entries to read; absent means all. */
export const LogQuery = Schema.Struct({
  sources: Schema.optionalKey(Schema.Array(LogSource)),
  /** Only entries from this time on. */
  since: Schema.optionalKey(Schema.DateTimeUtc),
  /** Only warnings and errors. */
  errors: Schema.optionalKey(Schema.Boolean),
  /** Only entries with this `name` (an app log, a wake, a relay, an app). */
  name: Schema.optionalKey(Schema.String),
  /** The latest this many (at most `LogLimits.read`). */
  limit: Schema.optionalKey(Schema.Int)
})
export type LogQuery = typeof LogQuery.Type

export const LogLimits = {
  /** The most entries one read returns. */
  read: 1000,
  /** Entries `dream logs` shows when not given `--limit`. */
  shown: 60,
  /** A line's most characters; longer ones are cut. */
  text: 500,
  /** A detail's most characters, kept from its end (where an error usually is). */
  detail: 8000,
  /** The ProjectDO keeps this many entries, for at most `remoteDays`. */
  remoteEntries: 5000,
  remoteDays: 14
} as const

/** Whether `entry` is one `query` asks for (all but `limit`). */
export const matchesLogQuery = (entry: LogEntry, query: LogQuery): boolean =>
  (query.sources === undefined || query.sources.includes(entry.source)) &&
  (query.since === undefined || !DateTime.isLessThan(entry.at, query.since)) &&
  (query.errors !== true || entry.level !== "info") &&
  (query.name === undefined || entry.name === query.name)

/** `entry` within `LogLimits`: its line cut to length, its detail to its end. */
export const boundedLogEntry = (entry: LogEntry): LogEntry => {
  const text = entry.text.length > LogLimits.text ? `${entry.text.slice(0, LogLimits.text - 1)}…` : entry.text
  const detail =
    entry.detail === undefined || entry.detail.length <= LogLimits.detail
      ? entry.detail
      : `…${entry.detail.slice(-(LogLimits.detail - 1))}`
  return { ...entry, text, ...(detail === undefined ? {} : { detail }) }
}

/**
 * Trouble Dream noticed on its own and told the agent about (`AgentEvent.Alert`'s `noticed`), once per problem:
 * - `server-errors`: the published app answered requests with server errors (5xx);
 * - `unreachable`: requests to the published app never reached it (nothing listening on its port, or no answer);
 * - `memory`: the machine is running short of memory and swap;
 * - `out-of-memory`: the kernel killed a process to free memory;
 * - `disk`: the disk is nearly full;
 * - `failing`: a scheduled command keeps failing (Dream stops waking the agent for each failure; see `RunResult`).
 */
export const Trouble = Schema.Literals(["server-errors", "unreachable", "memory", "out-of-memory", "disk", "failing"])
export type Trouble = typeof Trouble.Type
