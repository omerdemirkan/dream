/**
 * dreamd: the sandbox's event loop. It serves `DaemonRpcs` on
 * `DREAM_DAEMON_PORT` (the ProjectDO delivers events there), serves
 * `SandboxRpcs` to the CLI on the `DREAM_SOCKET` Unix socket and forwards those
 * calls to the API, and runs one harness turn at a time.
 *
 * Skeleton only: the sandbox-runtime workstream fills this in.
 */
import { DaemonConfig } from "@dream/domain"
import { Effect } from "effect"

export const main = Effect.gen(function* () {
  const config = yield* DaemonConfig
  yield* Effect.logInfo("dreamd is a skeleton", {
    projectId: config.projectId,
    harness: config.harness,
    port: config.port,
    socket: config.socket
  })
})
