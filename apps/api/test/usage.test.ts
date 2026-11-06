/**
 * Project usage: share attribution (`usage/Shares.ts`) and the usage sheet built from it (`usage/ProjectUsage.ts`).
 */
import { assert, describe, it } from "@effect/vitest"
import type { ProjectId, UsageSnapshot } from "@dream/domain"
import { DateTime } from "effect"
import type { LoggedTurn } from "../src/db/TurnUsage.ts"
import { buildProjectUsage, startOfDayMs } from "../src/usage/ProjectUsage.ts"
import {
  attributeWindow,
  costWeights,
  currentWindow,
  groupOverlapping,
  type TurnRecord,
  type WindowReading
} from "../src/usage/Shares.ts"

const H = 60 * 60 * 1000
const M = 60 * 1000
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0)
/** The five-hour window in these tests resets at T0 + 3h; the week at T0 + 4 days. */
const FIVE_RESETS = T0 + 3 * H
const WEEK_RESETS = T0 + 96 * H

const A = "prj_a" as ProjectId
const B = "prj_b" as ProjectId
const C = "prj_c" as ProjectId

/** A five-hour reading; `resetsAtMs: null` for a provider that didn't say when it resets. */
const five = (usedPercent: number, observedAtMs: number, resetsAtMs: number | null = FIVE_RESETS): WindowReading => ({
  usedPercent,
  observedAtMs,
  resetsAtMs: resetsAtMs ?? undefined
})

let next = 0
const turn = (
  projectId: ProjectId,
  startedMs: number,
  endedMs: number,
  before: WindowReading | undefined,
  after: WindowReading | undefined,
  extra: Partial<TurnRecord> = {}
): TurnRecord => ({
  id: `trn_${next++}`,
  projectId,
  startedMs,
  endedMs,
  before: before === undefined ? {} : { fiveHour: before },
  after: after === undefined ? {} : { fiveHour: after },
  ...extra
})

const tokens = (output: number, input = 0) => ({ input, cacheRead: 0, cacheWrite: 0, output })

const attribute = (turns: ReadonlyArray<TurnRecord>, current: WindowReading, nowMs: number) =>
  attributeWindow({
    provider: "claude",
    window: "fiveHour",
    turns,
    current: currentWindow("fiveHour", current, nowMs)!
  })

const close = (actual: number | undefined, expected: number) => assert.closeTo(actual ?? Number.NaN, expected, 1e-9)

describe("share attribution", () => {
  it("credits a turn with the rise across it, and the rest of the window to outside Dream", () => {
    const t = turn(A, T0, T0 + 10 * M, five(20, T0), five(26, T0 + 10 * M))
    const result = attribute([t], five(30, T0 + 20 * M), T0 + 20 * M)
    close(result.byTurn.get(t.id), 6)
    close(result.byProject.get(A), 6)
    close(result.outsideDream, 24)
  })

  it("splits the rise of overlapping turns across projects once, by Claude Code's cost", () => {
    // A runs 0–30 min; B runs 10–20 inside it; C overlaps A's tail. All three see the window go 10 → 22.
    const a = turn(A, T0, T0 + 30 * M, five(10, T0), five(20, T0 + 30 * M), { costUsd: 2, tokens: tokens(1) })
    const b = turn(B, T0 + 10 * M, T0 + 20 * M, five(10, T0), five(15, T0 + 20 * M), { costUsd: 1, tokens: tokens(9) })
    const c = turn(C, T0 + 25 * M, T0 + 40 * M, five(18, T0 + 25 * M), five(22, T0 + 40 * M), { costUsd: 1 })
    assert.strictEqual(groupOverlapping([c, b, a]).length, 1)
    const result = attribute([a, b, c], five(22, T0 + 40 * M), T0 + 40 * M)
    close(result.byProject.get(A), 6)
    close(result.byProject.get(B), 3)
    close(result.byProject.get(C), 3)
    close(result.outsideDream, 10)
  })

  it("weights by tokens at relative list prices when a turn in the group has no cost", () => {
    // Codex reports no cost: 1M fresh input (1M units) vs 100k output (800k units) vs 2M cache reads (200k units).
    const group = [
      turn(A, T0, T0 + 10 * M, undefined, undefined, {
        tokens: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }
      }),
      turn(B, T0, T0 + 10 * M, undefined, undefined, { tokens: tokens(100_000) }),
      turn(C, T0, T0 + 10 * M, undefined, undefined, {
        costUsd: 3,
        tokens: { input: 0, cacheRead: 2_000_000, cacheWrite: 0, output: 0 }
      })
    ]
    const weights = costWeights("chatgpt", group)
    ;[1_000_000, 800_000, 200_000].forEach((expected, i) => close(weights[i], expected))
  })

  it("gives a turn from an older dreamd (no tokens) the group's mean weight, and equal shares if none report", () => {
    const withTokens = turn(A, T0, T0 + 10 * M, five(0, T0), five(9, T0 + 10 * M), { tokens: tokens(1000) })
    const old = turn(B, T0 + 5 * M, T0 + 8 * M, five(0, T0), five(4, T0 + 8 * M))
    const third = turn(C, T0 + 2 * M, T0 + 9 * M, five(0, T0), five(6, T0 + 9 * M), { tokens: tokens(2000) })
    const result = attribute([withTokens, old, third], five(9, T0 + 10 * M), T0 + 10 * M)
    // Weights 1000, 1500 (mean), 2000 of a rise of 9.
    close(result.byProject.get(A), 2)
    close(result.byProject.get(B), 3)
    close(result.byProject.get(C), 4)

    const x = turn(A, T0, T0 + 10 * M, five(0, T0), five(4, T0 + 10 * M))
    const y = turn(B, T0 + M, T0 + 9 * M, five(0, T0), five(3, T0 + 9 * M))
    const equal = attribute([x, y], five(4, T0 + 10 * M), T0 + 10 * M)
    close(equal.byProject.get(A), 2)
    close(equal.byProject.get(B), 2)
  })

  it("doesn't count a rise twice when a turn's before is older than the last turn's after", () => {
    const first = turn(A, T0, T0 + 10 * M, five(10, T0), five(14, T0 + 10 * M))
    // Started from the reading before `first` finished (reports arrived out of order): counts from 14, not 10.
    const second = turn(B, T0 + 20 * M, T0 + 30 * M, five(10, T0), five(17, T0 + 30 * M))
    const result = attribute([first, second], five(17, T0 + 30 * M), T0 + 30 * M)
    close(result.byProject.get(A), 4)
    close(result.byProject.get(B), 3)
    close(result.outsideDream, 10)
  })

  it("never credits a drop as a negative rise", () => {
    const t = turn(A, T0, T0 + 10 * M, five(30, T0), five(29, T0 + 10 * M))
    const result = attribute([t], five(29, T0 + 10 * M), T0 + 10 * M)
    close(result.byTurn.get(t.id), 0)
    close(result.outsideDream, 29)
  })

  it("never lets shares add up to more than the window", () => {
    const t = turn(A, T0, T0 + 10 * M, five(0, T0), five(40, T0 + 10 * M))
    // A later reading says less (rounding, or the provider recounted).
    const result = attribute([t], five(25, T0 + 20 * M), T0 + 20 * M)
    close(result.byProject.get(A), 25)
    close(result.outsideDream, 0)
  })

  it("leaves a turn with no reading after it uncredited", () => {
    const t = turn(A, T0, T0 + 10 * M, five(10, T0), undefined)
    const result = attribute([t], five(20, T0 + 20 * M), T0 + 20 * M)
    assert.strictEqual(result.byTurn.size, 0)
    close(result.outsideDream, 20)
  })

  describe("five-hour rollover", () => {
    const OLD_RESETS = FIVE_RESETS - 5 * H - 30 * M

    it("counts from 0 when the before was in an instance that has since reset", () => {
      // The previous instance reset during the turn; the new one started then and reads 7% at the end.
      const t = turn(A, OLD_RESETS - 10 * M, OLD_RESETS + 20 * M, five(80, OLD_RESETS - 10 * M, OLD_RESETS), {
        usedPercent: 7,
        observedAtMs: OLD_RESETS + 20 * M,
        resetsAtMs: OLD_RESETS + 5 * H
      })
      const result = attributeWindow({
        provider: "claude",
        window: "fiveHour",
        turns: [t],
        current: currentWindow("fiveHour", five(10, OLD_RESETS + H, OLD_RESETS + 5 * H), OLD_RESETS + H)!
      })
      close(result.byTurn.get(t.id), 7)
      close(result.outsideDream, 3)
    })

    it("only counts turns in the current instance", () => {
      const before = turn(A, OLD_RESETS - H, OLD_RESETS - 50 * M, five(40, OLD_RESETS - H, OLD_RESETS), {
        usedPercent: 60,
        observedAtMs: OLD_RESETS - 50 * M,
        resetsAtMs: OLD_RESETS
      })
      // No reading before it, but its instance began when it started (Claude's window starts at the first message).
      const now = turn(B, T0, T0 + 10 * M, undefined, five(5, T0 + 10 * M, T0 + 5 * H))
      const result = attributeWindow({
        provider: "claude",
        window: "fiveHour",
        turns: [before, now],
        current: currentWindow("fiveHour", five(5, T0 + 10 * M, T0 + 5 * H), T0 + 10 * M)!
      })
      assert.isFalse(result.byTurn.has(before.id))
      close(result.byProject.get(B), 5)
      close(result.outsideDream, 0)
    })

    it("reads a drop with no reset times as a reset", () => {
      const t = turn(A, T0, T0 + 10 * M, five(90, T0, null), five(4, T0 + 10 * M, null))
      const result = attribute([t], five(4, T0 + 10 * M, null), T0 + 10 * M)
      close(result.byTurn.get(t.id), 4)
    })
  })

  describe("weekly rollover", () => {
    const week = (usedPercent: number, observedAtMs: number, resetsAtMs: number) => ({
      usedPercent,
      observedAtMs,
      resetsAtMs
    })
    const weeklyTurn = (projectId: ProjectId, startedMs: number, endedMs: number, b: WindowReading, a: WindowReading) =>
      turn(projectId, startedMs, endedMs, undefined, undefined, { before: { weekly: b }, after: { weekly: a } })

    it("keeps last week's turns out of this week, and counts this week's first turn from 0", () => {
      const lastWeekReset = WEEK_RESETS - 7 * 24 * H
      const old = weeklyTurn(
        A,
        lastWeekReset - 2 * H,
        lastWeekReset - H,
        week(70, lastWeekReset - 2 * H, lastWeekReset),
        week(75, lastWeekReset - H, lastWeekReset)
      )
      const fresh = weeklyTurn(
        A,
        lastWeekReset + H,
        lastWeekReset + 2 * H,
        week(75, lastWeekReset - H, lastWeekReset),
        week(3, lastWeekReset + 2 * H, WEEK_RESETS)
      )
      const later = weeklyTurn(B, T0, T0 + H, week(3, lastWeekReset + 2 * H, WEEK_RESETS), week(5, T0 + H, WEEK_RESETS))
      const result = attributeWindow({
        provider: "claude",
        window: "weekly",
        turns: [old, fresh, later],
        current: currentWindow("weekly", week(8, T0 + 2 * H, WEEK_RESETS), T0 + 2 * H)!
      })
      assert.isFalse(result.byTurn.has(old.id))
      close(result.byProject.get(A), 3)
      close(result.byProject.get(B), 2)
      close(result.outsideDream, 3)
    })

    it("knows nothing of a week whose reset has passed since the last reading", () => {
      const t = weeklyTurn(A, T0, T0 + H, week(10, T0, WEEK_RESETS), week(12, T0 + H, WEEK_RESETS))
      const current = currentWindow("weekly", week(12, T0 + H, WEEK_RESETS), WEEK_RESETS + H)!
      assert.isTrue(current.rolledOver)
      const result = attributeWindow({ provider: "claude", window: "weekly", turns: [t], current })
      assert.strictEqual(result.byTurn.size, 0)
      close(result.outsideDream, 0)
    })
  })
})

describe("the usage sheet", () => {
  const nowMs = T0 + 2 * H
  const snapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
    provider: "claude",
    plan: "Claude Max",
    fiveHour: { usedPercent: 41, resetsAt: DateTime.makeUnsafe(FIVE_RESETS) },
    weekly: { usedPercent: 38, resetsAt: DateTime.makeUnsafe(WEEK_RESETS) },
    observedAt: DateTime.makeUnsafe(nowMs),
    ...overrides
  })
  const both = (
    fivePercent: number,
    weekPercent: number,
    observedAtMs: number,
    fiveResetsAtMs: number
  ): Partial<Record<"fiveHour" | "weekly", WindowReading>> => ({
    fiveHour: { usedPercent: fivePercent, resetsAtMs: fiveResetsAtMs, observedAtMs },
    weekly: { usedPercent: weekPercent, resetsAtMs: WEEK_RESETS, observedAtMs }
  })
  const logged = (
    id: string,
    projectId: ProjectId,
    startedMs: number,
    endedMs: number,
    before: [number, number],
    after: [number, number],
    extra: Partial<LoggedTurn> = {}
  ): LoggedTurn => ({
    id,
    projectId,
    startedMs,
    endedMs,
    // A five-hour instance that reset at 09:00 UTC, before the current one (10:00–15:00).
    before: both(before[0], before[1], startedMs, startedMs < FIVE_RESETS - 5 * H ? FIVE_RESETS - 6 * H : FIVE_RESETS),
    after: both(after[0], after[1], endedMs, endedMs < FIVE_RESETS - 5 * H ? FIVE_RESETS - 6 * H : FIVE_RESETS),
    ...extra
  })
  const projects = new Map([
    [A, { title: "Anki Voice", icon: "rectangle.on.rectangle" }],
    [B, { title: "Lift Log", icon: "dumbbell" }]
  ])
  const timeZone = "America/Los_Angeles"
  // Now, 2026-11-06 14:00 UTC, is 06:00 in Los Angeles: yesterday there ended at 08:00 UTC.
  const yesterday = Date.UTC(2026, 10, 6, 6, 0, 0)
  const turns = [
    logged("t1", A, yesterday, yesterday + 30 * M, [30, 34], [32, 35], {
      tokens: { input: 100, cacheRead: 7_000, cacheWrite: 900, output: 1_000 },
      costUsd: 1,
      subagents: "included"
    }),
    logged("t2", B, T0, T0 + 30 * M, [32, 35], [38, 37], { costUsd: 2, tokens: tokens(5_000) }),
    logged("t3", A, T0 + 10 * M, T0 + 20 * M, [32, 35], [36, 36], { costUsd: 2, tokens: tokens(2_000, 500) })
  ]

  it("measures today from midnight in their time zone", () => {
    assert.strictEqual(startOfDayMs(nowMs, timeZone), Date.UTC(2026, 10, 6, 8, 0, 0))
    assert.strictEqual(startOfDayMs(nowMs, "Not/AZone"), Date.UTC(2026, 10, 6, 0, 0, 0))
  })

  it("adds this project's tokens per period and its share of each window, beside every project's", () => {
    const usage = buildProjectUsage({
      project: { id: A, harness: "claude-code" },
      snapshot: snapshot(),
      turns,
      nowMs,
      timeZone,
      projects
    })
    assert.strictEqual(usage.provider, "claude")
    assert.strictEqual(usage.billing, "subscription")
    assert.strictEqual(usage.plan, "Claude Max")
    // Week: t1 (9,000 tokens) + t3 (2,500). Today (since 08:00 UTC) and the five hours: t3 only.
    assert.strictEqual(usage.week.tokens, 11_500)
    assert.strictEqual(usage.today.tokens, 2_500)
    assert.strictEqual(usage.fiveHour.tokens, 2_500)
    // The week rose 34 → 35 over t1, then 35 → 37 over t2 and t3 (cost 2 and 2): A gets 1 + 1.
    assert.strictEqual(usage.week.sharePercent, 2)
    assert.strictEqual(usage.today.sharePercent, 1)
    assert.deepStrictEqual(usage.weekly, {
      usedPercent: 38,
      projectPercent: 2,
      resetsAt: DateTime.makeUnsafe(WEEK_RESETS)
    })
    // The five hours: t1 was in the previous instance; t2 and t3 saw 32 → 38.
    assert.strictEqual(usage.fiveHour.sharePercent, 3)
    assert.strictEqual(usage.fiveHourWindow?.usedPercent, 41)
    assert.deepStrictEqual(
      usage.projects.map((p) => [p.title, p.sharePercent]),
      [
        ["Anki Voice", 2],
        ["Lift Log", 1]
      ]
    )
    assert.strictEqual(usage.outsideDreamPercent, 35)
    assert.isUndefined(usage.subagents, "t3 couldn't say")
  })

  it("says subagents are included only when every turn of the week says so", () => {
    const usage = buildProjectUsage({
      project: { id: A, harness: "claude-code" },
      snapshot: snapshot(),
      turns: turns.filter((t) => t.id !== "t3"),
      nowMs,
      timeZone,
      projects
    })
    assert.strictEqual(usage.subagents, "included")
  })

  it("leaves the header empty when the week isn't known, or this project hasn't worked in it", () => {
    const { weekly: _, ...withoutWeek } = snapshot()
    const noWeek = buildProjectUsage({
      project: { id: A, harness: "claude-code" },
      snapshot: withoutWeek,
      turns,
      nowMs,
      timeZone,
      projects
    })
    assert.isUndefined(noWeek.weekly)
    assert.isUndefined(noWeek.week.sharePercent)
    assert.isUndefined(noWeek.outsideDreamPercent)
    assert.deepStrictEqual(noWeek.projects, [])
    // The last seven days stand in for the week's tokens.
    assert.strictEqual(noWeek.week.tokens, 11_500)

    const idle = buildProjectUsage({
      project: { id: C, harness: "claude-code" },
      snapshot: snapshot(),
      turns,
      nowMs,
      timeZone,
      projects
    })
    assert.isUndefined(idle.weekly)
    assert.isUndefined(idle.week.tokens)
    assert.strictEqual(idle.week.sharePercent, 0)
    assert.deepStrictEqual(
      idle.projects.map((p) => [p.title, p.sharePercent]),
      [
        ["Anki Voice", 2],
        ["Lift Log", 1],
        ["Deleted project", 0]
      ]
    )
  })

  it("has no shares or windows without a usage report, and no tokens from turns that reported none", () => {
    const usage = buildProjectUsage({
      project: { id: B, harness: "codex" },
      snapshot: undefined,
      turns: [logged("old", B, T0, T0 + 10 * M, [0, 0], [1, 1])],
      nowMs,
      timeZone,
      projects
    })
    assert.strictEqual(usage.provider, "chatgpt")
    assert.isUndefined(usage.weekly)
    assert.isUndefined(usage.fiveHourWindow)
    assert.deepStrictEqual(usage.today, {})
    assert.deepStrictEqual(usage.week, {})
  })
})
