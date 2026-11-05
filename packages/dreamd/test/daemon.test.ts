/**
 * dreamd assembled as it runs in the sandbox, against a fake API: the daemon
 * port, the CLI socket and the turn loop, with a scripted harness.
 */
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import {
  CurrentProject,
  DaemonAuth,
  DaemonRpcs,
  HttpRpcSerialization,
  type ProjectId,
  Routes,
  SandboxAuth,
  SandboxRpcs,
  Unauthorized,
  type UserId
} from "@dream/domain"
import * as Fixtures from "@dream/domain/fixtures"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { ConfigProvider, Context, Effect, Exit, Layer, Option, Queue, Ref } from "effect"
import { Command } from "effect/cli"
import { FetchHttpClient, Headers, HttpRouter } from "effect/http"
import { RpcClient, RpcMiddleware, RpcServer } from "effect/rpc"
import { Agent } from "../src/Agent.ts"
import { Api } from "../src/Api.ts"
import { dream } from "../src/Cli.ts"
import { Dream } from "../src/cli/Client.ts"
import { Commands } from "../src/Commands.ts"
import { DreamdConfig } from "../src/Config.ts"
import { Harness, type HarnessError, type TurnResult, TurnOutcome } from "../src/harness/Harness.ts"
import { Inbox } from "../src/Inbox.ts"
import { DaemonServer, SocketServer } from "../src/Servers.ts"
import { configRecord, tempDir, userMessage } from "./support.ts"

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      server.close(() => resolve(port))
    })
  })

/** A Worker that answers the RPCs these tests use and records what it was sent, with which token. */
const fakeApi = (calls: Ref.Ref<ReadonlyArray<string>>, port: number) => {
  const record = (call: string) => Ref.update(calls, (all) => [...all, call])
  const handlers = SandboxRpcs.toLayer(
    new Proxy({} as never, {
      get: (_, tag: string) => (payload: unknown) =>
        Effect.gen(function* () {
          yield* record(`${tag} ${JSON.stringify(payload)}`)
          if (tag === "SendMessage") return Fixtures.liftLogUpdate
          return undefined
        })
    })
  )
  const auth = Layer.succeed(SandboxAuth, (effect, { headers }) =>
    Option.getOrUndefined(Headers.get(headers, "authorization")) === "Bearer project-token"
      ? Effect.provideService(effect, CurrentProject, {
          projectId: "prj_test" as ProjectId,
          userId: "usr_test" as UserId
        })
      : Effect.fail(new Unauthorized({ message: "bad project token" }))
  )
  return HttpRouter.serve(
    RpcServer.layerHttp({ group: SandboxRpcs, path: Routes.sandbox, protocol: "http" }).pipe(
      Layer.provide([handlers, auth, HttpRpcSerialization])
    ),
    { disableListenLog: true, disableLogger: true }
  ).pipe(Layer.provide(NodeHttpServer.layer(() => createServer(), { port, host: "127.0.0.1" })))
}

const daemonClient = (port: number, token: string) =>
  RpcClient.make(DaemonRpcs).pipe(
    Effect.provide(
      Layer.mergeAll(
        RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${port}${Routes.daemon}` }).pipe(
          Layer.provide([FetchHttpClient.layer, HttpRpcSerialization])
        ),
        RpcMiddleware.layerClient(DaemonAuth, ({ request, next }) =>
          next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) })
        )
      )
    )
  )

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
    Layer.mergeAll(DaemonServer, SocketServer).pipe(
      Layer.provideMerge(Layer.mergeAll(Agent.layer, Commands.layer)),
      Layer.provideMerge(Layer.mergeAll(Inbox.layer, Harness.layerTest({ turns, log }), Api.layer)),
      Layer.provideMerge(DreamdConfig.layerFromRecord(env)),
      Layer.provideMerge(NodeServices.layer)
    )
  )
  const agent = Context.get(context, Agent)
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
  return { daemonPort, socket: env.DREAM_SOCKET!, calls, turns, log, cli, waitFor }
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
})
