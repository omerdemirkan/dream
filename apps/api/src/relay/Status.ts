/** Small, pure helpers over a relay's runtime record: its state, its problems, and how it's named to the agent. */
import type { RelayState } from "@dream/domain"
import { DateTime } from "effect"
import type { RelayConfig, RelayStatus } from "./RelayRpcs.ts"
import { ProblemsKept, type RelayRuntime } from "./RelayStore.ts"

/** Records a problem, newest first. The same problem again only moves its time, so a flapping line doesn't flood. */
export const noteProblem = (runtime: RelayRuntime, at: DateTime.Utc, message: string): RelayRuntime => {
  const [newest, ...older] = runtime.problems
  const problems =
    newest !== undefined && newest.message === message
      ? [{ at, message }, ...older]
      : [{ at, message }, ...runtime.problems].slice(0, ProblemsKept)
  return { ...runtime, problems }
}

/** Moves to `state`, keeping `since` when it's already there. */
export const enterState = (runtime: RelayRuntime, state: RelayState, at: DateTime.Utc): RelayRuntime =>
  runtime.state === state && runtime.since !== undefined ? runtime : { ...runtime, state, since: at }

export const toStatus = (runtime: RelayRuntime, waiting: number): RelayStatus => ({
  state: runtime.state,
  ...(runtime.since === undefined ? {} : { since: runtime.since }),
  ...(runtime.account === undefined ? {} : { account: runtime.account }),
  waiting,
  delivered: runtime.delivered,
  dropped: runtime.dropped,
  ...(runtime.lastEventAt === undefined ? {} : { lastEventAt: runtime.lastEventAt }),
  ...(runtime.lastDeliveredAt === undefined ? {} : { lastDeliveredAt: runtime.lastDeliveredAt }),
  problems: runtime.problems
})

/** "Relay rly_… (Discord)", or with its label. */
export const describeRelay = (config: RelayConfig): string =>
  `Relay ${config.relayId}${config.label === undefined ? "" : ` "${config.label}"`} (${config.source._tag === "Discord" ? "Discord" : "WebSocket"})`
