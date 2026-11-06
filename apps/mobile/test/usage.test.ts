import type { ProjectUsage, ProjectUsageGlance } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { latestGlance, percentLabel, ringArcs, tokensLabel, usageBadge, usageSheet } from "../src/data/usage.ts"

const la = "America/Los_Angeles"
const now = Fx.liftLogUsage.observedAt

const glance = (weekly: ProjectUsageGlance["weekly"], iso = "2026-11-04T22:10:00Z"): ProjectUsageGlance => ({
  provider: "chatgpt",
  billing: "subscription",
  ...(weekly ? { weekly } : {}),
  observedAt: DateTime.makeUnsafe(iso)
})

describe("usageBadge", () => {
  it("shows nothing without the week: no usage known, or none of it this project's", () => {
    assert.isUndefined(usageBadge(undefined))
    assert.isUndefined(usageBadge(glance(undefined)))
  })

  it("shows this project's share, with an arc long enough to see", () => {
    const badge = usageBadge(glance({ usedPercent: 38, projectPercent: 4 }))
    assert.strictEqual(badge?.value, "4%")
    assert.strictEqual(badge?.caption, "of week")
    assert.isFalse(badge?.nearLimit)
    assert.strictEqual(badge?.arcs.project, 0.08)
    assert.closeTo(badge?.arcs.others ?? 0, 0.34, 1e-9)
  })

  it("near the limit, says what's left of the week", () => {
    const badge = usageBadge(glance({ usedPercent: 92, projectPercent: 31 }))
    assert.isTrue(badge?.nearLimit)
    assert.strictEqual(badge?.value, "8% left")
    assert.closeTo(badge?.arcs.project ?? 0, 0.31, 1e-9)
    assert.closeTo(badge?.arcs.others ?? 0, 0.61, 1e-9)
    assert.isFalse(usageBadge(glance({ usedPercent: 84, projectPercent: 31 }))?.nearLimit)
  })

  it("a share too small to round reads <1%, never 0%", () => {
    assert.strictEqual(usageBadge(glance({ usedPercent: 12, projectPercent: 0.2 }))?.value, "<1%")
    assert.strictEqual(percentLabel(0), "<1%")
    assert.strictEqual(percentLabel(3.6), "4%")
  })
})

describe("ringArcs", () => {
  it("never overruns the circle when the minimum arc meets a full week", () => {
    const arcs = ringArcs({ usedPercent: 100, projectPercent: 1 }, 0.08)
    assert.strictEqual(arcs.project, 0.08)
    assert.closeTo(arcs.others, 0.92, 1e-9)
  })
})

describe("latestGlance", () => {
  it("keeps the newer, and a tie goes to what just arrived", () => {
    const older = glance({ usedPercent: 38, projectPercent: 4 }, "2026-11-04T22:00:00Z")
    const newer = glance(undefined, "2026-11-04T22:10:00Z")
    assert.strictEqual(latestGlance(older, newer), newer)
    assert.strictEqual(latestGlance(newer, older), newer)
    assert.strictEqual(latestGlance(undefined, older), older)
    assert.strictEqual(latestGlance(older, undefined), older)
    const same = glance({ usedPercent: 40, projectPercent: 5 }, "2026-11-04T22:00:00Z")
    assert.strictEqual(latestGlance(older, same), same)
  })
})

describe("tokensLabel", () => {
  it("is short", () => {
    assert.deepStrictEqual([640, 45_200, 910_000, 2_140_000, 9_620_000, 142_000_000].map(tokensLabel), [
      "640",
      "45K",
      "0.9M",
      "2.1M",
      "9.6M",
      "142M"
    ])
  })
})

describe("usageSheet", () => {
  const sheet = usageSheet(Fx.liftLogUsage, "Lift Log", Fx.liftLog.id, now, la)

  it("reads like the mock: the hero, three periods, both windows, every project and Outside Dream", () => {
    assert.strictEqual(sheet.subtitle, "Lift Log · ChatGPT Pro")
    assert.deepStrictEqual(sheet.hero?.legend, { project: "4%", others: "34%", left: "62%" })
    assert.strictEqual(sheet.hero?.share, "4%")
    assert.isUndefined(sheet.callout)
    assert.deepStrictEqual(sheet.periods, [
      { label: "Today", value: "2.1M", detail: "≈2% of week" },
      { label: "This 5 hours", value: "0.9M", detail: "≈9% of 5 hours" },
      { label: "This week", value: "9.6M", detail: "≈4% of week" }
    ])
    assert.strictEqual(sheet.windowsTitle, "Your ChatGPT Pro")
    assert.deepStrictEqual(
      sheet.windows.map((w) => [w.label, w.used, w.resets]),
      [
        ["5 hours", "41% used", "resets 3:40 PM"],
        ["Week", "38% used", "resets Mon 12:00 AM"]
      ]
    )
    assert.deepStrictEqual(
      sheet.projects.map((p) => [p.title, p.share, p.current, p.outside]),
      [
        ["Recipe Scaler", "19%", false, false],
        ["Lift Log", "4%", true, false],
        ["Cabin", "3%", false, false],
        ["Morning Brief", "2%", false, false],
        ["Outside Dream", "10%", false, true]
      ]
    )
    assert.strictEqual(sheet.projects[0]?.bar, 1)
    assert.strictEqual(
      sheet.footnote,
      "Tokens are exact. Shares (≈) are estimated from how your plan moved while each project worked."
    )
  })

  it("says when subagents aren't counted, and shows a quiet dash for a period without tokens", () => {
    const usage: ProjectUsage = { ...Fx.liftLogUsage, subagents: "excluded", today: {} }
    const excluded = usageSheet(usage, "Lift Log", Fx.liftLog.id, now, la)
    assert.include(excluded.footnote, "leave out what subagents used")
    assert.deepStrictEqual(excluded.periods[0], { label: "Today", value: "—" })
  })

  it("near the limit, says what's left and until when", () => {
    const usage: ProjectUsage = {
      ...Fx.liftLogUsage,
      weekly: { usedPercent: 92, projectPercent: 31, resetsAt: DateTime.makeUnsafe("2026-11-09T16:00:00Z") }
    }
    const near = usageSheet(usage, "Lift Log", Fx.liftLog.id, now, la)
    assert.isTrue(near.hero?.nearLimit)
    assert.deepStrictEqual(near.hero?.legend, { project: "31%", others: "61%", left: "8%" })
    assert.strictEqual(near.callout?.left, "8% of your week is left")
    assert.isTrue(near.callout?.rest.startsWith(", until Mon 8:00 AM."))
  })

  it("without the week, has no hero and no windows to show", () => {
    const { weekly: _, fiveHourWindow: __, ...rest } = Fx.liftLogUsage
    const unknown = usageSheet(rest, "Lift Log", Fx.liftLog.id, now, la)
    assert.isUndefined(unknown.hero)
    assert.deepStrictEqual(unknown.windows, [])
  })
})
