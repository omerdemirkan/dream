/**
 * One run of a relay's line: open it, keep its protocol alive, hand on what arrives, and say how it ended. `Line`
 * runs sessions one after another, backing off between them; each protocol (`Discord.ts`, `Feed.ts`) is a session.
 */
import { Data, type Duration, type Effect, type Option } from "effect"
import type { RelayCredential } from "../project/ProjectRpcs.ts"
import type { RelayConfig } from "./RelayRpcs.ts"
import type { DiscordSession } from "./RelayStore.ts"

/** An event to deliver, before it's wrapped in a `RelayDelivery`. */
export interface Received {
  /** Stable for the same event, so a replay after a resume isn't delivered twice. */
  readonly id: string
  readonly type?: string
  readonly data: unknown
  readonly binary?: boolean
}

export interface SessionContext {
  readonly config: RelayConfig
  /** The relay's key, when its source uses one. */
  readonly credential: Option.Option<RelayCredential>
  /** Queue an event for the app. */
  readonly emit: (event: Received) => Effect.Effect<void>
  /** The line is open (and logged in): `account` is who as, when the service says. */
  readonly connected: (account?: string) => Effect.Effect<void>
  /** A Discord session to resume, kept across restarts of the object. */
  readonly discord: {
    readonly get: Effect.Effect<Option.Option<DiscordSession>>
    readonly set: (session: Option.Option<DiscordSession>) => Effect.Effect<void>
  }
}

export type SessionEnd = Data.TaggedEnum<{
  /** Open the line again. `quiet` ends (a reconnect the service asked for) aren't recorded as problems. */
  Retry: { readonly reason: string; readonly quiet?: boolean; readonly wait?: Duration.Duration }
  /** Retrying won't help until something changes: the relay fails, and the agent hears why. */
  Fatal: { readonly reason: string }
}>
export const SessionEnd = Data.taggedEnum<SessionEnd>()
