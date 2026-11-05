/**
 * dreamd assembled as it runs in the sandbox, against a fake API: the daemon
 * port, the CLI socket and the turn loop, with a scripted harness.
 */
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Fixtures from "@dream/domain/fixtures"
import { NodeServices } from "@effect/platform-node"
import { ConfigProvider, Context, Effect, Exit, Layer, Queue, Ref } from "effect"
import { Command } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { Agent } from "../src/Agent.ts"
import { dream } from "../src/Cli.ts"
import { Dream } from "../src/cli/Client.ts"
import { DreamdConfig } from "../src/Config.ts"
import { layerWith } from "../src/Daemon.ts"
import { Harness, type HarnessError, type TurnResult, TurnOutcome } from "../src/harness/Harness.ts"
import { Shutdown } from "../src/Shutdown.ts"
import { configRecord, daemonClient, fakeApi, freePort, tempDir, userMessage } from "./support.ts"

const setup = Effect.gen(function* () {
  const dir = tempDir()
  const apiPort = yield* Effect.promise(freePort)
  const daemonPort = yield* Effect.promise(freePort)
  const env = configRecord(dir, {
    DREAM_API_URL: `http://127.0.0.1:${apiPort}`,
    DREAM_DAEMON_PORT: String(daemonPort),
    DREAM_SOCKET: join(dir, "dreamd.sock")
  })
  const calls = yield* Ref.make<ReadonlyArray<string>>([])
  const turns = yield* Queue.unbounded<(prompt: string) => Effect.Effect<TurnResult, HarnessError>>()
  const log = yield* Ref.make<ReadonlyArray<string>>([])
  yield* Layer.build(fakeApi(calls, apiPort))
  const context = yield* Layer.build(
    layerWith(Layer.mergeAll(Harness.layerTest({ turns, log }), Shutdown.layerTest())).pipe(
      Layer.provideMerge(DreamdConfig.layerFromRecord(env)),
      Layer.provideMerge(NodeServices.layer)
    )
  )
  const agent = Context.get(context, Agent)
  const shutdown = Context.get(context, Shutdown)
  yield* Effect.forkScoped(agent.run)
  /** Run `dream …` as the agent would, from a process with only `DREAM_SOCKET` set. */
  const cli = (...args: Array<string>) =>
    Command.runWith(dream, { version: "test" })(args).pipe(
      Effect.provide(Layer.mergeAll(Dream.layer, FetchHttpClient.layer, NodeServices.layer)),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ DREAM_SOCKET: env.DREAM_SOCKET! })))
    )
  const waitFor = (predicate: (calls: ReadonlyArray<string>) => boolean) =>
    Effect.gen(function* () {
      while (!predicate(yield* Ref.get(calls))) yield* Effect.sleep("10 millis")
      return yield* Ref.get(calls)
    }).pipe(Effect.timeout("5 seconds"))
  return { daemonPort, socket: env.DREAM_SOCKET!, calls, turns, log, cli, waitFor, shutdown }
})

describe("dreamd", () => {
  it.live("takes events from the DO, runs a turn and reports it", () =>
    Effect.gen(function* () {
      const { daemonPort, turns, log, waitFor } = yield* setup
      yield* Queue.offer(turns, () =>
        Effect.succeed({ outcome: TurnOutcome.Completed(), usage: { weekly: { usedPercent: 4 } }, progressed: true })
      )
      const client = yield* daemonClient(daemonPort, "daemon-token")
      const { accepted } = yield* client.Deliver({ events: [userMessage(1, "Hello")], timeZone: "Europe/Berlin" })
      assert.deepStrictEqual<ReadonlyArray<string>>(accepted, ["evt_1"])
      const calls = yield* waitFor((calls) => calls.some((call) => call.includes('"finished"')))
      assert.isTrue(calls.some((call) => call.startsWith("ReportTurn") && call.includes('"started"')))
      assert.isTrue(calls.some((call) => call.startsWith("ReportUsage") && call.includes('"usedPercent":4')))
      assert.include((yield* Ref.get(log))[0], "(Europe/Berlin)")
      const health = yield* client.Health()
      assert.deepStrictEqual(health, { version: "0.1.0", turn: "idle", queued: 0 })
    }).pipe(Effect.scoped)
  )

  it.live("refuses deliveries once a restart is pending, so the DO delivers them again", () =>
    Effect.gen(function* () {
      const { daemonPort, shutdown } = yield* setup
      const client = yield* daemonClient(daemonPort, "daemon-token")
      yield* shutdown.begin("test")
      const error = yield* Effect.flip(client.Deliver({ events: [userMessage(1)] }))
      assert.strictEqual(error._tag, "DaemonRestarting")
      assert.strictEqual((yield* client.Health()).queued, 0)
    }).pipe(Effect.scoped)
  )

  it.live("refuses deliveries without the daemon token", () =>
    Effect.gen(function* () {
      const { daemonPort } = yield* setup
      const client = yield* daemonClient(daemonPort, "forged")
      const exit = yield* client.Deliver({ events: [userMessage(1)] }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit))
      assert.strictEqual(Exit.isFailure(exit) && exit.cause.toString().includes("Unauthorized"), true)
    }).pipe(Effect.scoped)
  )

  it.live("forwards the CLI's calls to the API with the project token", () =>
    Effect.gen(function* () {
      const { cli, waitFor } = yield* setup
      yield* cli("message", "--notify", "The **charts** are live")
      const calls = yield* waitFor((calls) => calls.some((call) => call.startsWith("SendMessage")))
      assert.include(
        calls.find((call) => call.startsWith("SendMessage")),
        '"notify":true'
      )
    }).pipe(Effect.scoped)
  )

  it.live("doesn't let other processes make dreamd's own reports", () =>
    Effect.gen(function* () {
      const { calls, socket } = yield* setup
      const exit = yield* Effect.gen(function* () {
        const client = yield* Dream
        return yield* client.ReportUsage({ usage: Fixtures.usage })
      }).pipe(
        Effect.provide(Dream.layer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ DREAM_SOCKET: socket }))),
        Effect.exit
      )
      assert.isTrue(Exit.isFailure(exit))
      assert.isFalse((yield* Ref.get(calls)).some((call) => call.startsWith("ReportUsage")))
    }).pipe(Effect.scoped)
  )

  it.live("posts a turn's final text only when the agent sent nothing through `dream`", () =>
    Effect.gen(function* () {
      const { daemonPort, turns, cli, waitFor } = yield* setup
      const said = (finalText: string): TurnResult => ({
        outcome: TurnOutcome.Completed(),
        usage: {},
        progressed: true,
        finalText
      })
      yield* Queue.offer(turns, () =>
        cli("message", "The tour page is up").pipe(Effect.orDie, Effect.as(said("Sent.")))
      )
      yield* Queue.offer(turns, () => Effect.succeed(said("Which colour should the header be?")))
      const client = yield* daemonClient(daemonPort, "daemon-token")
      yield* client.Deliver({ events: [userMessage(1)] })
      yield* waitFor((calls) => calls.filter((call) => call.includes('"finished"')).length === 1)
      yield* client.Deliver({ events: [userMessage(2)] })
      const calls = yield* waitFor((calls) => calls.filter((call) => call.includes('"finished"')).length === 2)
      assert.deepStrictEqual(
        calls.filter((call) => call.startsWith("SendMessage")),
        [
          'SendMessage {"text":"The tour page is up","media":[],"notify":false}',
          'SendMessage {"text":"Which colour should the header be?","media":[],"notify":false}'
        ]
      )
    }).pipe(Effect.scoped)
  )
})
