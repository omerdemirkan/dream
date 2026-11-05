/**
 * What a person has connected once and every one of their projects can use:
 * their model subscription, and integrations with other services.
 * Secrets never appear here: they are stored AES-GCM encrypted in D1, are
 * decrypted only inside the Worker, and reach outbound requests through E2B
 * egress rules, except a `File` key, which Dream writes into one project's
 * sandbox when they agree to it. These are the public records.
 */
import { Schema } from "effect"
import { IntegrationId, ModelConnectionId, ProjectId } from "./Ids.ts"
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

/** Providers that can be connected by pasting a token on a one-time web page (`CreateConnectLink`). */
export const ConnectLinkProvider = Schema.Literals(["claude"])
export type ConnectLinkProvider = typeof ConnectLinkProvider.Type

/**
 * A one-time link to a page on the API host where they paste a token (for Claude, the one `claude setup-token`
 * prints), so it goes from their browser to the Worker and never through a sandbox or a chat. Single use.
 */
export const ConnectLink = Schema.Struct({
  url: Schema.String,
  expiresAt: Schema.DateTimeUtc
})
export type ConnectLink = typeof ConnectLink.Type

// ---------------------------------------------------------------------------
// Integrations (Google, pasted API keys, keys in a sandbox file, App Store Connect, OAuth providers)
// ---------------------------------------------------------------------------

/**
 * Where Dream writes `File` keys in a project's sandbox: outside the project's repo (`~/project`), in a directory
 * of mode 0700 with each file 0600, owned by the sandbox's user. Every process in the sandbox runs as that user, so
 * the mode keeps out no code that runs there, only other users; being outside the repo keeps the files out of git.
 */
export const SandboxKeyDir = "/home/user/.dream/keys"

export const sandboxKeyPath = (name: string): string => `${SandboxKeyDir}/${name}`

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
  /**
   * A key Dream keeps as a file in one project's sandbox, for a service that can't take it in a header. Unlike the
   * other integrations it belongs to that project alone: Dream writes it into `projectId`'s sandbox (again whenever
   * the sandbox is recreated) and nowhere else, and deletes the file when they remove it.
   */
  File: {
    service: Schema.String,
    /** The file's name in `SandboxKeyDir`. */
    name: Schema.String,
    /** Its absolute path in the sandbox (`sandboxKeyPath(name)`). */
    path: Schema.String,
    projectId: ProjectId
  },
  Apple: {
    /** App Store Connect API key identifiers. The .p8 private key stays encrypted with Dream. */
    issuerId: Schema.String,
    keyId: Schema.String
  },
  /**
   * An OAuth sign-in with a provider other than Google (Spotify, GitHub, …). Dream holds the refresh token and
   * keeps the access token on `hosts` current, so the agent never refreshes anything.
   */
  OAuth: {
    /** The id Dream knows the provider by, e.g. "spotify". */
    provider: Schema.String,
    /** Display name, e.g. "Spotify". */
    service: Schema.String,
    /** Who they signed in as, when the provider says: a username, an email, or a workspace. */
    account: Schema.optionalKey(Schema.String),
    /** Scopes granted, in the provider's own names. */
    scopes: Schema.Array(Schema.String),
    hosts: Schema.Array(Schema.String),
    placeholder: Schema.String,
    /** What else the provider's API needs, in a sentence or two (a version header, a User-Agent, git over HTTPS). */
    notes: Schema.optionalKey(Schema.String)
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
