/**
 * Machines the agent rents beyond its sandbox: a Browserbase Chrome and a
 * Namespace macOS host. Dream brokers both; the sandbox only sees short-lived
 * session details.
 */
import { Schema } from "effect"
import { BrowserSessionId } from "./Ids.ts"

export const BrowserSession = Schema.Struct({
  id: BrowserSessionId,
  /** Connect Playwright or Stagehand here. */
  cdpUrl: Schema.String,
  /** A URL a person can open to watch the session. */
  liveViewUrl: Schema.String,
  startedAt: Schema.DateTimeUtc
})
export type BrowserSession = typeof BrowserSession.Type

export const MacState = Schema.Literals(["starting", "running", "stopped"])
export type MacState = typeof MacState.Type

export const MacStatus = Schema.Struct({
  state: MacState,
  /** Stops itself after this long without an SSH session. */
  idleTimeoutMinutes: Schema.Int,
  startedAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type MacStatus = typeof MacStatus.Type

/** Short-lived SSH credentials for the running Mac. `dream mac ssh` writes the key to a temp file and execs ssh. */
export const MacSshAccess = Schema.Struct({
  host: Schema.String,
  port: Schema.Int,
  user: Schema.String,
  privateKey: Schema.RedactedFromValue(Schema.String),
  /** known_hosts line for the host, when the provider gives one. */
  hostKey: Schema.optionalKey(Schema.String),
  expiresAt: Schema.DateTimeUtc
})
export type MacSshAccess = typeof MacSshAccess.Type
