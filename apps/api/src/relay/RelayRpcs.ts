/**
 * ProjectDO → RelayDO, over HTTP on the RelayDO's `fetch` at `RelayRpcPath`. Only the ProjectDO that owns a relay
 * calls it; nothing outside the Worker reaches a RelayDO. (The other direction, RelayDO → ProjectDO, is the `Relay*`
 * calls in `ProjectRpcs`.) These shapes are internal to the control plane, built from @dream/domain types.
 */
import { NotFound, ProjectId, RelayId, RelayProblem, RelaySource, RelayState, RelayTarget } from "@dream/domain"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export const RelayRpcPath = "/relay/rpc"

/** What a RelayDO is told to hold: the relay as the ProjectDO registered it, with its key resolved. */
export const RelayConfig = Schema.Struct({
  relayId: RelayId,
  projectId: ProjectId,
  source: RelaySource,
  target: RelayTarget,
  label: Schema.optionalKey(Schema.String),
  createdAt: Schema.DateTimeUtc
})
export type RelayConfig = typeof RelayConfig.Type

/** How a relay is doing: the part of `Relay` only its RelayDO knows. */
export const RelayStatus = Schema.Struct({
  state: RelayState,
  since: Schema.optionalKey(Schema.DateTimeUtc),
  account: Schema.optionalKey(Schema.String),
  waiting: Schema.Int,
  delivered: Schema.Int,
  dropped: Schema.Int,
  lastEventAt: Schema.optionalKey(Schema.DateTimeUtc),
  lastDeliveredAt: Schema.optionalKey(Schema.DateTimeUtc),
  problems: Schema.Array(RelayProblem)
})
export type RelayStatus = typeof RelayStatus.Type

export class RelayRpcs extends RpcGroup.make(
  /**
   * Hold this relay: store it and open the line, or, for one already held, take the new settings and open the line
   * afresh. A relay that had failed tries again.
   */
  Rpc.make("Start", { payload: { config: RelayConfig }, success: RelayStatus }),
  /** Close the line, drop what's waiting, and forget everything (the relay was removed, or its project held). */
  Rpc.make("Stop", {}),
  /** Open the line afresh, keeping what's waiting. */
  Rpc.make("Restart", { success: RelayStatus, error: NotFound }),
  Rpc.make("Status", { success: RelayStatus, error: NotFound })
) {}
