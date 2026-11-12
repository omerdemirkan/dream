import type { AccountCosts, CostPeriod, ProjectCosts, ProjectId } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Redacted, Schema } from "effect"
import { AccountCosts as AccountCostsSchema, ProjectCosts as ProjectCostsSchema } from "@dream/domain"
import { Socket } from "effect/socket"
import { Reactivity } from "effect/reactivity"
import { AppClient } from "../src/data/AppClient.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { CostReports } from "../src/data/CostReports.ts"
import {
  accountCostsView,
  costsTile,
  dayBars,
  dollars,
  everyoneView,
  projectCostsSummary,
  quantityLabel
} from "../src/data/costs.ts"
import { sentenceText } from "../src/data/format.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"
import { FakeBackend } from "../src/fake/FakeBackend.ts"

const nov = DateTime.makeUnsafe("2026-11-01T00:00:00Z")
const dec = DateTime.makeUnsafe("2026-12-01T00:00:00Z")
const oct = DateTime.makeUnsafe("2026-10-01T00:00:00Z")

const period = (from: DateTime.Utc, to: DateTime.Utc, over: Partial<CostPeriod> = {}): CostPeriod => ({
  from,
  to,
  usd: 0,
  lines: [],
  models: [],
  ...over
})

describe("dollars and quantities", () => {
  it("reads amounts as people say them", () => {
    assert.deepStrictEqual([0, 0.001, 0.004, 0.006, 6.789, 18.4, 1234.5].map(dollars), [
      "$0",
      "<$0.01",
      "<$0.01",
      "$0.01",
      "$6.79",
      "$18.40",
      "$1,235"
    ])
  })

  it("says what the dollars bought, in natural units", () => {
    assert.strictEqual(quantityLabel({ quantity: 41.2, unit: "hour" }), "41 hours")
    assert.strictEqual(quantityLabel({ quantity: 1.5, unit: "hour" }), "1.5 hours")
    assert.strictEqual(quantityLabel({ quantity: 1, unit: "hour" }), "1 hour")
    assert.strictEqual(quantityLabel({ quantity: 0.66, unit: "hour" }), "40 minutes")
    assert.strictEqual(quantityLabel({ quantity: 52, unit: "minute" }), "52 minutes")
    assert.strictEqual(quantityLabel({ quantity: 150, unit: "minute" }), "2.5 hours")
    assert.strictEqual(quantityLabel({ quantity: 1240, unit: "request" }), "1,240 requests")
    assert.strictEqual(quantityLabel({ quantity: 1, unit: "message" }), "1 email")
    // GB-months so far this month don't read as anything.
    assert.isUndefined(quantityLabel({ quantity: 0.4, unit: "gbMonth" }))
    assert.isUndefined(quantityLabel({ quantity: 0, unit: "hour" }))
  })
})

describe("projectCostsSummary", () => {
  const costs = (month: Partial<CostPeriod>, lastUsd = 0): ProjectCosts => ({
    projectId: Fx.liftLog.id,
    month: period(nov, dec, month),
    lastMonth: period(oct, nov, { usd: lastUsd }),
    days: []
  })
  const machine = (usd: number, hours: number) =>
    ({ center: "sandbox", payer: "dream", usd, quantity: hours, unit: "hour" }) as const

  it("has nothing to say for a project that hasn't cost anything", () => {
    assert.isUndefined(projectCostsSummary(costs({})))
  })

  it("names the only thing it paid for in the sentence, as the founder's project reads", () => {
    const summary = projectCostsSummary(
      costs({
        usd: 0.41,
        lines: [machine(0.41, 2.5), { center: "storage", payer: "dream", usd: 0, quantity: 0.01, unit: "gbMonth" }]
      })
    )
    assert.strictEqual(
      sentenceText(summary?.sentence ?? []),
      "Dream paid $0.41 this month to keep its computer running, for 2.5 hours. None of that comes out of your plan."
    )
    assert.deepStrictEqual(
      summary?.sentence.filter((p) => p.tone).map((p) => p.text),
      ["$0.41"]
    )
    assert.deepStrictEqual(summary?.rows, [])
  })

  it("says what most of it went to, and opens into every line with last month under them", () => {
    const summary = projectCostsSummary(
      costs(
        {
          usd: 10.01,
          lines: [
            machine(6.79, 41),
            { center: "mac", payer: "dream", usd: 2.28, quantity: 38, unit: "minute" },
            { center: "models", payer: "dream", usd: 0.93, quantity: 412, unit: "request" },
            { center: "storage", payer: "dream", usd: 0.01, quantity: 0.4, unit: "gbMonth" }
          ],
          models: [{ model: "gpt-4o-mini-tts", payer: "dream", usd: 0.93, requests: 412 }]
        },
        34.8
      )
    )
    assert.strictEqual(
      sentenceText(summary?.sentence ?? []),
      "Dream paid $10.01 this month to run it, most of it for machine time. None of that comes out of your plan."
    )
    assert.deepStrictEqual(
      summary?.rows.map((r) => [r.title, r.detail, r.amount]),
      [
        ["Machine time", "41 hours", "$6.79"],
        ["Macs", "38 minutes", "$2.28"],
        ["OpenAI · gpt-4o-mini-tts", "412 requests", "$0.93"],
        ["Storage", undefined, "$0.01"]
      ]
    )
    assert.strictEqual(summary?.lastMonth, "$34.80 in October")
  })

  it("leaves out what most of it went to when nothing is most, and anything Dream didn't pay", () => {
    const summary = projectCostsSummary(
      costs({
        usd: 6.59,
        lines: [
          machine(2.6, 16),
          { center: "models", payer: "dream", usd: 2, quantity: 496, unit: "request" },
          { center: "browser", payer: "dream", usd: 1.99, quantity: 995, unit: "minute" },
          { center: "models", payer: "person", usd: 9, quantity: 9, unit: "request" }
        ],
        models: [
          { model: "gpt-image-2", payer: "dream", usd: 1.99, requests: 84 },
          { model: "text-embedding-3-small", payer: "dream", usd: 0.01, requests: 412 },
          { model: "openai/gpt-x", payer: "person", usd: 9, requests: 9 }
        ]
      })
    )
    assert.strictEqual(
      sentenceText(summary?.sentence ?? []),
      "Dream paid $6.59 this month to run it. None of that comes out of your plan."
    )
    assert.deepStrictEqual(
      summary?.rows.map((r) => r.title),
      ["Machine time", "OpenAI", "Cloud browsers"]
    )
    assert.deepStrictEqual(
      summary?.rows[1]?.models.map((m) => m.title),
      ["gpt-image-2", "text-embedding-3-small"]
    )
    assert.isUndefined(summary?.lastMonth)
  })

  it("says so when it hasn't cost anything yet this month, but did last month", () => {
    const summary = projectCostsSummary(costs({}, 7.42))
    assert.strictEqual(
      sentenceText(summary?.sentence ?? []),
      "Dream hasn’t paid anything to run it this month, and paid $7.42 in October. None of that comes out of your plan."
    )
    assert.deepStrictEqual(summary?.rows, [])
  })

  it("names other single lines in words too", () => {
    const one = (line: CostPeriod["lines"][number]) =>
      sentenceText(projectCostsSummary(costs({ usd: line.usd, lines: [line] }))?.sentence ?? [])
    assert.include(
      one({ center: "mac", payer: "dream", usd: 2.28, quantity: 38, unit: "minute" }),
      "for 38 minutes on a Mac."
    )
    assert.include(
      one({ center: "email", payer: "dream", usd: 0.01, quantity: 31, unit: "message" }),
      "this month to send 31 emails."
    )
    assert.include(
      one({ center: "storage", payer: "dream", usd: 0.02, quantity: 1.2, unit: "gbMonth" }),
      "to store its files."
    )
  })
})

describe("the 30 days", () => {
  it("draws each day against the costliest, and labels it", () => {
    const bars = dayBars([
      { day: "2026-11-02", usd: 0.5 },
      { day: "2026-11-03", usd: 2 },
      { day: "2026-11-04", usd: 0 }
    ])
    assert.deepStrictEqual(
      bars.map((b) => [b.height, b.label]),
      [
        [0.25, "Nov 2 · $0.50"],
        [1, "Nov 3 · $2.00"],
        [0, "Nov 4 · $0"]
      ]
    )
    assert.deepStrictEqual(
      dayBars([{ day: "2026-11-04", usd: 0 }]).map((b) => b.height),
      [0]
    )
  })
})

describe("Settings and the detail", () => {
  const account = (over: Partial<AccountCosts> = {}): AccountCosts => ({
    month: period(nov, dec, {
      usd: 12.5,
      lines: [
        { center: "sandbox", payer: "dream", usd: 12, quantity: 72, unit: "hour" },
        { center: "browser", payer: "dream", usd: 0.5, quantity: 250, unit: "minute" }
      ]
    }),
    lastMonth: period(oct, nov, { usd: 9.85 }),
    days: [],
    projects: [
      { projectId: Fx.liftLog.id, title: "Lift Log", icon: "dumbbell", usd: 8 },
      { projectId: "prj_old" as ProjectId, title: "Old idea", usd: 2, archived: true },
      { projectId: "prj_gone1" as ProjectId, title: "Deleted project", usd: 1, archived: true },
      { projectId: "prj_gone2" as ProjectId, title: "A deleted project", usd: 0.5, archived: true }
    ],
    unattributed: [{ center: "sandbox", payer: "dream", usd: 1, quantity: 6, unit: "hour" }],
    ...over
  })

  it("Settings' card: the month so far and last month", () => {
    const tile = costsTile(account())
    assert.strictEqual(tile.total, "$12.50")
    assert.strictEqual(tile.caption, "so far in November · $9.85 in October")
    assert.deepStrictEqual([tile.month, tile.lastMonth], ["so far in November", "$9.85 in October"])
    assert.strictEqual(costsTile(account({ lastMonth: period(oct, nov) })).caption, "so far in November")
  })

  it("lists projects largest first: archived ones say so, deleted ones together, the rest outside a project", () => {
    const view = accountCostsView(account())
    assert.deepStrictEqual(
      view.projects.map((p) => [p.title, p.detail, p.amount, p.projectId, p.outside]),
      [
        ["Lift Log", undefined, "$8.00", Fx.liftLog.id, false],
        ["Old idea", "Archived", "$2.00", undefined, false],
        ["Deleted projects", undefined, "$1.50", undefined, false],
        ["Outside your projects", undefined, "$1.00", undefined, true]
      ]
    )
    assert.strictEqual(view.projects[0]?.bar, 1)
    assert.strictEqual(view.projects[1]?.bar, 0.25)
    assert.deepStrictEqual(
      view.rows.map((r) => r.title),
      ["Machine time", "Cloud browsers"]
    )
    assert.isFalse(view.everyone)
  })
})

const appLayer = makeAppLayer(
  { apiUrl: "https://dream.test", backend: "fixtures" },
  {
    storage: SecureStorage.layerMemory(),
    webSocket: Socket.layerWebSocketConstructorGlobal,
    fetch: globalThis.fetch
  }
).pipe(Layer.provideMerge(Reactivity.layer))

const signIn = Effect.gen(function* () {
  const app = yield* AppClient
  const session = yield* Session
  const result = yield* app.DevSignIn({ email: "ada@example.com", secret: Redacted.make("fixtures") })
  yield* session.signIn({ token: result.sessionToken, user: result.user })
})

const run = <A, E>(effect: Effect.Effect<A, E, any>) => effect.pipe(Effect.provide(appLayer)) as Effect.Effect<A, E>

describe("the fixtures' costs through the app's services", () => {
  it.effect("are realistic, add up, and decode as the API's would", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const reports = yield* CostReports
        const account = yield* reports.account()
        assert.isDefined(account)
        if (!account) return
        // What the TestFlight build would decode from the Worker.
        Schema.decodeUnknownSync(AccountCostsSchema)(Schema.encodeSync(AccountCostsSchema)(account))
        const dream = account.month.lines.filter((l) => l.payer === "dream").reduce((n, l) => n + l.usd, 0)
        assert.closeTo(account.month.usd, dream, 1e-9)
        const parts =
          account.projects.reduce((n, p) => n + p.usd, 0) + account.unattributed.reduce((n, l) => n + l.usd, 0)
        assert.closeTo(parts, account.month.usd, 1e-9)
        assert.strictEqual(account.days.length, 30)
        assert.isTrue(account.month.usd > 10 && account.month.usd < 40)
        assert.strictEqual(account.projects[0]?.title, "Lift Log")
        assert.isUndefined(account.everyone)

        const lift = yield* reports.project(Fx.liftLog.id)
        assert.isDefined(lift)
        Schema.decodeUnknownSync(ProjectCostsSchema)(Schema.encodeSync(ProjectCostsSchema)(lift as ProjectCosts))
        assert.closeTo(lift?.month.usd ?? 0, account.projects[0]?.usd ?? 0, 1e-9)
        const view = projectCostsSummary(lift as ProjectCosts)
        assert.deepStrictEqual(
          view?.rows.map((r) => r.title),
          ["Machine time", "Macs", "OpenAI", "Storage"]
        )
      })
    )
  )

  it.effect("operator and none worlds", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const reports = yield* CostReports
        const backend = yield* FakeBackend

        yield* backend.scenario("costs-operator")
        const operator = yield* reports.account()
        assert.isDefined(operator?.everyone)
        const everyone = everyoneView(operator!.everyone!)
        assert.deepStrictEqual(
          everyone.people.map((p) => p.title),
          ["Maya Okafor", "Ada", "Sam Ortiz"]
        )
        assert.deepStrictEqual(
          everyone.overhead.map((r) => r.title),
          ["Machine time", "Cloud browsers"]
        )
        assert.isTrue(accountCostsView(operator!).everyone)

        yield* backend.scenario("costs-none")
        const none = yield* reports.account()
        assert.deepStrictEqual(none?.projects, [])
        assert.strictEqual(none?.month.usd, 0)
        assert.isUndefined(projectCostsSummary((yield* reports.project(Fx.liftLog.id))!))

        // The founder's month: only machine time.
        yield* backend.scenario("costs-machine")
        const machine = projectCostsSummary((yield* reports.project(Fx.liftLog.id))!)
        assert.strictEqual(
          sentenceText(machine?.sentence ?? []),
          "Dream paid $0.41 this month to keep its computer running, for 2.5 hours. None of that comes out of your plan."
        )

        // Back to the default on reset.
        yield* backend.scenario("reset")
        assert.isUndefined((yield* reports.account())?.everyone)
        assert.isTrue(((yield* reports.account())?.month.usd ?? 0) > 0)
      })
    )
  )

  it.effect("an API without costs shows none rather than failing", () =>
    Effect.gen(function* () {
      const reports = yield* CostReports
      assert.isUndefined(yield* reports.account())
      assert.isUndefined(yield* reports.project(Fx.liftLog.id))
    }).pipe(
      Effect.provide(
        CostReports.layer.pipe(
          Layer.provide(
            Layer.succeed(AppClient, {
              GetAccountCosts: () => Effect.die("unknown request"),
              GetProjectCosts: () => Effect.die("unknown request")
            } as never)
          )
        )
      )
    )
  )
})
