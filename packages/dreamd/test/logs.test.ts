/** The sandbox's half of the project's log: the files, and what goes into them. */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import type { LogEntry, MachineSample, WakeId } from "@dream/domain"
import { NodeServices } from "@effect/platform-node"
import { Context, DateTime, Duration, Effect, Layer, Ref, Stream } from "effect"
import { Api, type Report } from "../src/Api.ts"
import { AppLogs, groupLines, lineLevel, listeningInodes, logName } from "../src/AppLogs.ts"
import { Commands, decideRun, FailureCoolDown } from "../src/Commands.ts"
import { Hold } from "../src/Hold.ts"
import { Inbox } from "../src/Inbox.ts"
import { span, startLine } from "../src/Lifecycle.ts"
import { LogFileBytes, logFile, ProjectLog, readLogFiles as readFiles } from "../src/Log.ts"
import {
  describeSample,
  initialMachineState,
  judgeSample,
  Machine,
  MachineRules,
  parseMeminfo,
  parseVmstat
} from "../src/Machine.ts"
import { Tasks } from "../src/Tasks.ts"
import { baseLayer, tempDir, wakeWithCommand } from "./support.ts"

const at = DateTime.makeUnsafe("2026-11-08T14:00:00Z")
const logDir = (dir: string) => join(dir, ".dream", "logs")
const readLogFiles = (...args: Parameters<typeof readFiles>) =>
  readFiles(...args).pipe(Effect.provide(NodeServices.layer))

describe("the log files", () => {
  it.effect("keep each source in its own file, move a full one aside, and read both back", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const log = Context.get(yield* Layer.build(ProjectLog.layer.pipe(Layer.provideMerge(baseLayer(dir)))), ProjectLog)
      const line = "x".repeat(400)
      const many: Array<LogEntry> = Array.from({ length: Math.ceil(LogFileBytes / 450) + 10 }, (_, i) => ({
        at: DateTime.makeUnsafe(Date.UTC(2026, 10, 8, 10) + i),
        source: "app",
        level: "info",
        text: `${i} ${line}`,
        name: "web"
      }))
      yield* log.append(many)
      yield* log.append([{ at, source: "app", level: "error", text: "TypeError: boom", name: "web" }])
      yield* log.note("dream", "info", "dreamd started")
      assert.isTrue(existsSync(logFile(logDir(dir), "app", true)), "the full file moved aside")
      const errors = yield* readLogFiles(logDir(dir), { errors: true })
      assert.deepStrictEqual(
        errors.map((entry) => entry.text),
        ["TypeError: boom"]
      )
      const all = yield* readLogFiles(logDir(dir), { sources: ["app"] })
      assert.strictEqual(all.length, many.length + 1)
      assert.strictEqual((yield* readLogFiles(logDir(dir), { sources: ["dream"] }))[0]?.text, "dreamd started")
      // A line cut short by a crash is skipped.
      appendFileSync(logFile(logDir(dir), "dream"), '{"at":"2026-11-08T1')
      assert.strictEqual((yield* readLogFiles(logDir(dir), { sources: ["dream"] })).length, 1)
    }).pipe(Effect.scoped)
  )
})

describe("a scheduled command that keeps failing", () => {
  const failed = { exitCode: 3, outputTail: "boom" }
  const wake = "wak_1" as WakeId

  it("wakes the agent once, then again after the cool-down or a different failure, saying how often it failed", () => {
    const first = decideRun({}, wake, failed, at)
    assert.deepStrictEqual(first.wake, failed)
    const again = decideRun(first.failures, wake, failed, DateTime.add(at, { minutes: 15 }))
    assert.isUndefined(again.wake)
    const third = decideRun(again.failures, wake, failed, DateTime.add(at, { minutes: 30 }))
    assert.isUndefined(third.wake)
    const different = decideRun(
      third.failures,
      wake,
      { exitCode: 7, outputTail: "other" },
      DateTime.add(at, { minutes: 45 })
    )
    assert.deepStrictEqual(different.wake?.failedBefore, { count: 2, since: DateTime.add(at, { minutes: 15 }) })
    const later = decideRun(
      decideRun(first.failures, wake, failed, DateTime.add(at, { minutes: 15 })).failures,
      wake,
      failed,
      DateTime.addDuration(at, Duration.sum(FailureCoolDown, Duration.minutes(1)))
    )
    assert.strictEqual(later.wake?.failedBefore?.count, 1)
  })

  it("starts over once it succeeds", () => {
    const first = decideRun({}, wake, failed, at)
    const fixed = decideRun(first.failures, wake, { exitCode: 0, outputTail: "ok" }, DateTime.add(at, { minutes: 5 }))
    assert.deepStrictEqual(fixed.failures, {})
    assert.deepStrictEqual(decideRun(fixed.failures, wake, failed, DateTime.add(at, { minutes: 10 })).wake, failed)
  })

  it.live("is logged each run with its output, and wakes the agent only the first time", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const reports = yield* Ref.make<ReadonlyArray<Report>>([])
      const context = yield* Layer.build(
        Commands.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              Tasks.layerTest({ script: () => Effect.die("no tasks"), log: yield* Ref.make([]) }),
              Api.layerTest(reports)
            )
          ),
          Layer.provideMerge(Layer.mergeAll(Inbox.layer, Hold.layer, Machine.layerNone)),
          Layer.provideMerge(ProjectLog.layer),
          Layer.provideMerge(baseLayer(dir))
        )
      )
      const inbox = Context.get(context, Inbox)
      yield* Effect.forkScoped(Context.get(context, Commands).run)
      const settled = inbox.changes.pipe(
        Stream.filter((state) => state.entries.every((entry) => entry.state !== "command")),
        Stream.runHead,
        Effect.timeout("10 seconds")
      )
      const failing = "echo 'feed answered 500' >&2; exit 22"
      yield* inbox.deliver([wakeWithCommand(1, failing)])
      yield* settled
      yield* inbox.release(
        (yield* inbox.take).map((event) => event.id),
        "done"
      )
      // The same wake again (a cron firing): logged, but nothing for the agent.
      yield* inbox.deliver([{ ...wakeWithCommand(2, failing), wakeId: "wak_1" as WakeId }])
      yield* settled
      assert.lengthOf(yield* inbox.take, 0)
      const runs = yield* readLogFiles(logDir(dir), { sources: ["run"] })
      assert.deepStrictEqual(
        runs.map((entry) => [entry.level, entry.name, entry.detail]),
        [
          ["error", "wak_1", "feed answered 500"],
          ["error", "wak_1", "feed answered 500"]
        ]
      )
      assert.match(runs[0]!.text, /^`echo .*` failed with exit code 22 after \d+ ms$/)
      assert.include(runs[1]!.text, "not waking you again for it before 2h have passed")
    }).pipe(Effect.scoped)
  )
})

const sample = (overrides: Partial<MachineSample> = {}): MachineSample => ({
  memoryTotalMb: 3900,
  memoryAvailableMb: 2000,
  swapTotalMb: 2048,
  swapUsedMb: 0,
  diskTotalMb: 20_000,
  diskFreeMb: 9000,
  load1: 0.3,
  cpus: 2,
  oomKills: 0,
  swapInPages: 0,
  swapOutPages: 0,
  ...overrides
})

describe("the machine", () => {
  it("reads /proc", () => {
    assert.deepStrictEqual(
      parseMeminfo(
        "MemTotal:  3993600 kB\nMemFree: 100 kB\nMemAvailable:  2048000 kB\nSwapTotal: 2097148 kB\nSwapFree: 1048576 kB\n"
      ),
      { memoryTotalMb: 3900, memoryAvailableMb: 2000, swapTotalMb: 2048, swapUsedMb: 1024 }
    )
    assert.deepStrictEqual(parseVmstat("pswpin 120\npswpout 340\noom_kill 2\n"), {
      oomKills: 2,
      swapInPages: 120,
      swapOutPages: 340
    })
    assert.strictEqual(
      describeSample(sample()),
      "memory 2.0 GB of 3.8 GB available, swap 0 MB of 2.0 GB used, disk 8.8 GB of 19.5 GB free, load 0.30 on 2 CPUs"
    )
  })

  it("tells the agent once memory stays short, then not again before the cool-down", () => {
    const short = sample({ memoryAvailableMb: 200, swapUsedMb: 1900 })
    const once = judgeSample(initialMachineState, short, 0)
    assert.lengthOf(once.troubles, 0, "one reading isn't enough")
    const twice = judgeSample(once.state, short, 60_000)
    assert.deepStrictEqual(
      twice.troubles.map((t) => t.kind),
      ["memory"]
    )
    assert.include(twice.troubles[0]!.reason, "200 MB of 3.8 GB available")
    assert.lengthOf(judgeSample(twice.state, short, 120_000).troubles, 0)
    const later = Duration.toMillis(MachineRules.coolDown.memory) + 120_000
    assert.lengthOf(judgeSample(twice.state, short, later).troubles, 1)
  })

  it("counts thrashing as short, even with swap to spare", () => {
    const first = judgeSample(initialMachineState, sample({ memoryAvailableMb: 200, swapInPages: 0 }), 0)
    const second = judgeSample(first.state, sample({ memoryAvailableMb: 200, swapInPages: 5000 }), 60_000)
    const third = judgeSample(second.state, sample({ memoryAvailableMb: 200, swapInPages: 10_000 }), 120_000)
    assert.lengthOf(second.troubles, 0)
    assert.include(third.troubles[0]?.reason, "5000 pages swapped in over the last minute")
  })

  it("tells the agent when the kernel kills something, but not about a new sandbox's count", () => {
    const before = judgeSample(initialMachineState, sample({ oomKills: 1 }), 0)
    assert.lengthOf(before.troubles, 0, "kills before dreamd looked")
    const killed = judgeSample(before.state, sample({ oomKills: 2 }), 60_000)
    assert.deepStrictEqual(
      killed.troubles.map((t) => t.kind),
      ["out-of-memory"]
    )
    assert.lengthOf(judgeSample(killed.state, sample({ oomKills: 0 }), 120_000).troubles, 0)
  })

  it("tells the agent when the disk is nearly full", () => {
    const full = judgeSample(initialMachineState, sample({ diskFreeMb: 600 }), 0)
    assert.deepStrictEqual(
      full.troubles.map((t) => t.kind),
      ["disk"]
    )
  })
})

describe("the servers' output", () => {
  it("reads lines as errors, warnings or neither", () => {
    assert.strictEqual(lineLevel("TypeError: Cannot read properties of undefined"), "error")
    assert.strictEqual(lineLevel("Error: listen EADDRINUSE: address already in use :::3000"), "error")
    assert.strictEqual(lineLevel("GET /api/items 500 12.3 ms - 21"), "error")
    assert.strictEqual(lineLevel("Compiled with 0 errors"), "info")
    assert.strictEqual(lineLevel("(node:12) DeprecationWarning: Buffer() is deprecated"), "warn")
    assert.strictEqual(lineLevel("GET /api/items 200 3 ms"), "info")
  })

  it("keeps a stack trace with the line it belongs to", () => {
    assert.deepStrictEqual(
      groupLines(
        "listening on 3000\n\u001b[31mTypeError: boom\u001b[0m\n    at handler (/home/user/project/server.js:12:5)\n    at next\n\nGET / 200\n"
      ),
      [
        { text: "listening on 3000", detail: "" },
        { text: "TypeError: boom", detail: "    at handler (/home/user/project/server.js:12:5)\n    at next" },
        { text: "GET / 200", detail: "" }
      ]
    )
  })

  it("names files and finds listening sockets", () => {
    assert.strictEqual(logName("/home/user/logs/web.log"), "web")
    assert.strictEqual(logName("/home/user/project/server.out"), "server")
    const table =
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
      "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41234 1 0\n" +
      "   1: 0100007F:0BB8 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 41299 1 0\n"
    assert.deepStrictEqual([...listeningInodes([table])], ["41234"])
  })

  it.effect("follow ~/logs as it grows, from where they left off", () =>
    Effect.gen(function* () {
      const dir = tempDir()
      const context = yield* Layer.build(
        AppLogs.layer.pipe(Layer.provideMerge(ProjectLog.layer), Layer.provideMerge(baseLayer(dir)))
      )
      const appLogs = Context.get(context, AppLogs)
      const file = join(dir, "logs", "web.log")
      mkdirSync(join(dir, "logs"), { recursive: true })
      writeFileSync(file, "listening on 3000\n")
      yield* appLogs.look(false)
      appendFileSync(file, "GET / 200\nError: database is locked\n    at run (db.js:4:1)\nhalf a li")
      yield* appLogs.look(false)
      appendFileSync(file, "ne\n")
      yield* appLogs.look(false)
      const read = yield* readLogFiles(logDir(dir), { sources: ["app"] })
      assert.deepStrictEqual(
        read.map((entry) => [entry.name, entry.level, entry.text, entry.detail ?? ""]),
        [
          ["web", "info", "listening on 3000", ""],
          ["web", "info", "GET / 200", ""],
          ["web", "error", "Error: database is locked", "    at run (db.js:4:1)"],
          ["web", "info", "half a line", ""]
        ]
      )
      // Truncated (`>` instead of `>>`, or a restart that empties it): read again from its start.
      writeFileSync(file, "started again\n")
      yield* appLogs.look(false)
      assert.strictEqual((yield* readLogFiles(logDir(dir), { sources: ["app"] })).at(-1)?.text, "started again")
    }).pipe(Effect.scoped)
  )
})

describe("dreamd's own life", () => {
  it("says what came before a start", () => {
    assert.strictEqual(startLine("abc", undefined), "dreamd 0.1.0 started, from release abc")
    assert.strictEqual(
      startLine("def", { release: "abc", running: false, seenAt: at }),
      "dreamd 0.1.0 started, from release def; Dream refreshed it from release abc"
    )
    assert.strictEqual(
      startLine("abc", { release: "abc", running: true, seenAt: at }),
      "dreamd 0.1.0 started, from release abc; the last dreamd stopped without shutting down (it was last seen at 2026-11-08T14:00:00.000Z)"
    )
    assert.strictEqual(span(45_000), "45 s")
    assert.strictEqual(span(3 * 3_600_000 + 5 * 60_000), "3 h 5 min")
  })
})
