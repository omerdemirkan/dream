/**
 * The machine, watched while the sandbox is awake. About once a minute dreamd reads memory, swap, disk, load and
 * the kernel's count of processes it killed for memory, and writes the reading to the project's log (`machine.jsonl`,
 * an entry with `sample`, whose shape is `MachineSample`). When memory and swap or the disk run short, or the kernel
 * kills something, the agent gets an `Alert` with `noticed` (once per problem, then not again before a cool-down;
 * `MachineRules`), so it hears about it before the person notices the app slowing down or falling over.
 *
 * Nothing runs while the sandbox sleeps, so neither does this: a reading covers the time the machine was in use.
 */
import { randomUUID } from "node:crypto"
import { cpus, loadavg } from "node:os"
import { statfs } from "node:fs/promises"
import { AgentEvent, EventId, type MachineSample, type Trouble } from "@dream/domain"
import { Context, DateTime, Duration, Effect, FileSystem, Layer, Option, Path, Ref, Schema, Stream } from "effect"
import { DreamdConfig } from "./Config.ts"
import { Inbox } from "./Inbox.ts"
import * as JsonFile from "./JsonFile.ts"
import { ProjectLog } from "./Log.ts"

export const MachineRules = {
  every: Duration.minutes(1),
  /** Memory is short when less than this share of it is available and swap is mostly used (or there's none)... */
  memoryAvailableBelow: 0.1,
  swapUsedAbove: 0.5,
  /** ...at this many readings in a row. */
  shortReadings: 2,
  /** The disk is nearly full below this share free, or this much. */
  diskFreeBelow: 0.05,
  diskFreeMbBelow: 1024,
  /** After telling the agent, not again about the same kind of trouble before this. */
  coolDown: {
    memory: Duration.hours(12),
    "out-of-memory": Duration.hours(6),
    disk: Duration.hours(24)
  }
} as const

type MachineTrouble = Extract<Trouble, "memory" | "out-of-memory" | "disk">

export const MachineState = Schema.Struct({
  /** The kernel's `oom_kill` count at the last reading. */
  oomKills: Schema.optionalKey(Schema.Int),
  /** Readings in a row that found memory short. */
  shortReadings: Schema.Int,
  /** When the agent was last told about each kind of trouble (epoch milliseconds). */
  told: Schema.Struct({
    memory: Schema.optionalKey(Schema.Number),
    "out-of-memory": Schema.optionalKey(Schema.Number),
    disk: Schema.optionalKey(Schema.Number)
  })
})
export type MachineState = typeof MachineState.Type

export const initialMachineState: MachineState = { shortReadings: 0, told: {} }

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`
const megabytes = (mb: number) => (mb < 1024 ? `${mb} MB` : gb(mb))

/** A reading as one line of the log. */
export const describeSample = (sample: MachineSample): string =>
  `memory ${megabytes(sample.memoryAvailableMb)} of ${gb(sample.memoryTotalMb)} available, swap ` +
  `${megabytes(sample.swapUsedMb)} of ${gb(sample.swapTotalMb)} used, disk ${megabytes(sample.diskFreeMb)} of ` +
  `${gb(sample.diskTotalMb)} free, load ${sample.load1.toFixed(2)} on ${sample.cpus} CPUs`

/** `/proc/meminfo`'s figures, in MB. */
export const parseMeminfo = (text: string) => {
  const kb = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text)
    return match === null ? 0 : Number(match[1])
  }
  const mb = (value: number) => Math.round(value / 1024)
  return {
    memoryTotalMb: mb(kb("MemTotal")),
    memoryAvailableMb: mb(kb("MemAvailable")),
    swapTotalMb: mb(kb("SwapTotal")),
    swapUsedMb: mb(kb("SwapTotal") - kb("SwapFree"))
  }
}

/** `/proc/vmstat`'s `oom_kill`. */
export const parseOomKills = (text: string): number => {
  const match = /^oom_kill\s+(\d+)/m.exec(text)
  return match === null ? 0 : Number(match[1])
}

/**
 * What a reading means: the state after it, and the trouble to tell the agent about. The `oom_kill` count starts
 * again in a new sandbox (after a move), so a count lower than the last is a fresh start, not news.
 */
export const judgeSample = (
  state: MachineState,
  sample: MachineSample,
  nowMs: number
): {
  readonly state: MachineState
  readonly troubles: ReadonlyArray<{ readonly kind: MachineTrouble; readonly reason: string }>
} => {
  const troubles: Array<{ kind: MachineTrouble; reason: string }> = []
  const told = { ...state.told }
  const due = (kind: MachineTrouble) =>
    told[kind] === undefined || nowMs - (told[kind] ?? 0) >= Duration.toMillis(MachineRules.coolDown[kind])
  const tell = (kind: MachineTrouble, reason: string) => {
    if (!due(kind)) return
    troubles.push({ kind, reason })
    told[kind] = nowMs
  }

  const killed = state.oomKills === undefined ? 0 : sample.oomKills - state.oomKills
  if (killed > 0) {
    tell(
      "out-of-memory",
      `The machine ran out of memory, and the kernel killed ${killed === 1 ? "a process" : `${killed} processes`} ` +
        "to free some. Whatever it killed is gone: maybe a server of yours, a build, or a tool a subagent ran. " +
        `Now: ${describeSample(sample)}.`
    )
  }

  const memoryShort =
    sample.memoryTotalMb > 0 &&
    sample.memoryAvailableMb < sample.memoryTotalMb * MachineRules.memoryAvailableBelow &&
    (sample.swapTotalMb === 0 || sample.swapUsedMb > sample.swapTotalMb * MachineRules.swapUsedAbove)
  const shortReadings = memoryShort ? state.shortReadings + 1 : 0
  if (shortReadings >= MachineRules.shortReadings) {
    tell(
      "memory",
      `The machine is short of memory: ${megabytes(sample.memoryAvailableMb)} of ${gb(sample.memoryTotalMb)} ` +
        `available, with ${megabytes(sample.swapUsedMb)} of ${gb(sample.swapTotalMb)} of swap in use, for ` +
        `${shortReadings} readings in a row. Everything slows down while it swaps, and when both run out the kernel ` +
        "kills processes. `ps aux --sort=-rss | head` shows what's using it."
    )
  }

  const diskShort =
    sample.diskTotalMb > 0 &&
    (sample.diskFreeMb < sample.diskTotalMb * MachineRules.diskFreeBelow ||
      sample.diskFreeMb < MachineRules.diskFreeMbBelow)
  if (diskShort) {
    tell(
      "disk",
      `The disk is nearly full: ${megabytes(sample.diskFreeMb)} of ${gb(sample.diskTotalMb)} free. Writes fail once ` +
        "it fills (databases, uploads, logs, installs). `du -xsh ~/* ~/.cache 2>/dev/null | sort -h` shows what's " +
        "using it."
    )
  }

  return { state: { oomKills: sample.oomKills, shortReadings, told }, troubles }
}

export class Machine extends Context.Service<
  Machine,
  {
    /** Read the machine every `MachineRules.every`, forever. */
    readonly run: Effect.Effect<never>
    /** One reading now, logged and judged. */
    readonly check: Effect.Effect<void>
  }
>()("@dream/dreamd/Machine") {
  static readonly layer = Layer.effect(
    Machine,
    Effect.gen(function* () {
      const config = yield* DreamdConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const log = yield* ProjectLog
      const inbox = yield* Inbox
      const file = JsonFile.make(MachineState, path.join(config.stateDir, "machine.json"))
      const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        effect.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))
      const loaded = yield* provide(file.read).pipe(Effect.orElseSucceed(() => Option.none<MachineState>()))
      const state = yield* Ref.make(Option.getOrElse(loaded, () => initialMachineState))

      const read = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
      const sample = Effect.gen(function* () {
        const memory = parseMeminfo(yield* read("/proc/meminfo"))
        const disk = yield* Effect.tryPromise(() => statfs(config.home)).pipe(
          Effect.map((s) => ({
            diskTotalMb: Math.round((s.blocks * s.bsize) / 1024 / 1024),
            diskFreeMb: Math.round((s.bavail * s.bsize) / 1024 / 1024)
          })),
          Effect.orElseSucceed(() => ({ diskTotalMb: 0, diskFreeMb: 0 }))
        )
        return {
          ...memory,
          ...disk,
          load1: Math.round((loadavg()[0] ?? 0) * 100) / 100,
          cpus: cpus().length,
          oomKills: parseOomKills(yield* read("/proc/vmstat"))
        } satisfies MachineSample
      })

      const check = Effect.gen(function* () {
        const reading = yield* sample
        const now = yield* DateTime.now
        const judged = judgeSample(yield* Ref.get(state), reading, DateTime.toEpochMillis(now))
        yield* Ref.set(state, judged.state)
        yield* provide(file.write(judged.state)).pipe(Effect.ignore)
        const short =
          judged.state.shortReadings > 0 ||
          (reading.diskTotalMb > 0 && reading.diskFreeMb < reading.diskTotalMb * MachineRules.diskFreeBelow * 2)
        yield* log.append([
          {
            at: now,
            source: "machine",
            level: short ? "warn" : "info",
            text: describeSample(reading),
            sample: reading
          }
        ])
        for (const trouble of judged.troubles) {
          yield* log.note("machine", "error", trouble.reason)
          const event = AgentEvent.cases.Alert.make({
            id: EventId.make(`evt_dreamd_${randomUUID()}`),
            at: now,
            reason: trouble.reason,
            noticed: trouble.kind
          })
          yield* inbox.deliver([event])
          yield* Effect.logWarning("The machine is in trouble; told the agent", { kind: trouble.kind })
        }
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("Couldn't read the machine", cause)))

      return Machine.of({
        check,
        run: Stream.tick(MachineRules.every).pipe(Stream.runForEach(() => check), Effect.andThen(Effect.never))
      })
    })
  )
}
