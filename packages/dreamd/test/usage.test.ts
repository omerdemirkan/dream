import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import type { ProjectCosts, ProjectId } from "@dream/domain"
import { DateTime, Option } from "effect"
import * as Format from "../src/cli/Format.ts"
import { fromClaudeRaw, fromCodexRollout, isCodexUsageLimitMessage, merge, toSnapshot } from "../src/Usage.ts"

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
const iso = (time: DateTime.Utc | undefined) => (time === undefined ? undefined : DateTime.formatIso(time))
const now = DateTime.makeUnsafe("2026-11-04T23:58:00Z")

describe("Claude Code rate-limit events", () => {
  it("reads the windows from a real event", () => {
    const reading = Option.getOrThrow(fromClaudeRaw(JSON.parse(fixture("claude-rate-limit-event.json")), now))
    assert.strictEqual(reading.weekly?.usedPercent, 4)
    assert.strictEqual(iso(reading.weekly?.resetsAt), "2026-11-11T14:00:00.000Z")
    assert.isUndefined(reading.fiveHour)
    assert.isUndefined(reading.limit)
  })

  it("turns a rejection into a limit that holds until the reset", () => {
    const raw = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1793851200,
        rateLimitType: "five_hour",
        utilization: 1,
        unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 1794405600 } }
      }
    }
    const reading = Option.getOrThrow(fromClaudeRaw(raw, now))
    assert.strictEqual(reading.fiveHour?.usedPercent, 100)
    assert.strictEqual(reading.weekly?.usedPercent, 50)
    assert.strictEqual(reading.limit?.window, "fiveHour")
    assert.strictEqual(iso(reading.limit?.until), "2026-11-05T04:00:00.000Z")
  })

  it("reads a window only when the event carries it: the five-hour one is often missing", () => {
    // What Claude Code 2.1.318 emits when the API's headers have the weekly utilization and not the five-hour one.
    const raw = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1794354909,
        rateLimitType: "seven_day",
        isUsingOverage: false,
        unifiedWindows: { seven_day: { utilization: 0.36, resetsAt: 1794354909, status: "allowed" } }
      }
    }
    const reading = Option.getOrThrow(fromClaudeRaw(raw, now))
    assert.strictEqual(reading.weekly?.usedPercent, 36)
    assert.isUndefined(reading.fiveHour)
    const both = {
      ...raw,
      rate_limit_info: {
        ...raw.rate_limit_info,
        unifiedWindows: {
          ...raw.rate_limit_info.unifiedWindows,
          five_hour: { utilization: 0.12, resetsAt: 1794020100, status: "allowed" }
        }
      }
    }
    assert.strictEqual(Option.getOrThrow(fromClaudeRaw(both, now)).fiveHour?.usedPercent, 12)
  })

  it("ignores other raw parts", () => {
    assert.isTrue(Option.isNone(fromClaudeRaw({ type: "stream_event", event: {} }, now)))
  })
})

describe("Codex rollouts", () => {
  it("reads both windows from a completed turn", () => {
    const reading = fromCodexRollout(fixture("codex-rollout-ok.jsonl"), now, now)
    assert.strictEqual(reading.fiveHour?.usedPercent, 42.5)
    assert.strictEqual(reading.weekly?.usedPercent, 12)
    assert.isDefined(reading.fiveHour?.resetsAt)
    assert.isUndefined(reading.limit)
  })

  it("can leave out usage an earlier turn recorded", () => {
    const text = fixture("codex-rollout-ok.jsonl")
    const before = DateTime.makeUnsafe("2026-11-04T23:58:00Z")
    const after = DateTime.makeUnsafe("2026-11-04T23:59:00Z")
    assert.strictEqual(fromCodexRollout(text, before, now, { onlySince: true }).weekly?.usedPercent, 12)
    assert.deepStrictEqual(fromCodexRollout(text, after, now, { onlySince: true }), {})
    assert.strictEqual(fromCodexRollout(text, after, now).weekly?.usedPercent, 12)
  })

  it("finds the limit a turn ended on, and when it resets", () => {
    const since = DateTime.makeUnsafe("2026-11-04T23:58:00Z")
    const reading = fromCodexRollout(fixture("codex-rollout-limit.jsonl"), since, now)
    assert.strictEqual(reading.fiveHour?.usedPercent, 100)
    assert.strictEqual(reading.limit?.window, "fiveHour")
    assert.strictEqual(iso(reading.limit?.until), iso(reading.fiveHour?.resetsAt))
  })

  it("recognizes the usage-limit message the turn ends with", () => {
    assert.isTrue(
      isCodexUsageLimitMessage(
        "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 5th, 2026 12:58 AM."
      )
    )
    assert.isFalse(isCodexUsageLimitMessage("unexpected status 401 Unauthorized"))
  })
})

describe("snapshots", () => {
  it("keeps the latest value per window and drops a limit that has passed", () => {
    const earlier = { fiveHour: { usedPercent: 10 }, weekly: { usedPercent: 20 } }
    const later = { fiveHour: { usedPercent: 30 }, limit: { window: "fiveHour" as const, until: now } }
    const snapshot = toSnapshot("claude", merge(earlier, later), now)
    assert.deepStrictEqual(snapshot, {
      provider: "claude",
      fiveHour: { usedPercent: 30 },
      weekly: { usedPercent: 20 },
      observedAt: now
    })
  })
})

describe("dream usage", () => {
  const now = DateTime.makeUnsafe("2026-11-08T12:00:00Z")
  const resetsAt = DateTime.makeUnsafe("2026-11-10T16:00:00Z")
  const snapshot = {
    provider: "claude" as const,
    plan: "Claude Max",
    weekly: { usedPercent: 62, resetsAt },
    observedAt: now
  }
  const week = { usedPercent: 62, projectPercent: 21, resetsAt }

  it("shows the project's share and how close it is to each limit they set", () => {
    const text = Format.usage(snapshot, now, { limits: { projectWeekPercent: 30, planLeftPercent: 10 }, week })
    assert.include(text, "This project has used about 21% of the week.")
    assert.include(
      text,
      "Limits they set: this project may use up to 30% of the week (about 9% to go); Dream stops it when the plan has 10% left (about 28% to go)."
    )
    assert.notInclude(text, "Paused")
  })

  it("says when a limit holds the project, and until when at the latest", () => {
    const text = Format.usage(snapshot, now, {
      limits: { planLeftPercent: 40 },
      week,
      reached: { limit: "planLeft", percent: 40 }
    })
    assert.include(text, "Dream stops it when the plan has 40% left (reached)")
    assert.include(
      text,
      "Paused: the plan is down to the 40% they keep free. Nothing new starts until they raise or clear it, or the week resets 2026-11-10T16:00Z"
    )
  })

  it("says when there are no limits, and shows the windows alone from an API that predates them", () => {
    assert.include(Format.usage(snapshot, now, { limits: {}, week }), "They've set no usage limits on this project.")
    assert.notInclude(Format.usage(snapshot, now), "limits")
  })
})

describe("what Dream paid, in `dream usage`", () => {
  const period = (usd: number, lines: ProjectCosts["month"]["lines"]) => ({
    from: now,
    to: now,
    usd,
    lines,
    models: []
  })
  const report = (month: ProjectCosts["month"], lastMonth = period(0, [])): ProjectCosts => ({
    projectId: "prj_a" as ProjectId,
    month,
    lastMonth,
    days: []
  })

  it("says the month, what it went to, and what their own key paid", () => {
    const text = Format.costs(
      report(
        period(3.19, [
          { center: "models", payer: "dream", usd: 3, quantity: 12, unit: "request" },
          { center: "models", payer: "person", usd: 2, quantity: 1, unit: "request" },
          { center: "sandbox", payer: "dream", usd: 0.17, quantity: 1.24, unit: "hour" },
          { center: "browser", payer: "dream", usd: 0.002, quantity: 1, unit: "minute" }
        ]),
        period(0.6, [])
      )
    )
    assert.strictEqual(
      text,
      [
        "Dream has paid about $3.19 to run this project this month, at list prices. Last month: $0.60.",
        "AI models $3.00 (12 calls), this sandbox $0.17 (1.2 hours), browsers under a cent (1 minute).",
        "Their own key paid $2.00 more for AI models (1 call)."
      ].join("\n")
    )
  })

  it("says so when Dream paid nothing yet", () => {
    assert.strictEqual(Format.costs(report(period(0, []))), "Dream has paid nothing to run this project this month.")
  })
})
