/**
 * Moving a project to another plan, added November 2026. TestFlight build 26858598 knows nothing of it: it must
 * still decode a project that carries a `planSwitch`.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import {
  AgentEvent,
  agentChoiceOn,
  equivalentModel,
  EventId,
  planHandoffPath,
  Project,
  renderAgentEvent,
  WakeId
} from "../src/index.ts"
import * as Fixtures from "../src/fixtures.ts"

const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema))(value)
const wire = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: S["Type"]): unknown =>
  JSON.parse(JSON.stringify(Schema.encodeSync(Schema.toCodecJson(schema))(value)))

const at = DateTime.makeUnsafe("2026-11-10T15:04:05Z")
const OldProject = Project.mapFields(({ planSwitch: _, ...rest }) => rest)

describe("the model on the other plan", () => {
  it("stands where the old one stood, by rank, either way, as a family", () => {
    assert.strictEqual(equivalentModel("claude-code", "codex", "fable"), "astra")
    assert.strictEqual(equivalentModel("claude-code", "codex", "opus"), "sol")
    assert.strictEqual(equivalentModel("claude-code", "codex", "sonnet"), "terra")
    assert.strictEqual(equivalentModel("claude-code", "codex", "haiku"), "luna")
    assert.strictEqual(equivalentModel("codex", "claude-code", "astra"), "fable")
    assert.strictEqual(equivalentModel("codex", "claude-code", "luna"), "haiku")
  })

  it("reads a model saved before families as its family", () => {
    assert.strictEqual(equivalentModel("codex", "claude-code", "gpt-6-astra"), "fable")
    assert.strictEqual(equivalentModel("codex", "claude-code", "gpt-6-luna"), "haiku")
    assert.strictEqual(equivalentModel("codex", "claude-code", "gpt-6.1-terra"), "sonnet")
  })

  it("keeps a family the new plan offers, and gives any other name its lightest", () => {
    assert.strictEqual(equivalentModel("claude-code", "codex", "sol"), "sol")
    assert.strictEqual(equivalentModel("claude-code", "codex", "gpt-6.1-sol"), "sol")
    assert.strictEqual(equivalentModel("codex", "claude-code", "gpt-5.5"), "haiku")
    assert.strictEqual(equivalentModel("claude-code", "codex", "claude-3-7-sonnet-latest"), "luna")
  })

  it("moves the project's choice over, and leaves Dream's default as the default", () => {
    assert.deepStrictEqual(agentChoiceOn({ harness: "claude-code" }, "codex"), {})
    assert.deepStrictEqual(
      agentChoiceOn({ harness: "claude-code", agentModel: "sonnet", agentEffort: "low" }, "codex"),
      {
        agentModel: "terra",
        agentEffort: "low"
      }
    )
    assert.deepStrictEqual(agentChoiceOn({ harness: "codex", agentEffort: "max" }, "claude-code"), {
      agentEffort: "max"
    })
    // The founder's project on Luna, saved before families, moves to Haiku.
    assert.deepStrictEqual(agentChoiceOn({ harness: "codex", agentModel: "gpt-6-luna" }, "claude-code"), {
      agentModel: "haiku"
    })
    // Opus stands where Sol does, which is Codex's default.
    assert.deepStrictEqual(agentChoiceOn({ harness: "claude-code", agentModel: "opus" }, "codex"), {})
  })
})

describe("the project's planSwitch", () => {
  it("is ignored by apps that don't know it, and absent from projects that never moved", () => {
    const project: Project = {
      ...Fixtures.liftLog,
      harness: "codex",
      planSwitch: { from: "claude", to: "chatgpt", state: "done", requestedAt: at, endedAt: at }
    }
    const old = decode(OldProject, wire(Project, project))
    assert.notProperty(old, "planSwitch")
    assert.strictEqual(old.harness, "codex")
    assert.notProperty(decode(Project, wire(OldProject, Fixtures.liftLog)), "planSwitch")
  })
})

describe("what the agents are told", () => {
  const ids = { id: EventId.make("evt_1"), at }

  it("asks the outgoing agent for a handoff at a path of its own", () => {
    const handoff = planHandoffPath(at, "codex")
    assert.strictEqual(handoff, "/home/user/.dream/handoffs/2026-11-10T15-04-05-to-codex.md")
    const text = renderAgentEvent(
      AgentEvent.cases.PlanSwitching.make({ ...ids, from: "claude-code", to: "codex", handoff })
    )
    assert.include(text, "their ChatGPT plan")
    assert.include(text, "an agent on Codex takes over")
    assert.include(text, handoff)
  })

  it("tells the new agent what it needs to pick up, and only what's there", () => {
    const full = renderAgentEvent(
      AgentEvent.cases.PlanSwitched.make({
        ...ids,
        from: "codex",
        to: "claude-code",
        outcome: "moved",
        handoff: "/home/user/.dream/handoffs/x.md",
        model: "haiku",
        modelBefore: "luna",
        tasks: [{ wakeId: WakeId.make("wak_1"), why: "Weekly digest", from: "gpt-6-luna", to: "sonnet" }],
        chat: [{ from: "user", text: "Also track sleep", at }]
      })
    )
    assert.include(full, "from their ChatGPT plan to their Claude plan")
    assert.include(full, "on Claude Code, taking over from the agent that ran it on Codex")
    assert.include(full, "It wrote you a handoff, /home/user/.dream/handoffs/x.md: read it before anything else")
    assert.include(full, "You run on the newest Haiku (`haiku`), which stands in for the newest Luna (`luna`)")
    assert.include(full, '- wak_1 ("Weekly digest"): gpt-6-luna → sonnet')
    assert.include(full, "They wrote:\n> Also track sleep")
    assert.notInclude(full, "undefined")
    const bare = renderAgentEvent(
      AgentEvent.cases.PlanSwitched.make({ ...ids, from: "claude-code", to: "codex", outcome: "moved" })
    )
    assert.include(bare, "didn't get to write you a handoff")
    assert.notInclude(bare, "scheduled tasks")
    assert.notInclude(bare, "latest of Chat")
  })

  it("tells the agent that stays how the move ended", () => {
    const failed = renderAgentEvent(
      AgentEvent.cases.PlanSwitched.make({
        ...ids,
        from: "claude-code",
        to: "codex",
        outcome: "failed",
        reason: "their ChatGPT plan isn't connected"
      })
    )
    assert.include(failed, "couldn't move this project from their Claude plan to their ChatGPT plan")
    assert.include(failed, "(their ChatGPT plan isn't connected), so you stay its agent")
    const cancelled = renderAgentEvent(
      AgentEvent.cases.PlanSwitched.make({ ...ids, from: "claude-code", to: "codex", outcome: "cancelled" })
    )
    assert.include(cancelled, "keep this project on their Claude plan")
  })
})
