/**
 * The resource review's judgment (`scripts/review/analyze.ts`) on fixed inputs: where a project's machine time went,
 * what it flags and how it ranks it, and when it asks for action.
 */
import { assert, describe, it } from "@effect/vitest"
import {
  explainRun,
  exitCode,
  type Inputs,
  type LedgerRow,
  type LoadPoint,
  review,
  sandboxHourly
} from "../scripts/review/analyze.ts"

const Day = "2026-11-07"
const at = (time: string, day = Day) => Date.parse(`${day}T${time}Z`)
const Min = 60_000
const Hour = 3_600_000
const PROJECT = "prj_podcast"

let seq = 0
const run = (
  end: number,
  ms: number,
  options: { project?: string; cause?: string; vcpus?: number; memoryMb?: number; sandbox?: string } = {}
): LedgerRow => {
  const vcpus = options.vcpus ?? 2
  const memoryMb = options.memoryMb ?? 4096
  return {
    id: `e2b:${seq++}`,
    meter: "sandbox_run",
    at: end,
    project: options.project ?? (options.cause === "dev" ? undefined : PROJECT),
    center: "sandbox",
    cost: (sandboxHourly(vcpus, memoryMb) * ms) / Hour,
    quantities: { ms, vcpus, memory_mb: memoryMb },
    dimensions: {
      cause: options.cause ?? "project",
      sandbox: options.sandbox ?? "sbx_1",
      ended: "paused"
    }
  }
}

const base = (overrides: Partial<Inputs> = {}): Inputs => ({
  now: at("12:00:00", "2026-11-08"),
  day: Day,
  ledger: [],
  turns: [],
  projects: [{ id: PROJECT, title: "The Morning Build", archived: false, sandboxId: "sbx_1" }],
  mac: [],
  wakes: [],
  live: [],
  load: [],
  missing: [],
  ...overrides
})

describe("machine time by cause", () => {
  it("tells turns, their tail, and each kind of wake apart, and flags a project that's mostly awake for nothing", () => {
    const ledger: Array<LedgerRow> = [
      // A 30-minute run with a 25-minute turn in it: 5 minutes of tail.
      run(at("08:30:00"), 30 * Min),
      // 30 polls of the app, two minutes each, and a scheduled command at 06:00.
      ...Array.from({ length: 30 }, (_, i) => run(at("10:00:00") + i * 10 * Min, 2 * Min)),
      run(at("06:00:30"), 30_000),
      // A refresh donor.
      run(at("09:00:40"), 40_000, { cause: "refresh", sandbox: "sbx_donor" }),
      // And a week of quiet days before, a few cents each.
      ...Array.from({ length: 7 }, (_, i) => run(at("12:00:00") - (i + 1) * 86_400_000, 3 * Min))
    ]
    const wakes = [
      ...Array.from({ length: 30 }, (_, i) => ({
        project: PROJECT,
        at: at("09:58:05") + i * 10 * Min,
        reason: "visit"
      })),
      { project: PROJECT, at: at("06:00:01"), reason: "wake-run" }
    ]
    const result = review(
      base({
        ledger,
        wakes,
        turns: [{ project: PROJECT, start: at("08:02:00"), end: at("08:27:00"), task: false, outputTokens: 9000 }]
      })
    )
    const project = result.projects.find((p) => p.project === PROJECT)!
    const rate = sandboxHourly(2, 4096) / 60
    assert.closeTo(project.machine.turns ?? 0, 25 * rate, 1e-9)
    assert.closeTo(project.machine["idle after turns"] ?? 0, 5 * rate, 1e-9)
    assert.closeTo(project.machine["wake: visit"] ?? 0, 60 * rate, 1e-9)
    assert.closeTo(project.machine["wake: scheduled command"] ?? 0, 0.5 * rate, 1e-9)
    assert.closeTo(project.machine["refresh donors"] ?? 0, (40 / 60) * rate, 1e-9)
    assert.strictEqual(project.wakesWithoutTurn, 31)
    assert.strictEqual(project.refreshes, 1)
    const polling = result.findings.find((f) => f.title.includes("woke 31 times"))!
    assert.include(polling.detail, "wake: visit")
    // Polling for well under a dollar a day is worth watching, not acting on.
    assert.strictEqual(polling.severity, "watch")
    assert.strictEqual(exitCode(result), 0)
  })

  it("explains a run by the first note from just before it started to its end", () => {
    const notes = [
      { project: PROJECT, at: at("10:00:00"), reason: "visit" },
      { project: PROJECT, at: at("10:00:30"), reason: "delivery" }
    ]
    assert.strictEqual(explainRun(notes, at("10:00:10"), at("10:02:00")), "wake: visit")
    assert.strictEqual(explainRun(notes, at("10:00:25"), at("10:02:00")), "wake: delivery")
    assert.strictEqual(explainRun(notes, at("11:00:00"), at("11:02:00")), "wake: unexplained")
  })
})

describe("what it flags", () => {
  const load = (sandbox: string, vcpus: number, memoryMb: number, points: Array<[number, number]>): Array<LoadPoint> =>
    points.map(([cpuPct, memMb], i) => ({
      sandbox,
      project: PROJECT,
      at: at("00:00:00") + i * 5 * Min,
      vcpus,
      memoryMb,
      cpuPct,
      memMb,
      diskMb: 9000,
      diskTotalMb: 10000
    }))

  it("a large sandbox that rarely needs it, a standard one at its ceiling, a full disk", () => {
    const large = {
      id: "sbx_1",
      state: "paused",
      startedAt: at("08:00:00"),
      vcpus: 4,
      memoryMb: 8192,
      metadata: { projectId: PROJECT }
    }
    const result = review(
      base({
        live: [large],
        // Three hours up a day for the week.
        ledger: Array.from({ length: 7 }, (_, i) =>
          run(at("20:00:00") - i * 86_400_000, 3 * Hour, { vcpus: 4, memoryMb: 8192 })
        ),
        // One burst in 20 samples.
        load: load("sbx_1", 4, 8192, [[97, 1800], ...Array.from({ length: 19 }, (): [number, number] => [5, 600])])
      })
    )
    const sizing = result.findings.find((f) => f.area === "sizing" && f.title.includes("rarely needs it"))!
    const saving = (sandboxHourly(4, 8192) - sandboxHourly(2, 4096)) * 3 * (19 / 20)
    assert.closeTo(sizing.usdPerDay, saving, 1e-9)
    assert.strictEqual(sizing.severity, "action")
    assert.isTrue(result.findings.some((f) => f.title.includes("disk is 90% full") && f.severity === "action"))

    const standard = review(
      base({
        live: [{ ...large, vcpus: 2, memoryMb: 4096 }],
        load: load(
          "sbx_1",
          2,
          4096,
          Array.from({ length: 20 }, (): [number, number] => [95, 3900])
        )
      })
    )
    const titles = standard.findings.map((f) => f.title)
    assert.isTrue(titles.some((t) => t.includes("reached 3.8 of 4 GB")))
    assert.isTrue(titles.some((t) => t.includes("flat out 100%")))
    assert.isFalse(titles.some((t) => t.includes("rarely needs it")))
  })

  it("Macs: a deadline hit, an idle tail, a hold by a quiet leftover, and a Mac outside every project", () => {
    const mac = (instance: string, minutes: number, idleMinutes: number, stop: string): LedgerRow => ({
      id: `namespace:${instance}`,
      meter: "mac_session",
      at: at("15:00:00"),
      project: PROJECT,
      center: "mac",
      cost: minutes * 0.06,
      quantities: { ms: minutes * Min, vcpus: 4, idle_ms: idleMinutes * Min },
      dimensions: { instance, stop_reason: stop }
    })
    const probe = (instance: string, minute: number, probe: object) => ({
      instance,
      project: PROJECT,
      at: at("14:00:00") + minute * Min,
      kind: "probe",
      detail: { _tag: "Probe", probe, ms: 500 }
    })
    const result = review(
      base({
        ledger: [mac("m1", 240, 2, "deadline"), mac("m2", 50, 35, "idle")],
        mac: Array.from({ length: 10 }, (_, i) => probe("m2", i * 5, { busy: false, lingering: true })),
        macs: [
          {
            id: "m9",
            created: at("09:00:00", "2026-11-08"),
            deadline: at("13:00:00", "2026-11-08"),
            vcpus: 6,
            labels: { dream: "sim-check" }
          }
        ]
      })
    )
    const byTitle = (part: string) => result.findings.find((f) => f.title.includes(part))!
    assert.strictEqual(byTitle("ran to its deadline").severity, "action")
    assert.closeTo(byTitle("ran to its deadline").usdPerDay, 240 * 0.06, 1e-9)
    assert.closeTo(byTitle("sat idle 35 min").usdPerDay, (35 / 60) * 3.6, 1e-9)
    assert.strictEqual(byTitle("held about 50 min").severity, "action")
    // Up three hours, one to go, at $5.40 an hour.
    assert.closeTo(byTitle("outside Dream's projects").usdPerDay, 4 * 5.4, 1e-9)
    // Ranked by dollars: the Mac outside the projects, the day's Mac spend, the deadline hit, the idle tail.
    assert.deepStrictEqual(
      result.findings.slice(0, 4).map((f) => f.area),
      ["macs", "spend", "macs", "macs"]
    )
    assert.include(result.findings[0]!.title, "outside Dream's projects")
    assert.include(result.findings[2]!.title, "deadline")
    assert.strictEqual(exitCode(result), 2)
  })

  it("throwaway sandboxes left up, sandboxes of deleted projects, and a ledger that stopped", () => {
    const now = at("12:00:00", "2026-11-08")
    const result = review(
      base({
        live: [
          {
            id: "dev1",
            state: "running",
            startedAt: now - 2 * Hour,
            vcpus: 2,
            memoryMb: 4096,
            metadata: { purpose: "dev", script: "smoke" }
          },
          {
            id: "dev2",
            state: "running",
            startedAt: now - 2 * Hour,
            vcpus: 2,
            memoryMb: 4096,
            metadata: { purpose: "dev", reaper: "skip" }
          },
          {
            id: "gone",
            state: "running",
            startedAt: now - Hour,
            vcpus: 2,
            memoryMb: 4096,
            metadata: { projectId: "prj_gone" }
          }
        ],
        ledger: [run(now - 6 * Hour, 2 * Min)],
        e2bLog: [{ sandbox: "x", end: now - Hour, ms: 60_000, vcpus: 2, memoryMb: 4096, metadata: {} }]
      })
    )
    const titles = result.findings.map((f) => f.title)
    assert.isTrue(titles.some((t) => t.includes("dev1 (smoke) has been up 2.0 h")))
    assert.isFalse(titles.some((t) => t.includes("dev2")))
    assert.isTrue(titles.some((t) => t.includes("its project prj_gone is gone")))
    assert.isTrue(titles.some((t) => t.startsWith("The ledger's last sandbox run is 6.0 h old")))
  })

  it("a long turn that left its sandbox idle", () => {
    const result = review(
      base({
        live: [
          { id: "sbx_1", state: "paused", startedAt: 0, vcpus: 2, memoryMb: 4096, metadata: { projectId: PROJECT } }
        ],
        turns: [{ project: PROJECT, start: at("05:00:00"), end: at("08:00:00"), task: false, outputTokens: 90_000 }],
        load: load(
          "sbx_1",
          2,
          4096,
          Array.from({ length: 36 }, (_, i): [number, number] => [i < 12 ? 40 : 2, 900])
        ).map((p) => ({ ...p, at: p.at + 5 * Hour }))
      })
    )
    const idle = result.findings.find((f) => f.area === "turns")!
    assert.include(idle.title, "a 180-min turn left its sandbox idle for about 120 min")
    assert.closeTo(idle.usdPerDay, 2 * sandboxHourly(2, 4096), 1e-9)
  })
})
