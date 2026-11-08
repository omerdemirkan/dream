/**
 * The new-idea screen's Advanced sheet: what it shows with one plan and with two, what of it goes with the idea
 * (nothing, when they leave it alone), and the project's agent in its usage sheet.
 */
import {
  type ModelConnection,
  type ModelConnectionId,
  type ProjectId,
  type ProjectSummary,
  RequestId
} from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Redacted } from "effect"
import { Reactivity } from "effect/reactivity"
import { Socket } from "effect/socket"
import { advancedView, agentLabel, createSettings, nothingPicked } from "../src/data/advanced.ts"
import { AppClient } from "../src/data/AppClient.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"

const day = (d: string) => DateTime.makeUnsafe(`2026-11-${d}T12:00:00Z`)
const connection = (provider: ModelConnection["provider"], connectedAt: DateTime.Utc): ModelConnection => ({
  id: `mcn_${provider}` as ModelConnectionId,
  provider,
  status: "connected",
  connectedAt
})
const claude = connection("claude", day("02"))
const chatgpt = connection("chatgpt", day("03"))
const onClaude: ProjectSummary = {
  project: { ...Fx.liftLog, id: "prj_r" as ProjectId, harness: "claude-code", createdAt: day("05") },
  openAsks: 0
}

describe("the Advanced sheet", () => {
  it("left alone, shows Dream's defaults and sends nothing extra", () => {
    const one = advancedView([chatgpt], [], nothingPicked)
    assert.deepStrictEqual(one.plans, [])
    assert.strictEqual(one.harness, "codex")
    assert.deepStrictEqual(
      one.models.map((m) => [m.id, m.chosen, m.isDefault]),
      [
        ["gpt-6-astra", false, false],
        ["gpt-6.1-sol", true, true],
        ["gpt-6-luna", false, false]
      ]
    )
    assert.strictEqual(one.effort, "high")
    assert.isFalse(one.changed)
    assert.deepStrictEqual(createSettings([chatgpt], [], nothingPicked), {})
    // With both plans, the plan their newest project runs on, sent as today's picker did.
    const two = advancedView([claude, chatgpt], [onClaude], nothingPicked)
    assert.deepStrictEqual(two.plans, ["claude", "chatgpt"])
    assert.strictEqual(two.provider, "claude")
    assert.isFalse(two.changed)
    assert.deepStrictEqual(createSettings([claude, chatgpt], [onClaude], nothingPicked), { harness: "claude-code" })
  })

  it("sends what they changed, and follows the plan with its models", () => {
    const picked = {
      model: "sonnet",
      effort: "medium" as const,
      limits: { projectWeekPercent: 20, planLeftPercent: 10 }
    }
    assert.isTrue(advancedView([claude], [], picked).changed)
    assert.deepStrictEqual(createSettings([claude], [], picked), {
      model: "sonnet",
      effort: "medium",
      limits: { projectWeekPercent: 20, planLeftPercent: 10 }
    })
    // Switching to ChatGPT drops a Claude model for ChatGPT's default; the effort carries over.
    const switched = { ...picked, provider: "chatgpt" as const }
    const view = advancedView([claude, chatgpt], [onClaude], switched)
    assert.strictEqual(view.models.find((m) => m.chosen)?.id, "gpt-6.1-sol")
    assert.deepStrictEqual(createSettings([claude, chatgpt], [onClaude], switched), {
      harness: "codex",
      effort: "medium",
      limits: { projectWeekPercent: 20, planLeftPercent: 10 }
    })
    // Choosing the default again is the same as not choosing.
    assert.deepStrictEqual(createSettings([claude], [], { model: "opus", effort: "high", limits: {} }), {})
    assert.isFalse(advancedView([claude], [], { model: "opus", effort: "high", limits: {} }).changed)
    // A plan that's gone falls back to the one connected.
    assert.strictEqual(advancedView([claude], [], { provider: "chatgpt", limits: {} }).provider, "claude")
  })

  it("names a project's agent", () => {
    assert.strictEqual(agentLabel({ harness: "claude-code" }), "Opus 5.5 · High effort")
    assert.strictEqual(
      agentLabel({ harness: "codex", agentModel: "gpt-6-luna", agentEffort: "xhigh" }),
      "GPT-6 Luna · Extra high effort"
    )
  })
})

const appLayer = makeAppLayer(
  { apiUrl: "https://dream.test", backend: "fixtures" },
  { storage: SecureStorage.layerMemory(), webSocket: Socket.layerWebSocketConstructorGlobal, fetch: globalThis.fetch }
).pipe(Layer.provideMerge(Reactivity.layer))

describe("the fixtures backend", () => {
  it.effect("starts a project on the chosen agent and limits, and changes its agent later", () =>
    Effect.gen(function* () {
      const app = yield* AppClient
      const session = yield* Session
      const result = yield* app.DevSignIn({ email: "ada@example.com", secret: Redacted.make("fixtures") })
      yield* session.signIn({ token: result.sessionToken, user: result.user })
      const project = yield* app.CreateProject({
        idea: "Scale any recipe up or down",
        requestId: RequestId.make("4c1f0a52-1b0e-4f6e-8b39-1d2c3e4f5a6b"),
        model: "gpt-6-luna",
        effort: "low",
        limits: { planLeftPercent: 10 }
      })
      assert.strictEqual(project.agentModel, "gpt-6-luna")
      assert.strictEqual(project.agentEffort, "low")
      assert.deepStrictEqual((yield* app.GetProjectUsage({ projectId: project.id })).limits, { planLeftPercent: 10 })
      const changed = yield* app.SetAgentModel({ projectId: project.id, model: "gpt-6.1-sol", effort: "max" })
      assert.notProperty(changed, "agentModel")
      assert.strictEqual(changed.agentEffort, "max")
      const refused = yield* Effect.flip(app.SetAgentModel({ projectId: project.id, model: "opus" }))
      assert.strictEqual(refused._tag, "InvalidRequest")
    }).pipe(Effect.provide(appLayer))
  )
})
