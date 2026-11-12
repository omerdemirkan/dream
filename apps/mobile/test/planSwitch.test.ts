/**
 * Moving a project to another plan: what the usage sheet says while a move waits or after one didn't work, the move
 * it offers, and Chat's line where it happened.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { chatPlanLine, moveAction, planNotice } from "../src/data/planSwitch.ts"

const now = DateTime.makeUnsafe("2026-11-10T12:00:00Z")
const earlier = DateTime.makeUnsafe("2026-11-10T11:00:00Z")

describe("the sheet's notice", () => {
  it("says nothing without a move under way or lately failed", () => {
    assert.isUndefined(planNotice({ harness: "codex" }, ["chatgpt"], now))
    assert.isUndefined(planNotice({ harness: "codex" }, ["claude", "chatgpt"], now))
  })

  it("offers a move to the other plan, asking first", () => {
    const action = moveAction("claude")
    assert.strictEqual(action.label, "Move to Claude")
    assert.strictEqual(action.to, "claude")
    assert.strictEqual(action.confirm?.title, "Move to your Claude plan?")
    assert.strictEqual(action.confirm?.button, "Move")
  })

  it("says a move is under way, and lets them stay, without asking", () => {
    const line = planNotice(
      { harness: "codex", planSwitch: { from: "chatgpt", to: "claude", state: "waiting", requestedAt: earlier } },
      ["claude"],
      now
    )!
    assert.strictEqual(line.text, "Moving to your Claude plan once the agent has handed over.")
    assert.deepStrictEqual(line.action, { label: "Stay on ChatGPT", to: "chatgpt" })
  })

  it("mentions a move that didn't work for a day, offering to try again while that plan is connected", () => {
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
    const line = planNotice(failed, ["claude", "chatgpt"], now)
    assert.strictEqual(line?.text, "The move to Claude didn’t work, so it stays on ChatGPT.")
    assert.strictEqual(line?.action?.label, "Try again")
    assert.strictEqual(line?.action?.confirm?.title, "Move to your Claude plan?")
    assert.isUndefined(planNotice(failed, ["chatgpt"], now)?.action)
    assert.isUndefined(planNotice(failed, ["claude", "chatgpt"], DateTime.add(now, { days: 1 })))
  })

  it("after a move that worked, says nothing", () => {
    const moved = {
      harness: "claude-code" as const,
      planSwitch: {
        from: "chatgpt" as const,
        to: "claude" as const,
        state: "done" as const,
        requestedAt: earlier,
        endedAt: earlier
      }
    }
    assert.isUndefined(planNotice(moved, ["claude", "chatgpt"], now))
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
