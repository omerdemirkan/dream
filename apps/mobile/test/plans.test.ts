/**
 * Two plans: which are connected, which one a new idea goes to, which projects wait for a plan that isn't
 * connected, and what Settings and Home show for them. Presence shows a waiting project as paused, in amber.
 */
import type { ModelConnection, ModelConnectionId, ProjectId, ProjectSummary } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import {
  connectedPlans,
  defaultPlan,
  harnessToSend,
  missingPlans,
  planMissing,
  removeConsequence,
  settingsPlans
} from "../src/data/plans.ts"
import { chatRowOf, dotOf, headerLine, homeLine, presenceOf } from "../src/data/presence.ts"

const day = (d: string) => DateTime.makeUnsafe(`2026-11-${d}T12:00:00Z`)

const connection = (
  provider: ModelConnection["provider"],
  status: ModelConnection["status"],
  connectedAt = day("01")
): ModelConnection => ({
  id: `mcn_${provider}_${status}` as ModelConnectionId,
  provider,
  status,
  ...(status === "connected" ? { connectedAt } : {})
})

const summary = (title: string, harness: "claude-code" | "codex", createdAt: DateTime.Utc): ProjectSummary => ({
  project: { ...Fx.liftLog, id: `prj_${title}` as ProjectId, title, harness, createdAt },
  openAsks: 0
})

const claude = connection("claude", "connected", day("02"))
const chatgpt = connection("chatgpt", "connected", day("03"))
const onClaude = summary("Recipe Scaler", "claude-code", day("05"))
const onChatGpt = summary("Lift Log", "codex", day("04"))

describe("plans", () => {
  it("lists connected plans in order, Claude first", () => {
    assert.deepStrictEqual(connectedPlans([chatgpt, claude]), ["claude", "chatgpt"])
    assert.deepStrictEqual(connectedPlans([chatgpt, connection("claude", "expired")]), ["chatgpt"])
  })

  it("defaults a new idea to the plan of their newest project, else the plan connected last", () => {
    assert.strictEqual(defaultPlan([claude, chatgpt], [onChatGpt, onClaude]), "claude")
    assert.strictEqual(defaultPlan([claude, chatgpt], [onChatGpt]), "chatgpt")
    assert.strictEqual(defaultPlan([claude, chatgpt], []), "chatgpt")
    assert.strictEqual(defaultPlan([claude], [onChatGpt]), "claude")
    assert.isUndefined(defaultPlan([], []))
  })

  it("sends a harness only when there's a choice, so one plan works as it always has", () => {
    assert.strictEqual(harnessToSend([claude, chatgpt], "chatgpt"), "codex")
    assert.strictEqual(harnessToSend([claude, chatgpt], "claude"), "claude-code")
    assert.isUndefined(harnessToSend([claude], "claude"))
    assert.isUndefined(harnessToSend([claude, chatgpt], undefined))
  })

  it("says a project waits only when its own plan isn't connected", () => {
    assert.isTrue(planMissing([claude], "codex"))
    assert.isFalse(planMissing([claude], "claude-code"))
    assert.isTrue(planMissing([claude, connection("chatgpt", "expired")], "codex"))
    // Not loaded yet, or nothing connected at all (Home sends them to connect a plan): no claim.
    assert.isFalse(planMissing(undefined, "codex"))
    assert.isFalse(planMissing([], "codex"))
  })

  it("gives Home one banner per plan their projects wait for", () => {
    assert.deepStrictEqual(missingPlans([claude], [onClaude, onChatGpt]), [
      { provider: "chatgpt", reason: "removed", waiting: ["Lift Log"] }
    ])
    assert.deepStrictEqual(missingPlans([claude, connection("chatgpt", "expired")], [onClaude]), [
      { provider: "chatgpt", reason: "expired", waiting: [] }
    ])
    // A plan nothing runs on, or one being signed in to, needs no banner.
    assert.deepStrictEqual(missingPlans([claude], [onClaude]), [])
    assert.deepStrictEqual(missingPlans([claude, connection("chatgpt", "pending")], [onChatGpt]), [])
    assert.deepStrictEqual(missingPlans([claude, chatgpt], [onClaude, onChatGpt]), [])
  })

  it("shows Settings one row per plan and a tile to add each missing one", () => {
    const one = settingsPlans([chatgpt])
    assert.deepStrictEqual(
      one.shown.map((c) => c.provider),
      ["chatgpt"]
    )
    assert.deepStrictEqual(one.addable, ["claude"])
    // A sign-in under way for a plan already connected doesn't add a second row.
    const both = settingsPlans([chatgpt, connection("chatgpt", "pending"), claude])
    assert.deepStrictEqual(
      both.shown.map((c) => [c.provider, c.status]),
      [
        ["claude", "connected"],
        ["chatgpt", "connected"]
      ]
    )
    assert.deepStrictEqual(both.addable, [])
    assert.deepStrictEqual(settingsPlans([]).addable, ["claude", "chatgpt"])
  })

  it("says what removing a plan does to the projects on it", () => {
    assert.strictEqual(
      removeConsequence("claude", [onClaude, onChatGpt]),
      "Recipe Scaler runs on Claude. It pauses until you connect Claude again."
    )
    assert.strictEqual(
      removeConsequence("chatgpt", [onChatGpt, summary("Cabin", "codex", day("01"))]),
      "2 projects run on ChatGPT. They pause until you connect ChatGPT again."
    )
    assert.strictEqual(removeConsequence("chatgpt", [onClaude]), "You can connect ChatGPT again any time.")
  })
})

describe("a project waiting for its plan", () => {
  const now = day("06")
  const idle = { state: "idle", since: day("05") } as const
  const context = { now, harness: "codex", openAsks: 0 } as const

  it("reads as paused, in amber, naming the plan", () => {
    const presence = presenceOf({ activity: idle, working: false, pausedUntil: undefined, planMissing: true, now })
    assert.strictEqual(presence._tag, "NoPlan")
    assert.strictEqual(dotOf(presence), "paused")
    assert.deepStrictEqual(homeLine(presence, { ...context, headline: undefined }), {
      lead: "Paused",
      rest: "ChatGPT isn’t connected",
      strong: false,
      need: true
    })
    assert.deepStrictEqual(headerLine(presence, { ...context, messages: [] }), {
      lead: "Paused",
      rest: "needs ChatGPT",
      strong: false,
      need: true
    })
    assert.isUndefined(chatRowOf(presence, [], now))
  })

  it("still shows a turn that's running", () => {
    const working = { state: "working", since: day("06") } as const
    const presence = presenceOf({ activity: working, working: true, pausedUntil: undefined, planMissing: true, now })
    assert.strictEqual(presence._tag, "Working")
  })
})
