/**
 * dreamd assembled as it runs in the sandbox, against a fake API: the daemon
 * port, the CLI socket and the turn loop, with a scripted harness.
 */
import { AppTraffic } from "../src/Awake.ts"
import { createHmac } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import * as Fixtures from "@dream/domain/fixtures"
import { NodeServices } from "@effect/platform-node"
import { ConfigProvider, Context, DateTime, Effect, Exit, Layer, Queue, Ref } from "effect"
import { Command } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { TestConsole } from "effect/testing"
import { Agent } from "../src/Agent.ts"
import { dream } from "../src/Cli.ts"
import { Dream } from "../src/cli/Client.ts"
import { PageCheck, PageCheckError, PageLoad } from "../src/cli/PageCheck.ts"
import { DreamdConfig } from "../src/Config.ts"
import { layerWith } from "../src/Daemon.ts"
import { Harness, type HarnessError, type TurnResult, TurnOutcome } from "../src/harness/Harness.ts"
import { Tasks } from "../src/Tasks.ts"
import { RelayForwarder } from "../src/Relays.ts"
import { Shutdown } from "../src/Shutdown.ts"
import { configRecord, daemonClient, fakeApi, freePort, noPageChecks, tempDir, userMessage } from "./support.ts"

/** A stand-in for the agent's app: records each request, and answers with the next status in `statuses` (then 200). */
const fakeApp = (statuses: Array<number>) =>
  Effect.gen(function* () {
    const port = yield* Effect.promise(freePort)
    const received: Array<{ path: string; headers: Record<string, string | undefined>; body: string }> = []
    const server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        const headers: Record<string, string | undefined> = {}
        for (const name of ["dream-relay", "dream-delivery", "dream-timestamp", "dream-signature", "content-type"]) {
          const value = request.headers[name]
          headers[name] = Array.isArray(value) ? value[0] : value
        }
        received.push({ path: request.url ?? "", headers, body })
        response.writeHead(statuses.shift() ?? 200, { "content-type": "text/plain" })
        response.end("nope")
      })
    })
    yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()))),
      () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())))
    )
    return { port, received }
  })

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
    layerWith(
      Layer.mergeAll(
        Harness.layerTest({ turns, log }),
        Tasks.layerNone,
        Shutdown.layerTest(),
        noPageChecks,
        AppTraffic.layerNone,
        RelayForwarder.layer.pipe(Layer.provide(FetchHttpClient.layer))
      )
    ).pipe(Layer.provideMerge(DreamdConfig.layerFromRecord(env)), Layer.provideMerge(NodeServices.layer))
  )
  const agent = Context.get(context, Agent)
  const shutdown = Context.get(context, Shutdown)
  yield* Effect.forkScoped(agent.run)
  /** Run `dream …` as the agent would, from a process with only `DREAM_SOCKET` set. */
  const cliWith =
    (pageCheck: Layer.Layer<PageCheck>) =>
    (...args: Array<string>) =>
      Command.runWith(dream, { version: "test" })(args).pipe(
        Effect.provide(Layer.mergeAll(Dream.layer, FetchHttpClient.layer, NodeServices.layer, pageCheck)),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ DREAM_SOCKET: env.DREAM_SOCKET! })))
      )
  const waitFor = (predicate: (calls: ReadonlyArray<string>) => boolean) =>
    Effect.gen(function* () {
      while (!predicate(yield* Ref.get(calls))) yield* Effect.sleep("10 millis")
      return yield* Ref.get(calls)
    }).pipe(Effect.timeout("5 seconds"))
  const cli = cliWith(noPageChecks)
  return { dir, daemonPort, socket: env.DREAM_SOCKET!, calls, turns, log, cli, cliWith, waitFor, shutdown }
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

  it.live("publishes, then prints what the URL answers, and still publishes when the check fails", () =>
    Effect.gen(function* () {
      const { cliWith, calls } = yield* setup
      const publish = (pageCheck: Layer.Layer<PageCheck>) =>
        Effect.gen(function* () {
          yield* cliWith(pageCheck)("publish", "--port", "3000")
          return (yield* TestConsole.logLines).join("\n")
        }).pipe(Effect.provide(TestConsole.layer))
      const loaded = yield* publish(
        PageCheck.layerTest(
          Effect.succeed(
            PageLoad.cases.Loaded.make({
              via: "browser",
              status: 200,
              contentType: "text/html",
              title: "Lift Log",
              pageErrors: [],
              consoleErrors: [],
              failedRequests: [],
              stillLoading: false
            })
          )
        )
      )
      assert.include(loaded, "Port 3000 is public at https://lift-log-x7k2.dream.test.")
      assert.include(loaded, 'Loaded it from this sandbox in Chromium: 200 text/html, title "Lift Log"')
      const failed = yield* publish(
        PageCheck.layerTest(Effect.fail(new PageCheckError({ message: "the browser check hung" })))
      )
      assert.include(failed, "Port 3000 is public at")
      assert.include(failed, "Couldn't check it from this sandbox: the browser check hung.")
      const crashed = yield* publish(PageCheck.layerTest(Effect.die(new Error("boom"))))
      assert.include(crashed, "Couldn't check it from this sandbox: boom.")
      assert.strictEqual((yield* Ref.get(calls)).filter((call) => call.startsWith("Publish")).length, 3)
    }).pipe(Effect.scoped)
  )

  it.live("doesn't let other processes make dreamd's own reports", () =>
    Effect.gen(function* () {
      const { calls, socket } = yield* setup
      const asOtherProcess = <A, E>(call: (client: Context.Service.Shape<typeof Dream>) => Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          return yield* call(yield* Dream)
        }).pipe(
          Effect.provide(Dream.layer),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ DREAM_SOCKET: socket }))),
          Effect.exit
        )
      assert.isTrue(Exit.isFailure(yield* asOtherProcess((client) => client.ReportUsage({ usage: Fixtures.usage }))))
      // An app in the sandbox can't hold its own sandbox up either.
      assert.isTrue(Exit.isFailure(yield* asOtherProcess((client) => client.StayAwake({ reason: "app" }))))
      // Or put it to sleep.
      assert.isTrue(
        Exit.isFailure(
          yield* asOtherProcess((client) =>
            client.Sleep({ reason: "command", checkedAt: DateTime.makeUnsafe(Date.now()) })
          )
        )
      )
      const made = yield* Ref.get(calls)
      assert.isFalse(
        made.some((call) => call.startsWith("ReportUsage") || call.startsWith("StayAwake") || call.startsWith("Sleep"))
      )
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

describe("relay deliveries", () => {
  const deliveries = [1, 2, 3, 4].map((n) => ({
    id: `discord:MESSAGE_CREATE:${n}`,
    body: JSON.stringify({ id: `discord:MESSAGE_CREATE:${n}`, relay: "rly_1", data: { content: `message ${n}` } })
  })) as unknown as readonly [{ id: string; body: string }, ...Array<{ id: string; body: string }>]

  it.live("posts them to the app in order, signed with the relay key, and stops at the first it doesn't take", () =>
    Effect.gen(function* () {
      const { dir, daemonPort } = yield* setup
      const app = yield* fakeApp([200, 204, 404])
      const client = yield* daemonClient(daemonPort, "daemon-token")
      const result = yield* client.ForwardRelay({
        relayId: "rly_1" as never,
        port: app.port,
        path: "/hooks/discord",
        deliveries
      })
      assert.deepStrictEqual(result, { delivered: 2, failure: { status: 404, message: "The app answered 404: nope." } })
      assert.deepStrictEqual(
        app.received.map((request) => [request.path, request.headers["dream-delivery"]]),
        [
          ["/hooks/discord", "discord:MESSAGE_CREATE:1"],
          ["/hooks/discord", "discord:MESSAGE_CREATE:2"],
          ["/hooks/discord", "discord:MESSAGE_CREATE:3"]
        ]
      )
      // The key is made at start, readable only by the sandbox's user, and signs the timestamp and exact body.
      const keyPath = join(dir, ".dream", "relay.key")
      const key = readFileSync(keyPath, "utf8").trim()
      assert.match(key, /^[0-9a-f]{64}$/)
      assert.strictEqual(statSync(keyPath).mode & 0o777, 0o600)
      for (const [i, request] of app.received.entries()) {
        const timestamp = request.headers["dream-timestamp"]!
        assert.strictEqual(request.headers["dream-relay"], "rly_1")
        assert.strictEqual(request.headers["content-type"], "application/json")
        assert.strictEqual(request.body, deliveries[i]!.body)
        assert.isAtMost(Math.abs(Number(timestamp) - Date.now() / 1000), 5)
        assert.strictEqual(
          request.headers["dream-signature"],
          `v1=${createHmac("sha256", key).update(`${timestamp}.${request.body}`).digest("hex")}`
        )
      }
      // The same key next time; the rest go again.
      const again = yield* client.ForwardRelay({
        relayId: "rly_1" as never,
        port: app.port,
        path: "/hooks/discord",
        deliveries: [deliveries[2]!, deliveries[3]!]
      })
      assert.deepStrictEqual(again, { delivered: 2 })
      assert.strictEqual(readFileSync(keyPath, "utf8").trim(), key)
    }).pipe(Effect.scoped)
  )

  it.live("says so when nothing listens on the port", () =>
    Effect.gen(function* () {
      const { daemonPort } = yield* setup
      const client = yield* daemonClient(daemonPort, "daemon-token")
      const closed = yield* Effect.promise(freePort)
      const result = yield* client.ForwardRelay({
        relayId: "rly_1" as never,
        port: closed,
        path: "/hooks/discord",
        deliveries
      })
      assert.strictEqual(result.delivered, 0)
      assert.include(result.failure?.message, `Couldn't reach the app on port ${closed}`)
      assert.isUndefined(result.failure?.status)
    }).pipe(Effect.scoped)
  )

  it.live("refuses them once a restart is pending, so they go again after it", () =>
    Effect.gen(function* () {
      const { daemonPort, shutdown } = yield* setup
      const app = yield* fakeApp([])
      const client = yield* daemonClient(daemonPort, "daemon-token")
      yield* shutdown.begin("test")
      const error = yield* Effect.flip(
        client.ForwardRelay({ relayId: "rly_1" as never, port: app.port, path: "/hooks", deliveries })
      )
      assert.strictEqual(error._tag, "DaemonRestarting")
      assert.lengthOf(app.received, 0)
    }).pipe(Effect.scoped)
  )

  it.live("`dream relay discord` asks for the Gateway session with the defaults filled in", () =>
    Effect.gen(function* () {
      const { cli, waitFor } = yield* setup
      const printed = yield* cli("relay", "discord", "--to", "/hooks/discord", "--port", "3000", "--mentions").pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.provide(TestConsole.layer)
      )
      const calls = yield* waitFor((calls) => calls.some((call) => call.startsWith("AddRelay")))
      assert.strictEqual(
        calls.find((call) => call.startsWith("AddRelay")),
        'AddRelay {"source":{"_tag":"Discord","intents":37377,"events":["MESSAGE_CREATE"],"mentionsOnly":true},"target":{"path":"/hooks/discord","port":3000}}'
      )
      assert.include(printed.join("\n"), "Added rly_test: Discord MESSAGE_CREATE (only mentions and DMs)")
    }).pipe(Effect.scoped)
  )

  it.live("`dream relay websocket` sends the feed, its subscribe messages, ping and filter", () =>
    Effect.gen(function* () {
      const { cli, waitFor } = yield* setup
      yield* cli(
        "relay",
        "websocket",
        "wss://ws-feed.exchange.coinbase.com",
        "--send",
        '{"type":"subscribe"}',
        "--ping",
        "ping",
        "--silence",
        "60",
        "--match",
        "BTC",
        "--to",
        "/hooks/prices",
        "--label",
        "prices"
      ).pipe(Effect.provide(TestConsole.layer))
      const calls = yield* waitFor((calls) => calls.some((call) => call.startsWith("AddRelay")))
      assert.strictEqual(
        calls.find((call) => call.startsWith("AddRelay")),
        'AddRelay {"source":{"_tag":"WebSocket","url":"wss://ws-feed.exchange.coinbase.com","send":["{\\"type\\":\\"subscribe\\"}"],"ping":{"message":"ping","everySeconds":30},"silenceSeconds":60,"match":"BTC"},"target":{"path":"/hooks/prices"},"label":"prices"}'
      )
    }).pipe(Effect.scoped)
  )
})
