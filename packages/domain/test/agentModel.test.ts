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
  type Harness,
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

  it("resolves a project's choice over Dream's default, and keeps only what differs from it", () => {
    const project = Fixtures.liftLog
    assert.deepStrictEqual(agentOf({ harness: "claude-code" }), { model: "opus", effort: "high" })
    assert.deepStrictEqual(agentOf({ ...project, harness: "codex", agentEffort: "max" }), {
      model: "gpt-6.1-sol",
      effort: "max"
    })
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
