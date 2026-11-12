/**
 * The project's agent model and effort, added November 2026. TestFlight build 26858598 knows neither: it must still
 * decode a project that carries them, and what it sends to create a project (a plan, no model) must still be valid.
 */
import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { Rpc } from "effect/rpc"
import {
  AgentModels,
  agentChoice,
  agentOf,
  AppRpcs,
  DefaultAgent,
  familyOf,
  type Harness,
  modelName,
  offersModel,
  Project,
  ReasoningEffort,
  ReasoningEfforts
} from "../src/index.ts"
import * as Fixtures from "../src/fixtures.ts"

const wire = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: S["Type"]): unknown =>
  JSON.parse(JSON.stringify(Schema.encodeSync(Schema.toCodecJson(schema))(value)))
const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema))(value)

const OldProject = Project.mapFields(({ agentModel: _m, agentEffort: _e, ...rest }) => rest)
const createPayload = (AppRpcs.requests.get("CreateProject") as Rpc.Any & { payloadSchema: Schema.Top })
  .payloadSchema as Schema.Codec<unknown, unknown, never, never>
const setAgentPayload = (AppRpcs.requests.get("SetAgentModel") as Rpc.Any & { payloadSchema: Schema.Top })
  .payloadSchema as Schema.Codec<unknown, unknown, never, never>

const harnesses: ReadonlyArray<Harness> = ["claude-code", "codex"]

describe("the agent's model", () => {
  it("offers each harness's default, and every effort the domain knows", () => {
    for (const harness of harnesses) assert.isTrue(offersModel(harness, DefaultAgent[harness].model))
    assert.deepStrictEqual([...ReasoningEfforts], [...ReasoningEffort.literals])
    assert.isFalse(offersModel("codex", "opus"))
    assert.isFalse(offersModel("claude-code", "gpt-6.1-sol"))
    // gpt-5.5 has no multi-agent tools: a project on it couldn't start subagents.
    assert.isFalse(offersModel("codex", "gpt-5.5"))
    for (const harness of harnesses) {
      const ids = AgentModels[harness].map((m) => m.id)
      assert.strictEqual(new Set(ids).size, ids.length)
    }
  })

  it("offers families, not versions", () => {
    assert.deepStrictEqual(
      AgentModels["claude-code"].map((m) => m.name),
      ["Fable", "Opus", "Sonnet", "Haiku"]
    )
    assert.deepStrictEqual(
      AgentModels.codex.map((m) => m.id),
      ["astra", "sol", "terra", "luna"]
    )
    for (const harness of harnesses) {
      for (const option of AgentModels[harness]) assert.notMatch(option.name, /\d/)
    }
  })

  it("reads a Codex slug, as builds and projects from before families name one, as its family", () => {
    assert.strictEqual(familyOf("codex", "gpt-6.1-sol"), "sol")
    assert.strictEqual(familyOf("codex", "gpt-6-luna"), "luna")
    assert.strictEqual(familyOf("codex", "gpt-6.1-terra"), "terra")
    assert.strictEqual(familyOf("codex", "gpt-6-astra"), "astra")
    assert.strictEqual(familyOf("codex", "sol"), "sol")
    assert.strictEqual(familyOf("claude-code", "fable"), "fable")
    // A Claude id pins a model; only its alias follows the family.
    assert.isUndefined(familyOf("claude-code", "claude-fable-5-1"))
    assert.isUndefined(familyOf("codex", "gpt-5.5"))
    assert.isUndefined(familyOf("codex", "gpt-daybreak-blue-latest"))
    assert.isUndefined(familyOf("codex", "codex-auto-review"))
    assert.isUndefined(familyOf("claude-code", "sol"))
    // What TestFlight build 26858598 sends.
    assert.isTrue(offersModel("codex", "gpt-6.1-sol"))
    assert.strictEqual(modelName("codex", "gpt-6-luna"), "Luna")
    assert.strictEqual(modelName("codex", "gpt-5.5"), "gpt-5.5")
  })

  it("resolves a project's choice over Dream's default, and keeps only what differs from it", () => {
    const project = Fixtures.liftLog
    assert.deepStrictEqual(agentOf({ harness: "claude-code" }), { model: "opus", effort: "high" })
    assert.deepStrictEqual(agentOf({ ...project, harness: "codex", agentEffort: "max" }), {
      model: "sol",
      effort: "max"
    })
    // The founder's Arabic project, saved on a slug, runs on its family.
    assert.strictEqual(agentOf({ harness: "codex", agentModel: "gpt-6-luna" }).model, "luna")
    assert.deepStrictEqual(agentChoice("codex", { model: "gpt-6-luna" }), { agentModel: "luna" })
    assert.deepStrictEqual(agentChoice("codex", { model: "gpt-6.1-sol" }), {})
    assert.deepStrictEqual(agentChoice("claude-code", { model: "opus", effort: "high" }), {})
    assert.deepStrictEqual(agentChoice("claude-code", { model: "sonnet", effort: "high" }), { agentModel: "sonnet" })
    assert.deepStrictEqual(agentChoice("codex", { effort: "low" }), { agentEffort: "low" })
  })

  it("leaves projects decodable by builds from before it", () => {
    const project: Project = { ...Fixtures.liftLog, agentModel: "sonnet", agentEffort: "medium" }
    const encoded = wire(Project, project)
    assert.deepStrictEqual(decode(Project, encoded), project)
    const old = decode(OldProject, encoded) as Record<string, unknown>
    assert.notProperty(old, "agentModel")
    assert.strictEqual(old.title, project.title)
  })

  it("takes what older builds send to create a project, and the new settings", () => {
    assert.deepStrictEqual(decode(createPayload, { idea: "A recipe scaler", harness: "codex" }), {
      idea: "A recipe scaler",
      harness: "codex"
    })
    const full = {
      idea: "A recipe scaler",
      harness: "claude-code",
      model: "sonnet",
      effort: "xhigh",
      limits: { projectWeekPercent: 20, planLeftPercent: 10 }
    }
    assert.deepStrictEqual(decode(createPayload, full), full)
    assert.throws(() => decode(createPayload, { idea: "x", effort: "ultra" }))
    assert.throws(() => decode(createPayload, { idea: "x", limits: { planLeftPercent: 0 } }))
    assert.deepStrictEqual(decode(setAgentPayload, { projectId: "prj_1" }), { projectId: "prj_1" })
  })
})
