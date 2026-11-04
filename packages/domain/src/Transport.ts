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
  socket: "DREAM_SOCKET"
} as const

export const DefaultDaemonPort = 4747
export const DefaultDaemonSocket = "/tmp/dreamd.sock"

export const DaemonConfig = Config.all({
  apiUrl: Config.NonEmptyString(DaemonEnv.apiUrl),
  projectId: Config.schema(ProjectId, DaemonEnv.projectId),
  projectToken: Config.Redacted(DaemonEnv.projectToken),
  daemonToken: Config.Redacted(DaemonEnv.daemonToken),
  harness: Config.schema(Harness, DaemonEnv.harness),
  port: Config.Port(DaemonEnv.port).pipe(Config.withDefault(DefaultDaemonPort)),
  socket: Config.NonEmptyString(DaemonEnv.socket).pipe(Config.withDefault(DefaultDaemonSocket))
})
