/**
 * dreamd: the sandbox's event loop. It serves `DaemonRpcs` on
 * `DREAM_DAEMON_PORT` (the ProjectDO delivers events there), serves the
 * `dream` CLI on the `DREAM_SOCKET` Unix socket (forwarding to the API), runs
 * scheduled commands, and runs one harness turn at a time.
 *
 * It exits when its env file changes, so its supervisor restarts it with the
 * new configuration.
 */
import { NodeServices } from "@effect/platform-node"
import { Duration, Effect, FileSystem, Layer, Option, Schedule } from "effect"
import { Agent } from "./Agent.ts"
import { Api } from "./Api.ts"
import { Commands } from "./Commands.ts"
import { DreamdConfig } from "./Config.ts"
import { Harness } from "./harness/Harness.ts"
import { Inbox } from "./Inbox.ts"
import { DaemonServer, SocketServer } from "./Servers.ts"
import { version } from "./version.ts"

/** Completes when the env file's contents change. */
const configChanged = Effect.gen(function* () {
  const config = yield* DreamdConfig
  const fs = yield* FileSystem.FileSystem
  const read = fs.readFileString(config.envFile).pipe(Effect.option, Effect.map(Option.getOrUndefined))
  const initial = yield* read
  yield* read.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.seconds(5)),
      until: (current) => current !== undefined && current !== initial
    })
  )
  yield* Effect.logInfo(`${config.envFile} changed; restarting`)
})

export const main = Effect.gen(function* () {
  const config = yield* DreamdConfig
  const agent = yield* Agent
  const commands = yield* Commands
  yield* Effect.logInfo("dreamd started", {
    version,
    projectId: config.projectId,
    harness: config.harness,
    port: config.port,
    socket: config.socket,
    workDir: config.workDir
  })
  yield* Effect.raceFirst(Effect.all([agent.run, commands.run], { concurrency: "unbounded" }), configChanged)
})

/** Everything `main` needs, given the config and the platform. */
export const layerWithoutConfig = Layer.mergeAll(DaemonServer, SocketServer).pipe(
  Layer.provideMerge(Layer.mergeAll(Agent.layer, Commands.layer)),
  Layer.provideMerge(Layer.mergeAll(Inbox.layer, Harness.layer, Api.layer))
)

export const layer = layerWithoutConfig.pipe(
  Layer.provideMerge(DreamdConfig.layer),
  Layer.provideMerge(NodeServices.layer)
)
