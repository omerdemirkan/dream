/**
 * dreamd: the sandbox's event loop. It serves `DaemonRpcs` on
 * `DREAM_DAEMON_PORT` (the ProjectDO delivers events there), serves the
 * `dream` CLI on the `DREAM_SOCKET` Unix socket (forwarding to the API), runs
 * scheduled commands, runs one harness turn at a time, looks at the
 * published URL after each, posts relay deliveries to the app (`Relays.ts`),
 * keeps the sandbox awake while a scheduled command runs, a delivery is under
 * way or the published app is in use, and asks for it to sleep once the work
 * it woke for is done (see `Awake.ts`).
 *
 * It exits when its env file changes, so its supervisor restarts it with the
 * new configuration, and it always exits promptly (see `Shutdown.ts`).
 */
import { NodeServices } from "@effect/platform-node"
import { Duration, Effect, Fiber, FileSystem, Layer, Option, Path, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { Agent } from "./Agent.ts"
import { Api } from "./Api.ts"
import { Attachments } from "./Attachments.ts"
import { AppTraffic, Awake } from "./Awake.ts"
import { PageCheck } from "./cli/PageCheck.ts"
import { Commands } from "./Commands.ts"
import { DreamdConfig } from "./Config.ts"
import { Harness } from "./harness/Harness.ts"
import { Tasks } from "./Tasks.ts"
import { Inbox } from "./Inbox.ts"
import { Outreach } from "./Outreach.ts"
import { Hold } from "./Hold.ts"
import { Progress } from "./progress/Progress.ts"
import * as CliSummarizer from "./progress/CliSummarizer.ts"
import { Summarizer } from "./progress/Summarizer.ts"
import { Published } from "./Published.ts"
import { RelayForwarder } from "./Relays.ts"
import { DaemonServer, SocketServer } from "./Servers.ts"
import { Shutdown } from "./Shutdown.ts"
import { readRelease, version } from "./version.ts"

/**
 * Completes when the env file's contents change. A watch on its directory (the
 * file may be replaced rather than rewritten) notices at once; the poll is the
 * fallback for file systems where watching doesn't work.
 */
export const configChanged = Effect.gen(function* () {
  const config = yield* DreamdConfig
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const read = fs.readFileString(config.envFile).pipe(Effect.option, Effect.map(Option.getOrUndefined))
  const initial = yield* read
  const name = path.basename(config.envFile)
  const watched = fs.watch(path.dirname(config.envFile)).pipe(
    Stream.filter((event) => path.basename(event.path) === name),
    Stream.catch((error) =>
      Stream.fromEffect(Effect.logWarning("Can't watch the env file; polling it", { error: error.message })).pipe(
        Stream.drain
      )
    )
  )
  yield* Stream.merge(watched, Stream.tick(Duration.seconds(5))).pipe(
    // A rewrite can show up as several events; read once it settles.
    Stream.debounce(Duration.millis(100)),
    Stream.mapEffect(() => read),
    Stream.filter((current) => current !== undefined && current !== initial),
    Stream.take(1),
    Stream.runDrain
  )
  yield* Effect.logInfo(`${config.envFile} changed; restarting`)
})

/**
 * Runs the event loop until the env file changes or a signal arrives, then
 * stops it: the running turn is interrupted (its events stay in the inbox on
 * disk and go to the first turn after the restart), and if it doesn't stop
 * within the grace period, `main` returns anyway and the process exits.
 */
export const main = Effect.gen(function* () {
  const config = yield* DreamdConfig
  const agent = yield* Agent
  const commands = yield* Commands
  const awake = yield* Awake
  const progress = yield* Progress
  const shutdown = yield* Shutdown
  yield* Effect.logInfo("dreamd started", {
    version,
    release: Option.getOrUndefined(yield* readRelease()),
    projectId: config.projectId,
    harness: config.harness,
    port: config.port,
    socket: config.socket,
    workDir: config.workDir,
    envHash: Option.getOrUndefined(config.envHash)
  })
  const work = yield* Effect.forkDetach(
    Effect.all([agent.run, commands.run, awake.run, progress.run], { concurrency: "unbounded" })
  )
  const stop = (reason: string) =>
    Effect.gen(function* () {
      yield* shutdown.begin(reason)
      const stopped = yield* Fiber.interrupt(work).pipe(Effect.timeoutOption(shutdown.grace))
      if (Option.isNone(stopped)) {
        yield* Effect.logWarning(
          `The running turn didn't stop within ${Duration.format(shutdown.grace)}; exiting anyway`
        )
      }
    })
  yield* Effect.raceFirst(configChanged, Fiber.join(work)).pipe(Effect.onInterrupt(() => stop("interrupted")))
  yield* stop("the env file changed")
})

/** Everything `main` needs, given the harness, how to shut down, the config and the platform. */
export const layerWith = <E, R>(
  base: Layer.Layer<Harness | Tasks | Shutdown | PageCheck | AppTraffic | RelayForwarder | Summarizer, E, R>
) =>
  Layer.mergeAll(DaemonServer, SocketServer).pipe(
    Layer.provideMerge(Awake.layer),
    Layer.provideMerge(Layer.mergeAll(Agent.layer, Commands.layer)),
    Layer.provideMerge(Layer.mergeAll(Published.layer, Progress.layer)),
    Layer.provideMerge(
      Layer.mergeAll(
        Inbox.layer,
        Hold.layer,
        Api.layer,
        Outreach.layer,
        Attachments.layer.pipe(Layer.provide(FetchHttpClient.layer)),
        base
      )
    )
  )

/** Everything `main` needs, given the config and the platform. */
export const layerWithoutConfig = layerWith(
  Layer.mergeAll(
    Harness.layer,
    Tasks.layer,
    Shutdown.layer,
    AppTraffic.layer,
    PageCheck.layer.pipe(Layer.provide(FetchHttpClient.layer)),
    RelayForwarder.layer.pipe(Layer.provide(FetchHttpClient.layer)),
    // The progress line: a small model through the harness CLI, or only the model-free line.
    Layer.unwrap(
      Effect.gen(function* () {
        return (yield* DreamdConfig).progressModel ? CliSummarizer.layer : Summarizer.modelFree
      })
    )
  )
)

export const layer = layerWithoutConfig.pipe(
  Layer.provideMerge(DreamdConfig.layer),
  Layer.provideMerge(NodeServices.layer)
)
