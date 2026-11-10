/**
 * Moving a project to another plan: the quiet line under the agent in the usage sheet, and Chat's line where it
 * happened.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { chatPlanLine, planLine } from "../src/data/planSwitch.ts"

const now = DateTime.makeUnsafe("2026-11-10T12:00:00Z")
const earlier = DateTime.makeUnsafe("2026-11-10T11:00:00Z")

describe("the line under the agent", () => {
  it("says nothing to someone with one plan", () => {
    assert.isUndefined(planLine({ harness: "codex" }, ["chatgpt"], now))
    assert.isUndefined(planLine({ harness: "codex" }, [], now))
  })

  it("offers the other plan, asking first", () => {
    const line = planLine({ harness: "codex" }, ["claude", "chatgpt"], now)!
    assert.strictEqual(line.text, "Runs on your ChatGPT plan.")
    assert.strictEqual(line.action?.label, "Move to Claude")
    assert.strictEqual(line.action?.to, "claude")
    assert.strictEqual(line.action?.confirm?.title, "Move to your Claude plan?")
  })

  it("says a move is under way, and lets them stay, without asking", () => {
    const line = planLine(
      { harness: "codex", planSwitch: { from: "chatgpt", to: "claude", state: "waiting", requestedAt: earlier } },
      ["claude"],
      now
    )!
    assert.strictEqual(line.text, "Moving to your Claude plan once the agent has handed over.")
    assert.deepStrictEqual(line.action, { label: "Stay on ChatGPT", to: "chatgpt" })
  })

  it("mentions a move that didn't work for a day, then goes back to offering it", () => {
    const failed = {
      harness: "codex" as const,
      planSwitch: {
        from: "chatgpt" as const,
        to: "claude" as const,
        state: "failed" as const,
        requestedAt: earlier,
        endedAt: earlier
      }
    }
    assert.strictEqual(planLine(failed, ["claude", "chatgpt"], now)?.action?.label, "Try again")
    const later = DateTime.add(now, { days: 1 })
    assert.strictEqual(planLine(failed, ["claude", "chatgpt"], later)?.text, "Runs on your ChatGPT plan.")
  })

  it("after a move, offers the way back", () => {
    const moved = planLine(
      {
        harness: "claude-code",
        planSwitch: { from: "chatgpt", to: "claude", state: "done", requestedAt: earlier, endedAt: earlier }
      },
      ["claude", "chatgpt"],
      now
    )!
    assert.strictEqual(moved.text, "Runs on your Claude plan.")
    assert.strictEqual(moved.action?.label, "Move to ChatGPT")
  })
})

describe("Chat's line", () => {
  it("sits where the move happened, or at the end while it waits", () => {
    assert.isUndefined(chatPlanLine(undefined))
    assert.deepStrictEqual(chatPlanLine({ from: "chatgpt", to: "claude", state: "waiting", requestedAt: earlier }), {
      label: "Moving to your Claude plan"
    })
    assert.deepStrictEqual(
      chatPlanLine({ from: "claude", to: "chatgpt", state: "done", requestedAt: earlier, endedAt: now }),
      { label: "Moved to your ChatGPT plan", at: now }
    )
    assert.strictEqual(
      chatPlanLine({ from: "claude", to: "chatgpt", state: "failed", requestedAt: earlier, endedAt: now })?.label,
      "Couldn’t move to your ChatGPT plan"
    )
  })
})
