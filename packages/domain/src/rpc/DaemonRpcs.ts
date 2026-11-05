/**
 * ProjectDO → dreamd, on the sandbox's port URL (`Routes.daemon`), with the
 * sandbox's `e2b-traffic-access-token` header. The request itself wakes a
 * paused sandbox (E2B auto-resume).
 */
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { AgentEvent } from "../AgentEvent.ts"
import { DaemonAuth } from "../Auth.ts"
import { DaemonRestarting } from "../Errors.ts"
import { EventId } from "../Ids.ts"
import { TimeZone } from "../User.ts"

export const TurnState = Schema.Literals(["idle", "running"])
export type TurnState = typeof TurnState.Type

export class DaemonRpcs extends RpcGroup.make(
  /**
   * Hand events to dreamd. It persists them before replying, so the DO can
   * mark exactly the `accepted` ids delivered and redeliver the rest later.
   * Duplicate ids are accepted and ignored.
   *
   * `timeZone` is their current time zone; turn prompts show times in it.
   * dreamd keeps the last one it was given.
   *
   * Once dreamd is restarting it refuses with `DaemonRestarting`; nothing was
   * taken, so the DO delivers again after the restart.
   */
  Rpc.make("Deliver", {
    payload: { events: Schema.NonEmptyArray(AgentEvent), timeZone: Schema.optionalKey(TimeZone) },
    success: Schema.Struct({ accepted: Schema.Array(EventId) }),
    error: DaemonRestarting
  }),
  Rpc.make("Health", {
    success: Schema.Struct({
      version: Schema.String,
      turn: TurnState,
      /** Events received but not yet given to a turn. */
      queued: Schema.Int,
      /**
       * The `DaemonEnv.envHash` from the env file this dreamd read at start, so the DO can tell that a restart
       * it caused by rewriting the file has happened. Absent from dreamd builds older than it.
       */
      envHash: Schema.optionalKey(Schema.String)
    })
  })
).middleware(DaemonAuth) {}
