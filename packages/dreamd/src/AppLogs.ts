/**
 * The output of the servers the agent starts, in the project's log (`app` entries). Servers write wherever they
 * like, often nowhere durable, so Dream gives them a convention, `~/logs/<name>.log` (`AppLogDir` in @dream/domain), and also finds
 * the file any process listening on a TCP port writes its stdout or stderr to, wherever it is. dreamd follows each
 * file as it grows, like `tail -F`, and adds what's new a line at a time: timestamped, named after the file, marked
 * as an error or a warning when it reads like one, with indented lines that follow (a stack trace) as its detail.
 * So `dream logs` shows the app's own errors next to the gateway's requests and the machine's readings, and they
 * outlive the app's terminal.
 *
 * It reads only what's new: each file's position is kept in `app-logs.json`, a file that shrank (truncated, or made
 * again) is read from its start, and one seen for the first time from its last `FirstRead` (stamped with the time it was
 * found). At most `ReadMax` a file a look, so an app that floods its output can't flood the log.
 */
import { Context, DateTime, Duration, Effect, FileSystem, Layer, Option, Path, Ref, Schema, Stream } from "effect"
import { DreamdConfig } from "./Config.ts"
import * as JsonFile from "./JsonFile.ts"
import { entryOf, ProjectLog } from "./Log.ts"

/** How often dreamd reads what's new. */
export const ReadEvery = Duration.seconds(2)
/** How often it looks for listening servers' output files. */
export const FindEvery = Duration.seconds(30)
/** The most it reads of a file a look. */
export const ReadMax = 256 * 1024
/** How much of a file seen for the first time it reads. */
export const FirstRead = 16 * 1024

const looksLikeError =
  /\b(error|errors?:|exception|fatal|panic|traceback|uncaught|unhandled|segmentation fault|econnrefused|eaddrinuse|enoent|eacces|killed)\b/i
const notAnError = /\b(0|no) errors?\b/i
const looksLikeWarning = /\b(warn|warning|deprecated|deprecation)\b/i
/** An access log line with a 5xx status: `GET /x 500 12ms`, `"GET /x HTTP/1.1" 502`. */
const serverErrorLine = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b.*?[\s"]5\d\d\b/

/** How a line of an app's output reads: an error, a warning, or neither. */
export const lineLevel = (line: string): "info" | "warn" | "error" =>
  serverErrorLine.test(line) || (looksLikeError.test(line) && !notAnError.test(line))
    ? "error"
    : looksLikeWarning.test(line)
      ? "warn"
      : "info"

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colours are what it takes out
const ansi = /\u001b\[[0-9;?]*[A-Za-z]/g

/**
 * New output as entries' lines: each line that doesn't start with whitespace begins one, and the indented lines
 * after it (a stack trace's frames) become its detail. Colours are taken out; blank lines are dropped.
 */
export const groupLines = (text: string): ReadonlyArray<{ readonly text: string; readonly detail: string }> => {
  const groups: Array<{ text: string; detail: Array<string> }> = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(ansi, "").replace(/\r/g, "")
    if (line.trim().length === 0) continue
    const last = groups.at(-1)
    if (/^\s/.test(line) && last !== undefined && last.detail.length < 200) last.detail.push(line)
    else groups.push({ text: line.trim(), detail: [] })
  }
  return groups.map((group) => ({ text: group.text, detail: group.detail.join("\n") }))
}

/** A file's name in the log: `web` for `~/logs/web.log`, `server` for `/home/user/app/server.log`. */
export const logName = (file: string): string => {
  const base = file.split("/").at(-1) ?? file
  return base.replace(/\.(log|txt|out|err)$/i, "") || base
}

/** The inodes of the TCP sockets listening in `/proc/net/tcp` or `tcp6` tables. */
export const listeningInodes = (tables: ReadonlyArray<string>): ReadonlySet<string> => {
  const inodes = new Set<string>()
  for (const table of tables) {
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/)
      // sl local rem st tx:rx tr:when retrnsmt uid timeout inode
      if (fields[3] === "0A" && fields[9] !== undefined && fields[9] !== "0") inodes.add(fields[9])
    }
  }
  return inodes
}

/** Whether a process's stdout or stderr target is a file worth following. */
export const followable = (target: string, logDir: string): boolean =>
  target.startsWith("/") &&
  !target.startsWith("/dev/") &&
  !target.startsWith("/proc/") &&
  !target.endsWith(" (deleted)") &&
  !target.startsWith(`${logDir}/`)

const Position = Schema.Struct({ offset: Schema.Number })
export const AppLogState = Schema.Struct({
  files: Schema.Record(Schema.String, Position),
  /** Output files of listening servers found outside `AppLogDir`, kept so they're still followed once it stops. */
  found: Schema.Array(Schema.String)
})
export type AppLogState = typeof AppLogState.Type

export class AppLogs extends Context.Service<
  AppLogs,
  {
    /** Follow the files forever. */
    readonly run: Effect.Effect<never>
    /** One look: find files when due, and add what's new. */
    readonly look: (find: boolean) => Effect.Effect<void>
  }
>()("@dream/dreamd/AppLogs") {
  static readonly layer = Layer.effect(
    AppLogs,
    Effect.gen(function* () {
      const config = yield* DreamdConfig
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const log = yield* ProjectLog
      // `AppLogDir` in a sandbox.
      const appDir = path.join(config.home, "logs")
      yield* fs.makeDirectory(appDir, { recursive: true }).pipe(Effect.ignore)
      const file = JsonFile.make(AppLogState, path.join(config.stateDir, "app-logs.json"))
      const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        effect.pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path))
      const loaded = yield* provide(file.read).pipe(Effect.orElseSucceed(() => Option.none<AppLogState>()))
      const state = yield* Ref.make<AppLogState>(Option.getOrElse(loaded, () => ({ files: {}, found: [] })))

      const readText = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))

      /** Output files of processes listening on a TCP port, but dreamd's own. */
      const findServers = Effect.gen(function* () {
        const inodes = listeningInodes([yield* readText("/proc/net/tcp"), yield* readText("/proc/net/tcp6")])
        if (inodes.size === 0) return []
        const pids = (yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed(() => []))).filter(
          (name) => /^\d+$/.test(name) && Number(name) !== process.pid
        )
        const found = new Set<string>()
        for (const pid of pids) {
          const fds = yield* fs.readDirectory(`/proc/${pid}/fd`).pipe(Effect.orElseSucceed(() => []))
          let listens = false
          for (const fd of fds) {
            const target = yield* fs.readLink(`/proc/${pid}/fd/${fd}`).pipe(Effect.orElseSucceed(() => ""))
            const socket = /^socket:\[(\d+)\]$/.exec(target)
            if (socket?.[1] !== undefined && inodes.has(socket[1])) {
              listens = true
              break
            }
          }
          if (!listens) continue
          for (const fd of ["1", "2"]) {
            const target = yield* fs.readLink(`/proc/${pid}/fd/${fd}`).pipe(Effect.orElseSucceed(() => ""))
            if (followable(target, appDir) && !target.startsWith(path.join(config.home, ".dream"))) found.add(target)
          }
        }
        return [...found]
      })

      const conventional = fs.readDirectory(appDir).pipe(
        Effect.map((names) => names.filter((name) => !name.startsWith(".")).map((name) => path.join(appDir, name))),
        Effect.orElseSucceed(() => [])
      )

      /** What's new in `file` since `position`, and where that leaves it. */
      const readNew = (file: string, position: typeof Position.Type | undefined) =>
        Effect.gen(function* () {
          const info = yield* fs.stat(file).pipe(Effect.option)
          if (Option.isNone(info) || info.value.type !== "File") return undefined
          const size = Number(info.value.size)
          // Shorter than where it was read to: it was truncated or made again.
          const restarted = position !== undefined && size < position.offset
          let offset = position === undefined ? Math.max(0, size - FirstRead) : restarted ? 0 : position.offset
          if (offset >= size) return { position: { offset: size }, text: "" }
          const length = Math.min(size - offset, ReadMax)
          const skipped = size - offset - length
          if (skipped > 0) offset = size - length
          const chunks = yield* fs.stream(file, { offset, bytesToRead: length }).pipe(Stream.runCollect)
          const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
          let text = bytes.toString("utf8")
          // Keep a partial last line for the next look, unless it's all there is in a full read.
          const end = text.lastIndexOf("\n")
          let consumed = bytes.length
          if (end === -1 && bytes.length < ReadMax) {
            consumed = 0
            text = ""
          } else if (end !== -1 && end < text.length - 1) {
            consumed = Buffer.byteLength(text.slice(0, end + 1))
            text = text.slice(0, end + 1)
          }
          // Starting part-way into a file, the first line is likely cut: drop it.
          if (position === undefined && offset > 0) text = text.slice(text.indexOf("\n") + 1)
          return {
            position: { offset: offset + consumed },
            text: skipped > 0 ? `(${skipped} bytes skipped: more than Dream reads at once)\n${text}` : text
          }
        })

      const look = (find: boolean) =>
        Effect.gen(function* () {
          const before = yield* Ref.get(state)
          const found = find ? [...new Set([...before.found, ...(yield* findServers)])] : before.found
          const files = [...new Set([...(yield* conventional), ...found])]
          const now = yield* DateTime.now
          const positions: Record<string, typeof Position.Type> = {}
          const entries = []
          const present: Array<string> = []
          for (const file of files) {
            const read = yield* readNew(file, before.files[file]).pipe(Effect.orElseSucceed(() => undefined))
            if (read === undefined) continue
            present.push(file)
            positions[file] = read.position
            const name = logName(file)
            for (const line of groupLines(read.text)) {
              const level = lineLevel(line.text)
              const detailLevel = line.detail.length > 0 && lineLevel(line.detail) === "error" ? "error" : level
              entries.push(entryOf(now, "app", detailLevel, line.text, { name, detail: line.detail }))
            }
          }
          if (entries.length > 0) yield* log.append(entries)
          // Files that are gone are forgotten, so one made again under the same name is read from its start.
          const next: AppLogState = { files: positions, found: found.filter((file) => present.includes(file)) }
          if (JSON.stringify(next) !== JSON.stringify(before)) {
            yield* Ref.set(state, next)
            yield* provide(file.write(next)).pipe(Effect.ignore)
          }
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("Couldn't read the apps' output", cause)))

      let lastFindMs = 0
      return AppLogs.of({
        look,
        run: Stream.tick(ReadEvery).pipe(
          Stream.runForEach(() =>
            Effect.suspend(() => {
              const nowMs = Date.now()
              const find = nowMs - lastFindMs >= Duration.toMillis(FindEvery)
              if (find) lastFindMs = nowMs
              return look(find)
            })
          ),
          Effect.andThen(Effect.never)
        )
      })
    })
  )
}
