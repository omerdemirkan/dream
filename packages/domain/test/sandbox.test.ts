import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { devSandboxMetadata, type ListedSandbox, reapable } from "../src/Sandbox.ts"

const now = DateTime.makeUnsafe("2026-11-07T12:00:00Z")
const started = (minutesAgo: number, metadata: Record<string, string>, sandboxId = "sbx"): ListedSandbox => ({
  sandboxId,
  startedAt: DateTime.subtract(now, { minutes: minutesAgo }),
  metadata
})

describe("which sandboxes the reaper kills", () => {
  it("throwaway sandboxes over an hour old: unlabeled, a script's, or a refresh donor", () => {
    assert.isTrue(reapable(started(61, {}), now, new Set()))
    assert.isTrue(reapable(started(90, devSandboxMetadata("smoke")), now, new Set()))
    assert.isTrue(reapable(started(90, devSandboxMetadata("harness-check", "harness-check")), now, new Set()))
    assert.isTrue(
      reapable(started(61, { projectId: "prj_1", userId: "usr_1", purpose: "refresh-donor" }), now, new Set())
    )
    assert.isFalse(reapable(started(59, {}), now, new Set()))
  })

  it("never a project's sandbox, a sign-in's, a labeled one, or one a project records as its own", () => {
    assert.isFalse(reapable(started(600, { projectId: "prj_1", userId: "usr_1" }), now, new Set()))
    assert.isFalse(reapable(started(600, { userId: "usr_1", purpose: "model-connect" }), now, new Set()))
    assert.isFalse(reapable(started(600, { ...devSandboxMetadata("soak"), reaper: "skip" }), now, new Set()))
    // Even with its metadata lost, a sandbox some project points at stays.
    assert.isFalse(reapable(started(600, {}, "sbx_project"), now, new Set(["sbx_project"])))
  })
})
