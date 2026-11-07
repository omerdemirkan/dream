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
import { EventId, RelayId } from "../Ids.ts"
import { RelayForward, RelayForwardResult, RelayPath, RelayPort } from "../Relay.ts"
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
  /**
   * POST a relay's events to the app at `http://localhost:<port><path>`, one at a time and in order, signed with the
   * sandbox's relay key (`RelayHeaders`). Stops at the first the app doesn't take with a 2xx; the rest go again
   * later. The request itself wakes the sandbox, and dreamd keeps it awake until the app has answered. Added after
   * the first release: an older dreamd fails it as an unknown request, and the relay tries again later.
   */
  Rpc.make("ForwardRelay", {
    payload: {
      relayId: RelayId,
      port: RelayPort,
      path: RelayPath,
      deliveries: Schema.NonEmptyArray(RelayForward)
    },
    success: RelayForwardResult,
    error: DaemonRestarting
  }),
  /**
   * Whether anyone is watching the project (a phone subscribed to its live feed), sent by the DO while a turn runs:
   * when the turn starts, when the first phone subscribes or the last one leaves, and again every few minutes while
   * one stays. dreamd reports a turn's progress only while someone watches, and stops if it hears nothing for a while.
   * Added after the first release: an older dreamd fails it as an unknown request, which the DO ignores.
   */
  Rpc.make("SetWatching", { payload: { watching: Schema.Boolean } }),
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
      envHash: Schema.optionalKey(Schema.String),
      /**
       * The template build's release this dreamd runs from (`/opt/dream/release.json`), so the DO can tell that a
       * sandbox refresh has put the new dreamd in place. Absent from older builds, and outside a template.
       */
      release: Schema.optionalKey(Schema.String)
    })
  })
).middleware(DaemonAuth) {}
