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
import { DateTime, Effect, Layer, Redacted } from "effect"
import { Reactivity } from "effect/reactivity"
import { Socket } from "effect/socket"
import { AccountUsages } from "../src/data/AccountUsages.ts"
import { AppClient, type AppRpcClient } from "../src/data/AppClient.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { ProjectUsages } from "../src/data/ProjectUsages.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"
import { FakeBackend, type Scenario } from "../src/fake/FakeBackend.ts"
import {
  latestGlance,
  limitsView,
  parseLimit,
  percentLabel,
  planCard,
  profileHint,
  ringArcs,
  usageBadge,
  usageIndex,
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

describe("usageIndex", () => {
  const resets = DateTime.makeUnsafe("2026-11-09T16:00:00Z")
  const chatgpt = (usage?: ModelConnection["usage"]): ModelConnection => ({
    id: "mcn_chatgpt" as ModelConnectionId,
    provider: "chatgpt",
    status: "connected",
    ...(usage ? { usage } : {})
  })
  const claude = (weeklyUsed?: number, limited = false): ModelConnection => ({
    id: "mcn_claude" as ModelConnectionId,
    provider: "claude",
    status: "connected",
    usage: {
      provider: "claude",
      ...(weeklyUsed === undefined ? {} : { weekly: { usedPercent: weeklyUsed } }),
      ...(limited ? { limitedUntil: { window: "fiveHour" as const, until: DateTime.add(now, { hours: 1 }) } } : {}),
      observedAt: now
    }
  })
  const codex = { harness: "codex" } as const
  const index = (
    usage: ProjectUsage,
    connections: ReadonlyArray<ModelConnection> = [chatgpt()],
    project: Parameters<typeof usageIndex>[1] = codex
  ) => usageIndex(usage, project, connections, now, la)
  const week = (usedPercent: number, projectPercent: number) => ({ usedPercent, projectPercent, resetsAt: resets })

  it("shows the week as a ring with this project's share, what's left and when it resets, and no limits", () => {
    const view = index(Fx.liftLogUsage)
    assert.strictEqual(view.ring?.label, "4%")
    assert.isFalse(view.ring?.need)
    assert.deepStrictEqual(view.lead, { text: "62% of your week is left.", need: false })
    assert.strictEqual(view.detail, "It resets Mon 12:00 AM.")
    assert.deepStrictEqual(view.limits, { value: "None", need: false })
    // One plan, nothing to move: no Plan row.
    assert.isUndefined(view.plan)
  })

  it("answers the Limits row with what's set", () => {
    const limits = (l: ProjectUsage["limits"]) =>
      index({ ...Fx.liftLogUsage, ...(l ? { limits: l } : {}) }).limits.value
    assert.strictEqual(limits({ projectWeekPercent: 25 }), "Up to 25%")
    assert.strictEqual(limits({ planLeftPercent: 10 }), "Stops at 10% left")
    assert.strictEqual(limits({ projectWeekPercent: 25, planLeftPercent: 10 }), "Two set")
  })

  it("has a Plan row with both plans connected, naming the one it runs on", () => {
    const view = index(Fx.liftLogUsage, [chatgpt(), claude(38)])
    assert.deepStrictEqual(view.plan, { value: "ChatGPT", need: false, busy: false })
  })

  it("near the end of the week, the line turns amber, and the Plan row says the other plan has room", () => {
    const near: ProjectUsage = { ...Fx.liftLogUsage, weekly: week(92, 31) }
    const view = index(near, [chatgpt(), claude(38)])
    assert.deepStrictEqual(view.lead, { text: "8% of your week is left.", need: true })
    assert.strictEqual(view.detail, "If it runs out, its work pauses until Mon 8:00 AM, then picks up on its own.")
    assert.isTrue(view.ring?.need)
    assert.strictEqual(view.plan?.note, "Your Claude plan has 62% of its week left.")
  })

  it("says nothing of the other plan's room when Dream doesn't know it, or when there's none", () => {
    const near: ProjectUsage = { ...Fx.liftLogUsage, weekly: week(92, 31) }
    assert.isUndefined(index(near, [chatgpt(), claude()]).plan?.note)
    assert.isUndefined(index(near, [chatgpt(), claude(90)]).plan?.note)
    assert.isUndefined(index(near, [chatgpt(), claude(10, true)]).plan?.note)
    assert.isUndefined(index(Fx.liftLogUsage, [chatgpt(), claude(38)]).plan?.note)
  })

  it("paused at a limit they set, the line and the Limits row say so in amber", () => {
    const paused: ProjectUsage = {
      ...Fx.liftLogUsage,
      weekly: week(70, 25),
      weekWindow: week(70, 25),
      limits: { projectWeekPercent: 25, planLeftPercent: 10 },
      limitReached: { limit: "project", percent: 25 }
    }
    const view = index(paused)
    assert.deepStrictEqual(view.lead, { text: "Paused at its 25% limit.", need: true })
    assert.strictEqual(
      view.detail,
      "It picks up when you raise or clear the limit, or when your week resets Mon 8:00 AM."
    )
    assert.isTrue(view.ring?.need)
    assert.deepStrictEqual(view.limits, { value: "Paused at 25%", need: true })
    const floor = index({ ...paused, limitReached: { limit: "planLeft", percent: 10 } })
    assert.strictEqual(floor.lead.text, "Paused to keep 10% of your week free.")
    assert.include(floor.detail, "when you lower or clear the limit")
    assert.deepStrictEqual(floor.limits, { value: "Paused at 10% left", need: true })
  })

  it("says the five hours ran out only when they're what pauses it", () => {
    const until = DateTime.makeUnsafe("2026-11-05T00:10:00Z")
    const limited = chatgpt({
      provider: "chatgpt",
      fiveHour: { usedPercent: 100, resetsAt: until },
      limitedUntil: { window: "fiveHour", until },
      observedAt: now
    })
    const usage: ProjectUsage = { ...Fx.liftLogUsage, weekly: week(36, 0.3) }
    const view = index(usage, [limited, claude(38)])
    assert.deepStrictEqual(view.lead, { text: "Paused until 4:10 PM.", need: true })
    assert.strictEqual(view.detail, "Your five hours ran out. 64% of your week is left.")
    assert.isFalse(view.ring?.need)
    // It picks up on its own soon: no move offered.
    assert.isUndefined(view.plan?.note)
    // Over: back to the week.
    const later = usageIndex(usage, codex, [limited], DateTime.add(until, { minutes: 1 }), la)
    assert.deepStrictEqual(later.lead, { text: "64% of your week is left.", need: false })
    // The window alone, nearly full, isn't a pause.
    const busy = chatgpt({ provider: "chatgpt", fiveHour: { usedPercent: 97 }, observedAt: now })
    assert.isFalse(index(usage, [busy]).lead.need)
  })

  it("when the week ran out, says when it picks up, and the Plan row offers the other plan", () => {
    const limited = chatgpt({ provider: "chatgpt", limitedUntil: { window: "weekly", until: resets }, observedAt: now })
    const view = index({ ...Fx.liftLogUsage, weekly: week(100, 31) }, [limited, claude(38)])
    assert.deepStrictEqual(view.lead, { text: "Paused until Mon 8:00 AM.", need: true })
    assert.strictEqual(view.detail, "Your week ran out. It picks up on its own then.")
    assert.isTrue(view.ring?.need)
    assert.strictEqual(view.plan?.note, "Your Claude plan has 62% of its week left.")
  })

  it("while a move waits, the Plan row says so with a spinner; after one failed, in amber", () => {
    const at = DateTime.subtract(now, { minutes: 3 })
    const moving = index(Fx.liftLogUsage, [chatgpt(), claude(38)], {
      harness: "codex",
      planSwitch: { from: "chatgpt", to: "claude", state: "waiting", requestedAt: at }
    })
    assert.deepStrictEqual(moving.plan, { value: "Moving to Claude", need: false, busy: true })
    const failed = index(Fx.liftLogUsage, [chatgpt(), claude(38)], {
      harness: "codex",
      planSwitch: { from: "chatgpt", to: "claude", state: "failed", requestedAt: at, endedAt: at }
    })
    assert.deepStrictEqual(failed.plan, { value: "Didn’t move", need: true, busy: false })
    // Even with the other plan gone since, the row stays to say what happened.
    assert.strictEqual(
      index(Fx.liftLogUsage, [chatgpt()], {
        harness: "codex",
        planSwitch: { from: "chatgpt", to: "claude", state: "failed", requestedAt: at, endedAt: at }
      }).plan?.value,
      "Didn’t move"
    )
  })

  it("without the week, has no ring and says Dream doesn't know yet", () => {
    const { weekly: _, fiveHourWindow: __, ...rest } = Fx.liftLogUsage
    const view = index(rest)
    assert.isUndefined(view.ring)
    assert.deepStrictEqual(view.lead, {
      text: "Dream doesn’t know yet how much of your ChatGPT week is used.",
      need: false
    })
    assert.isUndefined(view.detail)
    assert.strictEqual(
      index({ ...rest, billing: "apiKey" }).lead.text,
      "It runs on an API key, so there’s no weekly limit to share."
    )
  })
})

describe("limitsView", () => {
  it("shows each limit with where the project stands, and which one paused it", () => {
    const usage: ProjectUsage = {
      ...Fx.liftLogUsage,
      weekly: { usedPercent: 70, projectPercent: 25 },
      limits: { projectWeekPercent: 25, planLeftPercent: 10 },
      limitReached: { limit: "project", percent: 25 }
    }
    assert.deepStrictEqual(limitsView(usage), {
      project: { value: 25, note: "About 25% used so far", reached: true },
      planLeft: { value: 10, note: "30% left now", reached: false }
    })
    assert.deepStrictEqual(limitsView(Fx.liftLogUsage), {
      project: { value: undefined, reached: false },
      planLeft: { value: undefined, reached: false }
    })
  })

  it("without the week, still shows the limits, without notes", () => {
    const { weekly: _, ...rest } = Fx.liftLogUsage
    assert.deepStrictEqual(limitsView({ ...rest, limits: { planLeftPercent: 20 } }).planLeft, {
      value: 20,
      reached: false
    })
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

describe("the usage sheet in the fixtures world", () => {
  const appLayer = makeAppLayer(
    { apiUrl: "https://dream.test", backend: "fixtures" },
    { storage: SecureStorage.layerMemory(), webSocket: Socket.layerWebSocketConstructorGlobal, fetch: globalThis.fetch }
  ).pipe(Layer.provideMerge(Reactivity.layer))
  const signIn = Effect.gen(function* () {
    const app = yield* AppClient
    const session = yield* Session
    const result = yield* app.DevSignIn({ email: "ada@example.com", secret: Redacted.make("fixtures") })
    yield* session.signIn({ token: result.sessionToken, user: result.user })
  })
  // The fixtures backend is in the app's layer when it's built for fixtures, which its type can't say.
  const run = <A, E>(effect: Effect.Effect<A, E, any>) => effect.pipe(Effect.provide(appLayer)) as Effect.Effect<A, E>
  const sheetIn = (...scenarios: ReadonlyArray<Scenario>) =>
    Effect.gen(function* () {
      const backend = yield* FakeBackend
      for (const scenario of ["reset", ...scenarios] as const) yield* backend.scenario(scenario)
      const app = yield* AppClient
      const usage = yield* (yield* ProjectUsages).sheet(Fx.liftLog.id)
      const connections = yield* app.ListModelConnections()
      const project = (yield* app.ListProjects()).find((p) => p.project.id === Fx.liftLog.id)?.project
      return usageIndex(usage, project ?? { harness: "codex" }, connections, yield* DateTime.now)
    })

  it.effect("reaches every state the sheet has", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const normal = yield* sheetIn()
        assert.match(normal.lead.text, /^\d+% of your week is left\.$/)
        assert.isUndefined(normal.plan)

        assert.strictEqual((yield* sheetIn("two-plans")).plan?.value, "ChatGPT")

        const near = yield* sheetIn("usage-near-limit", "two-plans")
        assert.deepStrictEqual(near.lead, { text: "8% of your week is left.", need: true })
        assert.strictEqual(near.plan?.note, "Your Claude plan has 62% of its week left.")

        const paused = yield* sheetIn("usage-limit")
        assert.match(paused.lead.text, /^Paused at its \d+% limit\.$/)
        assert.isTrue(paused.limits.need)

        const five = yield* sheetIn("plan-limited", "paused")
        assert.match(five.lead.text, /^Paused until /)
        assert.match(five.detail ?? "", /^Your five hours ran out\./)

        const weekOut = yield* sheetIn("usage-near-limit", "two-plans", "plan-week-out")
        assert.strictEqual(weekOut.detail, "Your week ran out. It picks up on its own then.")

        assert.isTrue((yield* sheetIn("two-plans", "plan-moving")).plan?.busy)
        assert.isTrue((yield* sheetIn("two-plans", "plan-move-failed")).plan?.need)
        assert.isUndefined((yield* sheetIn("usage-none")).ring)
      })
    )
  )
})
