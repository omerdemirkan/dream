import type { AccountUsage, ModelConnection, ModelConnectionId, ProjectUsage, ProjectUsageGlance } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer } from "effect"
import { AccountUsages } from "../src/data/AccountUsages.ts"
import { AppClient, type AppRpcClient } from "../src/data/AppClient.ts"
import {
  latestGlance,
  percentLabel,
  planCard,
  profileHint,
  ringArcs,
  tokensLabel,
  usageBadge,
  usageSheet
} from "../src/data/usage.ts"

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

  it("names Claude when the plan is Claude's", () => {
    const claude = usageSheet(
      { ...Fx.liftLogUsage, provider: "claude", plan: "Claude Max" },
      "Lift Log",
      Fx.liftLog.id,
      now,
      la
    )
    assert.include(claude.footnote, "so using Claude elsewhere at the same time can count toward a project.")
    assert.strictEqual(claude.windowsTitle, "Your Claude Max")
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
      { label: "Today", value: "2.1M", cacheRead: "+18M from cache", detail: "≈2% of week" },
      { label: "This 5 hours", value: "0.9M", cacheRead: "+7.9M from cache", detail: "≈9% of 5 hours" },
      { label: "This week", value: "9.6M", cacheRead: "+83M from cache", detail: "≈4% of week" }
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
      "Tokens are exact. Shares (≈) are estimated from how your plan moved while each project worked, so using ChatGPT elsewhere at the same time can count toward a project."
    )
  })

  it("says when subagents aren't counted, and shows a quiet dash for a period without tokens", () => {
    const usage: ProjectUsage = { ...Fx.liftLogUsage, subagents: "excluded", today: {} }
    const excluded = usageSheet(usage, "Lift Log", Fx.liftLog.id, now, la)
    assert.isTrue(excluded.footnote.startsWith("Tokens are exact but leave out what subagents used. Shares (≈)"))
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

describe("Settings' plan card", () => {
  const connection = (
    usage: ModelConnection["usage"],
    status: ModelConnection["status"] = "connected"
  ): ModelConnection => ({
    id: "mc_chatgpt" as ModelConnectionId,
    provider: "chatgpt",
    status,
    ...(usage ? { usage } : {})
  })
  const near: AccountUsage = {
    ...Fx.accountUsage,
    weekly: { usedPercent: 92, dreamPercent: 78, resetsAt: DateTime.makeUnsafe("2026-11-09T16:00:00Z") }
  }

  it("reads like the mock: what's left, both windows with all projects in white, every project and Outside Dream", () => {
    const card = planCard(connection(Fx.usage), Fx.accountUsage, now, la)
    assert.strictEqual(card.title, "ChatGPT Pro")
    assert.strictEqual(card.detail, "62% of this week left")
    assert.isFalse(card.nearLimit)
    assert.isUndefined(card.callout)
    assert.deepStrictEqual(
      card.windows.map((w) => [w.label, w.used, w.resets, w.focus, w.nearLimit]),
      [
        ["5 hours", "41% used", "resets 3:40 PM", 0.3, false],
        ["Week", "38% used", "resets Mon 12:00 AM", 0.28, false]
      ]
    )
    assert.closeTo(card.windows[1]?.others ?? 0, 0.1, 1e-9)
    assert.deepStrictEqual(
      card.projects.map((p) => [p.title, p.share, p.current, p.outside]),
      [
        ["Recipe Scaler", "19%", false, false],
        ["Lift Log", "4%", false, false],
        ["Cabin", "3%", false, false],
        ["Morning Brief", "2%", false, false],
        ["Outside Dream", "10%", false, true]
      ]
    )
    assert.strictEqual(card.projects[0]?.bar, 1)
    assert.match(card.footnote ?? "", /estimated/)
  })

  it("near the limit: amber, and says what's left until when", () => {
    const card = planCard(connection(Fx.usage), near, now, la)
    assert.isTrue(card.nearLimit)
    assert.strictEqual(card.detail, "8% of this week left")
    assert.strictEqual(card.callout?.left, "8% of your week is left")
    assert.match(card.callout?.rest ?? "", /^, until Mon 8:00 AM\./)
  })

  it("without GetAccountUsage, shows the connection's own windows all grey, and no shares", () => {
    const card = planCard(connection(Fx.usage), undefined, now, la)
    assert.strictEqual(card.detail, "62% of this week left")
    assert.deepStrictEqual(
      card.windows.map((w) => [w.label, w.focus, w.others]),
      [
        ["5 hours", 0, 0.41],
        ["Week", 0, 0.38]
      ]
    )
    assert.deepStrictEqual(card.projects, [])
    assert.isUndefined(card.footnote)
    // Nothing known at all: just connected.
    const bare = planCard(connection(undefined), undefined, now, la)
    assert.deepStrictEqual([bare.title, bare.detail, bare.windows], ["ChatGPT", "Connected", []])
  })

  it("says when it's paused at a limit, in amber", () => {
    const limited = {
      ...Fx.usage,
      limitedUntil: { window: "fiveHour" as const, until: DateTime.makeUnsafe("2026-11-04T23:40:00Z") }
    }
    const card = planCard(connection(limited), Fx.accountUsage, now, la)
    assert.strictEqual(card.detail, "paused until 3:40 PM")
    assert.isTrue(card.nearLimit)
  })

  it("puts the amber dot on Home's profile button only near the limit", () => {
    assert.isFalse(profileHint([connection(Fx.usage)]))
    assert.isFalse(profileHint([connection(undefined)]))
    const heavy = { ...Fx.usage, weekly: { usedPercent: 92 } }
    assert.isTrue(profileHint([connection(heavy)]))
    assert.isFalse(profileHint([connection(heavy, "expired")]))
  })

  it.effect("an API from before GetAccountUsage leaves the card without shares instead of failing", () =>
    Effect.gen(function* () {
      const usages = yield* AccountUsages
      assert.isUndefined(yield* usages.plan("chatgpt"))
    }).pipe(
      Effect.provide(
        AccountUsages.layer.pipe(
          Layer.provide(
            // The RPC server answers a request it doesn't know with a defect.
            Layer.succeed(AppClient, {
              GetAccountUsage: () => Effect.die("Unknown request tag: GetAccountUsage")
            } as unknown as AppRpcClient)
          )
        )
      )
    )
  )
})
