import type {
  AccountUsage,
  ModelConnection,
  ModelConnectionId,
  ProjectId,
  ProjectUsage,
  ProjectUsageGlance
} from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer } from "effect"
import { AccountUsages } from "../src/data/AccountUsages.ts"
import { AppClient, type AppRpcClient } from "../src/data/AppClient.ts"
import {
  latestGlance,
  parseLimit,
  percentLabel,
  planCard,
  profileHint,
  ringArcs,
  usageBadge,
  usageSheet,
  withLimit
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

  it("says it's paused, in amber, while a limit they set holds the project", () => {
    const paused = usageBadge(glance({ usedPercent: 40, projectPercent: 25 }), { limit: "project", percent: 25 })
    assert.deepStrictEqual([paused?.value, paused?.caption, paused?.nearLimit], ["25%", "paused", true])
    assert.strictEqual(usageBadge(undefined, { limit: "planLeft", percent: 10 })?.value, "—")
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

describe("usageSheet", () => {
  const sheet = usageSheet(Fx.liftLogUsage, "Lift Log", now, la)
  const resets = DateTime.makeUnsafe("2026-11-09T16:00:00Z")

  it("shows what this project used of the week, what's left and when it resets, and no limits yet", () => {
    assert.strictEqual(sheet.subtitle, "Lift Log · ChatGPT Pro")
    assert.deepStrictEqual(
      [sheet.hero?.share, sheet.hero?.left, sheet.hero?.resets],
      ["4%", "62%", "Resets Mon 12:00 AM"]
    )
    assert.isUndefined(sheet.callout)
    assert.deepStrictEqual(sheet.limits, {
      project: { value: undefined, reached: false },
      planLeft: { value: undefined, reached: false }
    })
    const claude = usageSheet({ ...Fx.liftLogUsage, provider: "claude", plan: "Claude Max" }, "Lift Log", now, la)
    assert.strictEqual(claude.subtitle, "Lift Log · Claude Max")
  })

  it("prefers the week as a whole, which an API sends even when this project didn't work in it", () => {
    const { weekly: _, ...rest } = Fx.liftLogUsage
    const idle = usageSheet({ ...rest, weekWindow: { usedPercent: 50, projectPercent: 0 } }, "Lift Log", now, la)
    assert.deepStrictEqual([idle.hero?.share, idle.hero?.left], ["<1%", "50%"])
  })

  it("near the limit, says what's left and until when", () => {
    const usage: ProjectUsage = {
      ...Fx.liftLogUsage,
      weekly: { usedPercent: 92, projectPercent: 31, resetsAt: resets }
    }
    const near = usageSheet(usage, "Lift Log", now, la)
    assert.isTrue(near.hero?.nearLimit)
    assert.strictEqual(near.hero?.left, "8%")
    assert.strictEqual(near.callout?.left, "8% of your week is left")
    assert.isTrue(near.callout?.rest.startsWith(", until Mon 8:00 AM."))
  })

  it("shows each limit with where the project stands, and says which one paused it", () => {
    const week = { usedPercent: 70, projectPercent: 25, resetsAt: resets }
    const usage: ProjectUsage = {
      ...Fx.liftLogUsage,
      weekly: week,
      weekWindow: week,
      limits: { projectWeekPercent: 25, planLeftPercent: 10 },
      limitReached: { limit: "project", percent: 25 }
    }
    const paused = usageSheet(usage, "Lift Log", now, la)
    assert.deepStrictEqual(paused.limits, {
      project: { value: 25, note: "About 25% used so far", reached: true },
      planLeft: { value: 10, note: "30% left now", reached: false }
    })
    assert.isTrue(paused.hero?.nearLimit)
    assert.isFalse(paused.hero?.lowLeft)
    assert.deepStrictEqual(paused.callout, {
      left: "Paused at the 25% you gave it",
      rest: ". It picks up when you raise or clear the limit, or when your week resets Mon 8:00 AM."
    })
    const floor = usageSheet({ ...usage, limitReached: { limit: "planLeft", percent: 10 } }, "Lift Log", now, la)
    assert.strictEqual(floor.callout?.left, "Paused to keep 10% of your week free")
    assert.include(floor.callout?.rest, "when you lower or clear the limit")
  })

  it("without the week, has no ring, and the limits still show", () => {
    const { weekly: _, fiveHourWindow: __, ...rest } = Fx.liftLogUsage
    const unknown = usageSheet({ ...rest, limits: { planLeftPercent: 20 } }, "Lift Log", now, la)
    assert.isUndefined(unknown.hero)
    assert.deepStrictEqual(unknown.limits.planLeft, { value: 20, reached: false })
  })
})

describe("limit fields", () => {
  it("take whole percents from 1 to 99, and clear on anything else", () => {
    assert.deepStrictEqual(["25", " 7%", "", "0", "00", "99"].map(parseLimit), [
      25,
      7,
      undefined,
      undefined,
      undefined,
      99
    ])
  })

  it("change one limit and keep the other", () => {
    assert.deepStrictEqual(withLimit({ planLeftPercent: 10 }, "project", 30), {
      planLeftPercent: 10,
      projectWeekPercent: 30
    })
    assert.deepStrictEqual(withLimit({ planLeftPercent: 10, projectWeekPercent: 30 }, "planLeft", undefined), {
      projectWeekPercent: 30
    })
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
    assert.strictEqual(card.footnote, "Shares are estimates.")
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

  it("puts the deleted projects together in one row, after the others and before Outside Dream", () => {
    const gone = (id: string, sharePercent: number) => ({
      projectId: id as ProjectId,
      title: "Deleted project",
      sharePercent
    })
    const account: AccountUsage = {
      ...Fx.accountUsage,
      projects: [Fx.accountUsage.projects[0]!, gone("prj_gone1", 14), gone("prj_gone2", 0.3)],
      outsideDreamPercent: 6
    }
    const card = planCard(connection(Fx.usage), account, now, la)
    assert.deepStrictEqual(
      card.projects.map((p) => [p.key, p.title, p.share, p.bar]),
      [
        [Fx.accountUsage.projects[0]!.projectId, Fx.accountUsage.projects[0]!.title, "19%", 1],
        ["deleted", "Deleted projects", "14%", 14.3 / 19],
        ["outside", "Outside Dream", "6%", 6 / 19]
      ]
    )
    const one = planCard(connection(Fx.usage), { ...account, projects: [gone("prj_gone1", 2)] }, now, la)
    assert.deepStrictEqual(
      one.projects.map((p) => p.title),
      ["Deleted project", "Outside Dream"]
    )
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
