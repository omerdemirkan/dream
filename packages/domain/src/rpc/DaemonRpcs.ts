/**
 * ProjectDO → dreamd, on the sandbox's port URL (`Routes.daemon`), with the
 * sandbox's `e2b-traffic-access-token` header. The request itself wakes a
 * paused sandbox (E2B auto-resume).
 */
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { AgentEvent } from "../AgentEvent.ts"
import { DaemonAuth } from "../Auth.ts"
import { EventId } from "../Ids.ts"

export const TurnState = Schema.Literals(["idle", "running"])
export type TurnState = typeof TurnState.Type

export class DaemonRpcs extends RpcGroup.make(
  /**
   * Hand events to dreamd. It persists them before replying, so the DO can
   * mark exactly the `accepted` ids delivered and redeliver the rest later.
   * Duplicate ids are accepted and ignored.
   */
  Rpc.make("Deliver", {
    payload: { events: Schema.NonEmptyArray(AgentEvent) },
    success: Schema.Struct({ accepted: Schema.Array(EventId) })
  }),
  Rpc.make("Health", {
    success: Schema.Struct({
      version: Schema.String,
      turn: TurnState,
      /** Events received but not yet given to a turn. */
      queued: Schema.Int
    })
  })
).middleware(DaemonAuth) {}
