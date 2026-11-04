/**
 * What a person has connected once and every one of their projects can use:
 * their model subscription, and integrations with other services.
 * Secrets never appear here: they are stored AES-GCM encrypted in D1, are
 * decrypted only inside the Worker, and reach outbound requests through E2B
 * egress rules. These are the public records.
 */
import { Schema } from "effect"
import { IntegrationId, ModelConnectionId } from "./Ids.ts"
import { ModelProvider, UsageSnapshot } from "./Usage.ts"

// ---------------------------------------------------------------------------
// Model connections (Claude or ChatGPT subscription)
// ---------------------------------------------------------------------------

export const ModelConnectionStatus = Schema.Literals(["pending", "connected", "expired", "failed"])
export type ModelConnectionStatus = typeof ModelConnectionStatus.Type

export const ModelConnection = Schema.Struct({
  id: ModelConnectionId,
  provider: ModelProvider,
  status: ModelConnectionStatus,
  connectedAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** The most recent usage report from any of their sandboxes. */
  usage: Schema.optionalKey(UsageSnapshot)
})
export type ModelConnection = typeof ModelConnection.Type

/**
 * What the phone shows while a connection is pending.
 * - `PasteCode`: Claude. Open `authorizeUrl`, tap Authorize, paste the code back
 *   with `CompleteModelConnection`.
 * - `DeviceCode`: ChatGPT. Show `userCode`, open `verificationUrl`, then poll
 *   `GetModelConnection` until it is connected.
 */
export const ModelConnectFlow = Schema.TaggedUnion({
  PasteCode: { authorizeUrl: Schema.String },
  DeviceCode: {
    verificationUrl: Schema.String,
    userCode: Schema.String,
    expiresAt: Schema.DateTimeUtc
  }
})
export type ModelConnectFlow = typeof ModelConnectFlow.Type

// ---------------------------------------------------------------------------
// Integrations (Google, pasted API keys, App Store Connect)
// ---------------------------------------------------------------------------

/**
 * How the agent uses a connected integration. Dream's egress rules add the real
 * credential to HTTPS requests for `hosts`; the agent's code sends `placeholder`
 * wherever a library insists on having a credential configured.
 */
export const IntegrationAccess = Schema.TaggedUnion({
  Google: {
    email: Schema.optionalKey(Schema.String),
    /** Short scope names as requested, e.g. "gmail.readonly". */
    scopes: Schema.Array(Schema.String),
    hosts: Schema.Array(Schema.String),
    placeholder: Schema.String
  },
  Key: {
    service: Schema.String,
    host: Schema.String,
    header: Schema.String,
    /** How the key is written into the header, e.g. "Bearer {key}". */
    format: Schema.String,
    placeholder: Schema.String
  },
  Apple: {
    /** App Store Connect API key identifiers. The .p8 private key stays encrypted with Dream. */
    issuerId: Schema.String,
    keyId: Schema.String
  }
})
export type IntegrationAccess = typeof IntegrationAccess.Type

export const IntegrationStatus = Schema.Literals(["connected", "revoked", "failed"])
export type IntegrationStatus = typeof IntegrationStatus.Type

export const Integration = Schema.Struct({
  id: IntegrationId,
  /** Display name, e.g. "Gmail", "Stripe", "Apple Developer". */
  label: Schema.String,
  status: IntegrationStatus,
  access: IntegrationAccess,
  connectedAt: Schema.DateTimeUtc
})
export type Integration = typeof Integration.Type
