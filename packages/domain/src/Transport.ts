/**
 * Where each RPC group is served, how it is serialized, and how dreamd is
 * configured. Both ends import these so paths and env names can't drift.
 *
 * | Group             | Client → Server       | Transport                              |
 * | ----------------- | --------------------- | -------------------------------------- |
 * | `AppRpcs`         | phone → Worker        | HTTP POST `api.<domain>/rpc`           |
 * | `ProjectLiveRpcs` | phone → ProjectDO     | WebSocket `api.<domain>/projects/:id/live?ticket=…` |
 * | `SandboxRpcs`     | dreamd → Worker       | HTTP POST `api.<domain>/sandbox/rpc`   |
 * | `SandboxRpcs`     | `dream` CLI → dreamd  | HTTP over the Unix socket `DREAM_SOCKET` |
 * | `DaemonRpcs`      | ProjectDO → dreamd    | HTTP POST `<port>-<sandbox>.e2b.app/daemon/rpc` + `e2b-traffic-access-token` |
 */
import { Config } from "effect"
import { RpcSerialization } from "effect/rpc"
import type { ConnectLinkProvider } from "./Connections.ts"
import { type MediaId, ProjectId } from "./Ids.ts"
import { Harness } from "./Project.ts"

export const Routes = {
  app: "/rpc",
  sandbox: "/sandbox/rpc",
  /** Authenticated by the short-lived `ticket` query parameter from `AppRpcs.GetLiveUrl`, not a header. */
  projectLive: (projectId: ProjectId) => `/projects/${projectId}/live`,
  /** GET with the session token; serves the bytes of a `MediaRef`. */
  media: (mediaId: MediaId) => `/media/${mediaId}`,
  /** PUT an attachment's bytes, with the upload token `AppRpcs.CreateAttachmentUpload` put in the URL. */
  attachmentUpload: (mediaId: MediaId) => `/attachments/${mediaId}/upload`,
  /** GET with the project token (dreamd): the bytes of an attachment sent to that project. */
  sandboxAttachment: (mediaId: MediaId) => `/sandbox/attachments/${mediaId}`,
  googleOAuthCallback: "/oauth/google/callback",
  /** Where every other OAuth provider (`AccessRequest.OAuth`) redirects back to, e.g. `/oauth/spotify/callback`. */
  oauthCallback: (provider: string) => `/oauth/${provider}/callback`,
  /** GET serves the token page for a `CreateConnectLink` URL (`?t=<ticket>`); POST submits it. */
  connect: (provider: ConnectLinkProvider) => `/connect/${provider}`,
  /**
   * The page an `EmailAccessLink` email opens on a computer. The link's token rides in the URL fragment, which
   * browsers never send, and the page posts it to `desktopOpen` when they continue.
   */
  desktop: "/desktop",
  /** POST the emailed token: uses it up and starts this browser's session for that one request. */
  desktopOpen: "/desktop/open",
  /** GET the request's form in the browser that opened the link; POST submits it. */
  desktopAccess: (linkId: string) => `/desktop/${linkId}`,
  /** POST from the form of a Google or OAuth request: starts the sign-in in this browser. */
  desktopSignIn: (linkId: string) => `/desktop/${linkId}/sign-in`,
  daemon: "/daemon/rpc",
  /** POST a `TestflightKeyRequest` from a Namespace build Mac; see Testflight.ts. */
  testflightKey: "/testflight/asc-key",
  /** POST a `TestflightIdentityUpload` from the build Mac that was just released the key. */
  testflightIdentity: "/testflight/signing-identity",
  /** POST a `TestflightGrantRequest` with the operator's `x-dream-dev-secret`. */
  testflightGrant: "/admin/testflight/grants",
  /** GET with the operator's `x-dream-dev-secret`: `TestflightBuilds`, read by the Worker itself. */
  testflightBuilds: "/admin/testflight/builds",
  /** GET: the Expo Updates protocol (v1) manifest endpoint, the app's `updates.url`. */
  updatesManifest: "/updates/manifest",
  /** GET an update asset by its `AssetHash` (public and immutable, like the bundle inside the app). */
  updatesAsset: (hash: string) => `/updates/assets/${hash}`,
  /** GET the signing certificate (`UpdatesCertificate`, `created` false). */
  updatesCertificate: "/updates/certificate",
  /** The operator's update routes, behind `UpdatesSecretHeader`. HEAD / PUT an asset's bytes. */
  updatesUpload: (hash: string) => `/admin/updates/assets/${hash}`,
  /** POST a `PublishUpdateRequest`; responds with the new `UpdateRelease`. */
  updatesPublish: "/admin/updates/publish",
  /** POST a `RollbackUpdateRequest`; responds with the new `UpdateRelease`. */
  updatesRollback: "/admin/updates/rollback",
  /** GET `?channel=…`: `UpdatesStatus`. */
  updatesStatus: "/admin/updates/status",
  /** POST: creates the signing key if there's none; responds with `UpdatesCertificate`. */
  updatesSigningKey: "/admin/updates/signing-key"
} as const

/** HTTP RPC endpoints use NDJSON, which also carries streaming responses. */
export const HttpRpcSerialization = RpcSerialization.layerNdjson

/** WebSocket RPC uses JSON, one message per frame (what alchemy's RpcDurableObject speaks). */
export const SocketRpcSerialization = RpcSerialization.layerJson

/**
 * Environment the ProjectDO sets when it creates a sandbox, read by dreamd.
 *
 * dreamd serves only `DaemonRpcs` on `DREAM_DAEMON_PORT`. Sandboxes are created
 * with E2B `network` rules, so their port URLs need the
 * `e2b-traffic-access-token` header, which only the Worker holds; processes in
 * the sandbox can still reach the port on localhost, hence `DaemonAuth`.
 * The CLI talks to dreamd over the `DREAM_SOCKET` Unix socket, which keeps it
 * off the network and out of the ports the agent's apps use.
 */
export const DaemonEnv = {
  apiUrl: "DREAM_API_URL",
  projectId: "DREAM_PROJECT_ID",
  projectToken: "DREAM_PROJECT_TOKEN",
  daemonToken: "DREAM_DAEMON_TOKEN",
  harness: "DREAM_HARNESS",
  port: "DREAM_DAEMON_PORT",
  socket: "DREAM_SOCKET",
  /**
   * Optional: the model the top-level agent runs on instead of the fleet's flagship (an operator override, e.g. a
   * cheap model for QA): a name the project's harness accepts.
   */
  model: "DREAM_MODEL",
  /** Optional: the top-level agent's `ReasoningEffort` instead of the fleet's ("high"). */
  effort: "DREAM_EFFORT",
  /**
   * Optional: what the ProjectDO calls this file's settings (a hash). dreamd reports it back in `Health`, so the
   * DO knows the dreamd answering is the one that read this file.
   */
  envHash: "DREAM_ENV_HASH",
  /**
   * Optional: dreamd reports what a turn is doing (`TurnProgress`) while someone watches. "on": a small model writes
   * the line through the project's harness CLI, with the model-free line as its fallback; "model-free": only that.
   * Off unless set.
   */
  progressLine: "DREAM_PROGRESS_LINE",
  /**
   * Optional: Dream's OpenAI gateway (`OpenAIGateway`), e.g. `https://openai.<domain>/v1`, set while the gateway is
   * on. dreamd then gives the agent's shell and the apps it starts `OPENAI_BASE_URL` (this) and `OPENAI_API_KEY`
   * (`OpenAIGateway.placeholderKey`), never the harness's own process. Added November 2026.
   */
  openaiBaseUrl: "DREAM_OPENAI_BASE_URL"
} as const

export const DefaultDaemonPort = 4747
export const DefaultDaemonSocket = "/tmp/dreamd.sock"

/**
 * Where the ProjectDO writes dreamd's environment, as `KEY=value` lines with
 * the `DaemonEnv` names. The sandbox template's start command supervises
 * dreamd, which waits for this file, reads it over its own environment, and
 * restarts when it changes. Writing it again (on create or after rotating a
 * token) is safe.
 */
export const DaemonEnvFile = "/home/user/.dream/dreamd.env"

export const DaemonConfig = Config.all({
  apiUrl: Config.NonEmptyString(DaemonEnv.apiUrl),
  projectId: Config.schema(ProjectId, DaemonEnv.projectId),
  projectToken: Config.Redacted(DaemonEnv.projectToken),
  daemonToken: Config.Redacted(DaemonEnv.daemonToken),
  harness: Config.schema(Harness, DaemonEnv.harness),
  port: Config.Port(DaemonEnv.port).pipe(Config.withDefault(DefaultDaemonPort)),
  socket: Config.NonEmptyString(DaemonEnv.socket).pipe(Config.withDefault(DefaultDaemonSocket))
})

/**
 * The sandbox only ever holds placeholder model credentials. The ProjectDO
 * adds the real one with an E2B `network.rules` entry for `host`, whose
 * transform sets `headers(credential)`. dreamd configures each harness so all
 * of its model traffic goes to that host with an `Authorization` header to
 * replace, and so nothing in the sandbox holds a refresh token.
 *
 * - Claude Code authenticates with `CLAUDE_CODE_OAUTH_TOKEN` (the long-lived
 *   token from `claude setup-token`) and sends it as a bearer token to
 *   api.anthropic.com, including its usage endpoint.
 * - Codex runs against the ChatGPT backend (`https://chatgpt.com/backend-api/codex`)
 *   as an API-key provider: a bearer access token plus the account header.
 *   Dream refreshes the access token centrally and updates the rule.
 */
export const ModelEgress = {
  "claude-code": {
    host: "api.anthropic.com",
    headers: (credential: { readonly oauthToken: string }): Record<string, string> => ({
      Authorization: `Bearer ${credential.oauthToken}`
    })
  },
  codex: {
    host: "chatgpt.com",
    headers: (credential: { readonly accessToken: string; readonly accountId: string }): Record<string, string> => ({
      Authorization: `Bearer ${credential.accessToken}`,
      "ChatGPT-Account-ID": credential.accountId
    })
  }
} as const satisfies Record<
  Harness,
  { readonly host: string; readonly headers: (credential: never) => Record<string, string> }
>

/**
 * Dream's OpenAI gateway: the apps the agent builds call OpenAI's API at `https://openai.<domain>/v1`, with the same
 * paths as `https://api.openai.com/v1`. The sandbox holds only `placeholderKey`; an E2B egress rule for the
 * gateway's host replaces the `Authorization` header with the project's gateway credential (`headers`). The gateway
 * checks it, calls OpenAI with the person's own OpenAI key if they connected one for api.openai.com, or Dream's
 * otherwise, and meters what comes back. The harnesses never use it: they run on the person's subscription.
 * Added November 2026.
 */
export const OpenAIGateway = {
  host: (domain: string) => `openai.${domain}`,
  baseUrl: (domain: string) => `https://openai.${domain}/v1`,
  /** What apps send as their API key: any value works, since egress replaces the header. */
  placeholderKey: "dream-openai-placeholder",
  headers: (credential: { readonly token: string }): Record<string, string> => ({
    Authorization: `Bearer ${credential.token}`
  })
} as const
