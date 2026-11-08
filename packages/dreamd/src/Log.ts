/**
 * The sandbox's half of the project's log (`Logs.ts` in @dream/domain). dreamd appends entries to
 * `~/.dream/logs/<source>.jsonl`, one JSON object a line, and moves a file to `<source>.1.jsonl` once it passes
 * `LogFileBytes`, so each source keeps its latest few MB and a chatty app can't push out dreamd's own events. The
 * home directory outlives sleeps, refreshes and moves, so the log does too. `dream logs` reads the files
 * (`readLogFiles`) and merges them with the half the ProjectDO keeps.
 */
import {
  boundedLogEntry,
  LogEntry,
  type LogLevel,
  type LogQuery,
  type LogSource,
  LogSources,
  matchesLogQuery
} from "@dream/domain"
import { Context, DateTime, Effect, FileSystem, Layer, Path, Ref, Schema, Semaphore } from "effect"
import { DreamdConfig } from "./Config.ts"

/** A source's file is moved aside past this size; with the one before it, a source keeps up to twice this. */
export const LogFileBytes = 4 * 1024 * 1024

/** `<dir>/<source>.jsonl`, or the one before it. */
export const logFile = (dir: string, source: LogSource, previous = false) =>
  `${dir}/${source}${previous ? ".1" : ""}.jsonl`

const LogLine = Schema.fromJsonString(Schema.toCodecJson(LogEntry))
const encodeLine = Schema.encodeSync(LogLine)
const decodeLine = Schema.decodeUnknownOption(LogLine)

export interface NoteOptions {
  readonly name?: string | undefined
  readonly detail?: string | undefined
}

export const entryOf = (
  at: DateTime.Utc,
  source: LogSource,
  level: LogLevel,
  text: string,
  more: NoteOptions = {}
): LogEntry => ({
  at,
  source,
  level,
  text,
  ...(more.name === undefined ? {} : { name: more.name }),
  ...(more.detail === undefined || more.detail.length === 0 ? {} : { detail: more.detail })
})

export class ProjectLog extends Context.Service<
  ProjectLog,
  {
    /** Add entries to their sources' files. Never fails: a log that can't be written is itself only logged. */
    readonly append: (entries: ReadonlyArray<LogEntry>) => Effect.Effect<void>
    /** Add one entry, at the current time. */
    readonly note: (source: LogSource, level: LogLevel, text: string, more?: NoteOptions) => Effect.Effect<void>
    /** Where the files are. */
    readonly dir: string
  }
>()("@dream/dreamd/ProjectLog") {
  static readonly layer = Layer.effect(
    ProjectLog,
    Effect.gen(function* () {
      const config = yield* DreamdConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = path.join(config.home, ".dream", "logs")
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
      const sizes = yield* Ref.make(new Map<LogSource, number>())

      const sizeOf = (source: LogSource) =>
        Effect.gen(function* () {
          const known = (yield* Ref.get(sizes)).get(source)
          if (known !== undefined) return known
          return yield* fs.stat(logFile(dir, source)).pipe(
            Effect.map((info) => Number(info.size)),
            Effect.orElseSucceed(() => 0)
          )
        })

      const write = (source: LogSource, lines: string) =>
        Effect.gen(function* () {
          const file = logFile(dir, source)
          const size = yield* sizeOf(source)
          let written = size
          if (size > 0 && size + lines.length > LogFileBytes) {
            yield* fs.rename(file, logFile(dir, source, true))
            written = 0
          }
          yield* fs.writeFileString(file, lines, { flag: "a" })
          const total = written + Buffer.byteLength(lines)
          yield* Ref.update(sizes, (all) => new Map(all).set(source, total))
        }).pipe(
          Effect.catch((error) =>
            Ref.update(sizes, (all) => {
              const next = new Map(all)
              next.delete(source)
              return next
            }).pipe(Effect.andThen(Effect.logWarning(`Couldn't write the ${source} log`, { error: error.message })))
          )
        )

      // One writer at a time, so a rotation never races an append.
      const lock = yield* Semaphore.make(1)
      const append = (entries: ReadonlyArray<LogEntry>) =>
        lock.withPermits(1)(
          Effect.forEach(
            LogSources,
            (source) => {
              const lines = entries
                .filter((entry) => entry.source === source)
                .map((entry) => `${encodeLine(boundedLogEntry(entry))}\n`)
                .join("")
              return lines.length === 0 ? Effect.void : write(source, lines)
            },
            { discard: true }
          )
        )

      return ProjectLog.of({
        dir,
        append,
        note: (source, level, text, more) =>
          Effect.flatMap(DateTime.now, (at) => append([entryOf(at, source, level, text, more)]))
      })
    })
  )
}

/**
 * The entries in `dir` that `query` asks for (all but its `limit`), oldest first. Lines that aren't entries (a
 * write cut short) are skipped.
 */
export const readLogFiles = (dir: string, query: LogQuery) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const sources = query.sources ?? LogSources
    const found: Array<LogEntry> = []
    for (const source of sources) {
      for (const file of [logFile(dir, source, true), logFile(dir, source)]) {
        const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
        for (const line of text.split("\n")) {
          if (line.length === 0) continue
          const entry = decodeLine(line)
          if (entry._tag === "Some" && matchesLogQuery(entry.value, query)) found.push(entry.value)
        }
      }
    }
    return found.sort(byTime)
  })

/** Oldest first; stable for entries at the same time. */
export const byTime = (a: LogEntry, b: LogEntry) => DateTime.toEpochMillis(a.at) - DateTime.toEpochMillis(b.at)
