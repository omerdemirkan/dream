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
  googleOAuthCallback: "/oauth/google/callback",
  /** Where every other OAuth provider (`AccessRequest.OAuth`) redirects back to, e.g. `/oauth/spotify/callback`. */
  oauthCallback: (provider: string) => `/oauth/${provider}/callback`,
  /** GET serves the token page for a `CreateConnectLink` URL (`?t=<ticket>`); POST submits it. */
  connect: (provider: ConnectLinkProvider) => `/connect/${provider}`,
  daemon: "/daemon/rpc"
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
  envHash: "DREAM_ENV_HASH"
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
