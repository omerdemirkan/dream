/**
 * UPDATES_PUBLISH_SECRET: what the Worker's over-the-air update routes (publish, rollback, status, signing key)
 * require in `x-dream-updates-secret`. Kept like DEV_LOGIN_SECRET (see ops.ts): a Worker secret, and a copy in
 * D1 `dream-ops` that `apps/mobile/scripts/updates.ts` reads through the operator's Cloudflare credentials. Project
 * sandboxes never get it, and it isn't DEV_LOGIN_SECRET, which QA runs hand around.
 *
 *   node infra/scripts/updates-secret.ts ensure   # once, after the deploy that adds the update routes (idempotent)
 */
import { NodeRuntime } from "@effect/platform-node"
import { Console } from "effect"
import { ensureOpsSecret } from "./ops.ts"

const program =
  process.argv[2] === "ensure"
    ? ensureOpsSecret("UPDATES_PUBLISH_SECRET")
    : Console.error("Usage: node infra/scripts/updates-secret.ts ensure")

program.pipe(NodeRuntime.runMain)
