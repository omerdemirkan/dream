/**
 * Settings as an index (direction B): what each plan's row and page say from what Dream knows (and only that),
 * Dream usage's row, each kind of connected service's row and page, and the account.
 */
import type {
  AccountCosts,
  CostPeriod,
  Integration,
  IntegrationId,
  ModelConnection,
  ModelConnectionId,
  ProjectId
} from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { accountView, costsRow, planPage, planRow, servicePage, serviceRow } from "../src/data/settings.ts"

const la = "America/Los_Angeles"
const now = Fx.liftLogUsage.observedAt

const connection = (fields: Partial<ModelConnection> = {}): ModelConnection => ({
  id: "mcn_chatgpt" as ModelConnectionId,
  provider: "chatgpt",
  status: "connected",
  connectedAt: DateTime.makeUnsafe("2026-10-01T17:10:00Z"),
  usage: Fx.usage,
  ...fields
})

/** A connected plan Dream has no report for yet: what the founder's ChatGPT looked like. */
const bare = (): ModelConnection => ({
  id: "mcn_chatgpt" as ModelConnectionId,
  provider: "chatgpt",
  status: "connected"
})

const near = {
  ...Fx.accountUsage,
  weekly: { usedPercent: 92, dreamPercent: 78, resetsAt: Fx.accountUsage.weekly!.resetsAt! }
}

describe("planRow", () => {
  it("says what's left of the week, with their projects' part of the ring in white", () => {
    const row = planRow(connection(), Fx.accountUsage, now, la)
    assert.strictEqual(row.title, "ChatGPT Pro")
    assert.strictEqual(row.value, "62% left")
    assert.isFalse(row.need)
    assert.closeTo(row.ring?.project ?? 0, 0.28, 1e-9)
    assert.closeTo(row.ring?.others ?? 0, 0.1, 1e-9)
    assert.isUndefined(row.note)
  })

  it("without the split, draws the connection's own week all grey", () => {
    const row = planRow(connection(), undefined, now, la)
    assert.strictEqual(row.value, "62% left")
    assert.strictEqual(row.ring?.project, 0)
    assert.closeTo(row.ring?.others ?? 0, 0.38, 1e-9)
  })

  it("near the limit turns amber and says what happens if the week runs out", () => {
    const row = planRow(connection(), near, now, la)
    assert.strictEqual(row.value, "8% left")
    assert.isTrue(row.need)
    assert.strictEqual(
      row.note,
      "If it runs out before Mon 12:00 AM, your projects on ChatGPT pause, and they pick up on their own when it resets."
    )
  })

  it("says Connected, with no ring, when Dream hasn't seen the week", () => {
    const row = planRow(bare(), undefined, now, la)
    assert.deepStrictEqual(row, { title: "ChatGPT", value: "Connected", need: false })
    // An account with no windows (no project ran on it this week) changes nothing but the plan's name.
    const empty = { ...Fx.accountUsage, fiveHour: undefined, weekly: undefined, projects: [] }
    const { fiveHour: _f, weekly: _w, ...known } = empty
    assert.deepStrictEqual(planRow(bare(), known, now, la), { title: "ChatGPT Pro", value: "Connected", need: false })
  })

  it("falls back to the five hours when that's all it knows", () => {
    const { weekly: _, ...five } = Fx.usage
    assert.strictEqual(planRow(connection({ usage: five }), undefined, now, la).value, "59% left for now")
  })

  it("says when a plan paused at its limit picks up", () => {
    const limited = {
      ...Fx.usage,
      limitedUntil: { window: "fiveHour" as const, until: DateTime.add(now, { hours: 1 }) }
    }
    const row = planRow(connection({ usage: limited }), Fx.accountUsage, now, la)
    assert.strictEqual(row.value, "Paused until 3:10 PM")
    assert.isTrue(row.need)
    assert.isUndefined(row.ring)
  })

  it("says a sign-in is under way, or stopped working", () => {
    const pending = planRow({ id: "mcn_c" as ModelConnectionId, provider: "claude", status: "pending" }, undefined, now)
    assert.deepStrictEqual(pending, { title: "Claude", value: "Finishing sign-in", need: false })
    const expired = planRow({ id: "mcn_c" as ModelConnectionId, provider: "claude", status: "expired" }, undefined, now)
    assert.deepStrictEqual(expired, { title: "Claude", value: "Sign-in expired", need: true })
    const failed = planRow({ id: "mcn_c" as ModelConnectionId, provider: "claude", status: "failed" }, undefined, now)
    assert.strictEqual(failed.value, "Sign-in failed")
  })
})

describe("planPage", () => {
  it("puts what's left in large type, the reset under it, and the week's two parts in a legend that adds up", () => {
    const page = planPage(connection(), Fx.accountUsage, now, la)
    assert.strictEqual(page.title, "ChatGPT Pro")
    assert.deepStrictEqual(page.headline, { big: "62%", rest: "of this week left", need: false })
    assert.strictEqual(page.resets, "Resets Mon 12:00 AM")
    assert.deepStrictEqual(page.legend, { projects: "Your projects 28%", outside: "Outside Dream 10%" })
    assert.closeTo(page.week?.focus ?? 0, 0.28, 1e-9)
    assert.closeTo(page.week?.others ?? 0, 0.1, 1e-9)
    assert.isFalse(page.week?.need)
    // The week is the headline and the bar; the five hours stay as a window of their own.
    assert.deepStrictEqual(
      page.card?.windows.map((w) => w.label),
      ["5 hours"]
    )
    assert.isAbove(page.card?.projects.length ?? 0, 0)
    assert.strictEqual(page.actions, "connected")
  })

  it("has no legend when nothing splits the week", () => {
    const page = planPage(connection(), undefined, now, la)
    assert.isUndefined(page.legend)
    assert.isDefined(page.week)
  })

  it("near the limit turns amber and says what happens if the week runs out, without repeating what's left", () => {
    const page = planPage(connection(), near, now, la)
    assert.deepStrictEqual(page.headline, { big: "8%", rest: "of this week left", need: true })
    assert.strictEqual(
      page.about,
      "If it runs out first, your projects on ChatGPT pause, and they pick up on their own when it resets."
    )
    assert.isUndefined(page.card?.callout)
    assert.isTrue(page.week?.need)
  })

  it("says Connected, and when the week will show, while Dream hasn't seen it", () => {
    const page = planPage(bare(), undefined, now, la)
    assert.deepStrictEqual(page.headline, { big: "Connected", need: false })
    assert.strictEqual(page.about, "Dream shows how much of the week is left once a project has run on ChatGPT.")
    assert.isUndefined(page.week)
    assert.isUndefined(page.resets)
  })

  it("says until when a paused plan waits, without repeating it in a callout", () => {
    const limited = {
      ...Fx.usage,
      limitedUntil: { window: "fiveHour" as const, until: DateTime.add(now, { hours: 1 }) }
    }
    const page = planPage(connection({ usage: limited }), near, now, la)
    assert.deepStrictEqual(page.headline, { big: "Paused until 3:10 PM", need: true })
    assert.isUndefined(page.card?.callout)
  })

  it("offers Cancel for a sign-in under way, and Reconnect for a broken one", () => {
    const pending = planPage(
      { id: "mcn_c" as ModelConnectionId, provider: "claude", status: "pending" },
      undefined,
      now
    )
    assert.strictEqual(pending.actions, "pending")
    const expired = planPage(
      { id: "mcn_c" as ModelConnectionId, provider: "claude", status: "expired" },
      undefined,
      now
    )
    assert.strictEqual(expired.actions, "broken")
    assert.deepStrictEqual(expired.headline, { big: "Sign-in expired", need: true })
    assert.strictEqual(expired.about, "Your projects on Claude wait until you connect it again. Their work is kept.")
  })
})

describe("costsRow", () => {
  const period = (usd: number, from: string): CostPeriod => ({
    from: DateTime.makeUnsafe(from),
    to: DateTime.makeUnsafe(from),
    usd,
    lines: usd > 0 ? [{ center: "sandbox", payer: "dream", usd, quantity: 3, unit: "hour" }] : [],
    models: []
  })
  const costs = (month: number, last: number, everyone = false): AccountCosts => ({
    month: period(month, "2026-11-01T00:00:00Z"),
    lastMonth: period(last, "2026-10-01T00:00:00Z"),
    days: [],
    projects: [],
    unattributed: [],
    ...(everyone
      ? {
          everyone: {
            month: period(month, "2026-11-01T00:00:00Z"),
            lastMonth: period(last, "2026-10-01T00:00:00Z"),
            days: [],
            people: [],
            overhead: []
          }
        }
      : {})
  })

  it("is this month so far, and opens the page", () => {
    assert.deepStrictEqual(costsRow(costs(44.81, 0)), { title: "November so far", value: "$44.81", opens: true })
  })

  it("says Nothing yet before anything cost anything, and opens nothing", () => {
    assert.deepStrictEqual(costsRow(costs(0, 0)), { title: "November so far", value: "Nothing yet", opens: false })
  })

  it("still opens for last month's figures, or for an operator", () => {
    assert.isTrue(costsRow(costs(0, 15.1))?.opens)
    assert.isTrue(costsRow(costs(0, 0, true))?.opens)
  })

  it("is absent until costs load", () => {
    assert.isUndefined(costsRow(undefined))
  })
})

describe("services", () => {
  const openai: Integration = {
    id: "int_openai" as IntegrationId,
    label: "OpenAI",
    status: "connected",
    access: {
      _tag: "Key",
      service: "OpenAI",
      host: "api.openai.com",
      header: "Authorization",
      format: "Bearer {key}",
      placeholder: "p"
    },
    connectedAt: DateTime.makeUnsafe("2026-11-06T18:00:00Z")
  }
  const apple: Integration = {
    ...openai,
    id: "int_apple" as IntegrationId,
    label: "Apple Developer",
    access: { _tag: "Apple", issuerId: "i", keyId: "5G566N355S" }
  }
  const title = (id: ProjectId) => (id === Fx.morningBrief.id ? "Morning Brief" : undefined)

  it("says who can use each on the right, or that it stopped working", () => {
    assert.deepStrictEqual(serviceRow(openai), { title: "OpenAI", icon: "key", value: "All projects", need: false })
    assert.deepStrictEqual(serviceRow(Fx.telegramKeyFile), {
      title: "Telegram",
      icon: "doc",
      value: "One project",
      need: false
    })
    assert.strictEqual(serviceRow(Fx.google).icon, "lock")
    assert.strictEqual(serviceRow(apple).icon, "apple")
    assert.deepStrictEqual(serviceRow({ ...Fx.google, status: "failed" }), {
      title: "Gmail",
      icon: "lock",
      value: "Stopped working",
      need: true
    })
  })

  it("a pasted key: what it's for, that it stays in the vault, Replace and Disconnect", () => {
    const page = servicePage(openai, title, la)
    assert.strictEqual(page.kind, "Key for api.openai.com, added Nov 6")
    assert.strictEqual(
      page.about,
      "Every project can use it. The key stays in Dream’s vault, and Dream adds it to requests to api.openai.com."
    )
    assert.strictEqual(page.replace?.label, "Replace key")
    assert.strictEqual(page.replace?.save, "Save to vault")
    assert.strictEqual(page.remove.label, "Disconnect")
    assert.isUndefined(page.projectId)
    assert.isUndefined(page.stopped)
  })

  it("a key file: the project it lives on, and Remove", () => {
    const page = servicePage(Fx.telegramKeyFile, title, la)
    assert.strictEqual(page.kind, "Key file, added Oct 21")
    assert.strictEqual(page.about, "It lives on Morning Brief’s computer, so no other project can reach it.")
    assert.strictEqual(page.projectId, Fx.morningBrief.id)
    assert.strictEqual(page.projectTitle, "Morning Brief")
    assert.strictEqual(page.replace?.save, "Save to this project")
    assert.strictEqual(page.remove.label, "Remove")
    assert.strictEqual(page.remove.title, "Remove Telegram?")
  })

  it("a key file whose project is gone still reads", () => {
    const page = servicePage(Fx.telegramKeyFile, () => undefined, la)
    assert.strictEqual(page.about, "It lives on one project’s computer, so no other project can reach it.")
    assert.isUndefined(page.projectTitle)
  })

  it("a sign-in or App Store Connect key can't be replaced here", () => {
    const google = servicePage(Fx.google, title, la)
    assert.strictEqual(google.kind, "Signed in as ada@example.com, added Oct 20")
    assert.isUndefined(google.replace)
    const key = servicePage(apple, title, la)
    assert.strictEqual(key.kind, "App Store Connect key 5G566N355S, added Nov 6")
    assert.isUndefined(key.replace)
  })

  it("says where to connect again one that stopped working", () => {
    const page = servicePage({ ...Fx.google, status: "revoked" }, title, la)
    assert.isUndefined(page.about)
    assert.strictEqual(
      page.stopped,
      "Gmail stopped working. Connect it again from the card of the project that asked for it."
    )
  })
})

describe("accountView", () => {
  it("is their name over their email, and since when", () => {
    assert.deepStrictEqual(accountView(Fx.user, la), {
      title: "Ada",
      subtitle: "ada@example.com",
      since: "On Dream since October 1, 2026"
    })
  })

  it("is the email alone without a name", () => {
    const { name: _, ...noName } = Fx.user
    assert.strictEqual(accountView(noName, la).title, "ada@example.com")
    assert.isUndefined(accountView(noName, la).subtitle)
  })
})
