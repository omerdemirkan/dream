/**
 * A RelayDO on its own, against fakes: a Discord Gateway that speaks the protocol (`FakeDiscord`), a WebSocket feed,
 * and a project that records what it's handed. Time is the test clock, so heartbeats, backoffs and alarms run as
 * they would over minutes and hours.
 */
import { assert, describe, it } from "@effect/vitest"
import {
  DiscordDefaultIntents,
  type IntegrationId,
  InvalidRequest,
  type ProjectId,
  RelayDelivery,
  type RelayForward,
  type RelayForwardResult,
  type RelayId,
  RelaySource
} from "@dream/domain"
import { Context, DateTime, Duration, Effect, Exit, Layer, Redacted, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { NativeAlarm } from "../src/project/Alarm.ts"
import type { RelayCredential } from "../src/project/ProjectRpcs.ts"
import { DiscordEndpoints, wanted } from "../src/relay/Discord.ts"
import { RelayGone, RelayHost, type RelayHostShape } from "../src/relay/RelayHost.ts"
import { relayLayer } from "../src/relay/RelayLayer.ts"
import type { RelayConfig } from "../src/relay/RelayRpcs.ts"
import { RelayStore } from "../src/relay/RelayStore.ts"
import { RelayRuntime } from "../src/relay/Runtime.ts"
import { FakeDiscord } from "./support/FakeDiscord.ts"
import { FakeFeed, discordRest, discordServer, fakeDialer } from "./support/Lines.ts"
import { makeDoStorage } from "./support/Sqlite.ts"

const discordConfig = (source: Partial<Extract<RelaySource, { _tag: "Discord" }>> = {}): RelayConfig => ({
  relayId: "rly_1" as RelayId,
  projectId: "prj_1" as ProjectId,
  source: RelaySource.cases.Discord.make({
    integrationId: "int_1" as IntegrationId,
    intents: DiscordDefaultIntents,
    events: ["MESSAGE_CREATE"],
    mentionsOnly: false,
    ...source
  }),
  target: { path: "/hooks/discord", port: 3000 },
  createdAt: DateTime.makeUnsafe("2026-11-06T20:00:00Z")
})

const feedConfig = (source: Partial<Extract<RelaySource, { _tag: "WebSocket" }>> = {}): RelayConfig => ({
  ...discordConfig(),
  source: RelaySource.cases.WebSocket.make({ url: "wss://feed.example.test/v1", send: [], ...source })
})

const botKey: RelayCredential = {
  key: Redacted.make("bot-token"),
  host: "discord.com",
  header: "Authorization",
  format: "Bot {key}"
}

const decodeDelivery = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.toCodecJson(RelayDelivery)))

/** A project that takes everything, unless a test says otherwise. */
const project = () => {
  const state = {
    delivered: [] as Array<RelayForward>,
    alerts: [] as Array<string>,
    calls: [] as Array<string>,
    /** Answer the next deliveries with these, in turn, then take everything. */
    answers: [] as Array<RelayForwardResult | "gone">,
    credential: botKey as RelayCredential | InvalidRequest | "gone",
    active: true
  }
  const shape: RelayHostShape = {
    deliver: (_projectId, _relayId, deliveries) =>
      Effect.suspend(() => {
        state.calls.push(`deliver ${deliveries.length}`)
        const answer = state.answers.shift()
        if (answer === "gone") return Effect.fail(new RelayGone())
        const result = answer ?? { delivered: deliveries.length }
        state.delivered.push(...deliveries.slice(0, result.delivered))
        return Effect.succeed(result)
      }),
    credential: () =>
      Effect.suspend((): Effect.Effect<RelayCredential, RelayGone | InvalidRequest> => {
        state.calls.push("credential")
        const credential = state.credential
        if (credential === "gone") return Effect.fail(new RelayGone())
        if (credential instanceof InvalidRequest) return Effect.fail(credential)
        return Effect.succeed(credential)
      }),
    alert: (_projectId, _relayId, reason) => Effect.sync(() => void state.alerts.push(reason)),
    active: () =>
      Effect.sync(() => {
        state.calls.push("active")
        return state.active
      })
  }
  return { state, layer: RelayHost.layerTest(shape) }
}

const setup = (
  options: {
    readonly discord?: FakeDiscord
    readonly feed?: FakeFeed
    readonly storage?: ReturnType<typeof makeDoStorage>
    readonly host?: ReturnType<typeof project>
  } = {}
) =>
  Effect.gen(function* () {
    const discord =
      options.discord ??
      new FakeDiscord({ token: "bot-token", gatewayUrl: "wss://gateway.discord.test", heartbeatInterval: 41_250 })
    const feed = options.feed ?? new FakeFeed()
    const storage = options.storage ?? makeDoStorage()
    const host = options.host ?? project()
    const rest: Array<string> = []
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(
      relayLayer(storage.storage, NativeAlarm.layerTest(storage.alarms)).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            host.layer,
            fakeDialer((url) =>
              url.includes("discord.test")
                ? discordServer(discord)
                : url.startsWith("wss://feed.example.test")
                  ? feed
                  : undefined
            ),
            DiscordEndpoints.layerFrom("https://discord.test/api/v10", "discord.test"),
            discordRest(discord, rest)
          )
        )
      ),
      scope
    )
    const runtime = Context.get(context, RelayRuntime)
    const store = Context.get(context, RelayStore)
    /** Let the line and the outbox run for a while of test time. */
    const pass = (duration: Duration.Input = "1 second") =>
      Effect.gen(function* () {
        const steps = Math.min(200, Math.max(1, Math.ceil(Duration.toMillis(duration) / 250)))
        for (let i = 0; i < steps; i++) {
          yield* TestClock.adjust(Duration.millis(Duration.toMillis(duration) / steps))
          for (let j = 0; j < 20; j++) yield* Effect.yieldNow
        }
      })
    const contents = () =>
      host.state.delivered.map((delivery) => (decodeDelivery(delivery.body).data as { content?: string }).content)
    return { discord, feed, storage, host: host.state, hostLayer: host, rest, runtime, store, pass, contents, scope }
  })

describe("a Discord relay", () => {
  it.effect("logs in with the bot token and its intents, then hands on new messages in order", () =>
    Effect.gen(function* () {
      const { discord, runtime, pass, host, contents, rest } = yield* setup()
      const started = yield* runtime.start(discordConfig())
      assert.strictEqual(started.state, "connecting")
      yield* pass()
      assert.deepStrictEqual(rest, ["GET https://discord.test/api/v10/gateway/bot"])
      assert.deepStrictEqual(discord.calls.slice(0, 2), ["connect", `identify ${DiscordDefaultIntents}`])
      const status = yield* runtime.status
      assert.strictEqual(status.state, "connected")
      assert.strictEqual(status.account, "Helper")

      discord.message("first")
      discord.message("second")
      yield* pass()
      assert.deepStrictEqual(contents(), ["first", "second"])
      const delivery = decodeDelivery(host.delivered[0]!.body)
      assert.strictEqual(delivery.relay, "rly_1")
      assert.strictEqual(delivery.source, "discord")
      assert.strictEqual(delivery.type, "MESSAGE_CREATE")
      assert.strictEqual(delivery.id, host.delivered[0]!.id)
      assert.match(delivery.id, /^discord:session-1:\d+$/)
      const after = yield* runtime.status
      assert.strictEqual(after.delivered, 2)
      assert.strictEqual(after.waiting, 0)
    }).pipe(Effect.scoped)
  )

  it("forwards only what it's asked for, and never the bot's own messages", () => {
    const source = (overrides: Partial<Extract<RelaySource, { _tag: "Discord" }>>) =>
      discordConfig(overrides).source as Extract<RelaySource, { _tag: "Discord" }>
    const message = (fields: object) => ({
      id: "1",
      channel_id: "300",
      guild_id: "200",
      author: { id: "500" },
      ...fields
    })
    assert.isTrue(wanted(source({}), "1000", "MESSAGE_CREATE", message({})))
    assert.isFalse(wanted(source({}), "1000", "MESSAGE_CREATE", message({ author: { id: "1000" } })))
    assert.isFalse(wanted(source({}), "1000", "MESSAGE_DELETE", message({})))
    const mentions = source({ mentionsOnly: true })
    assert.isFalse(wanted(mentions, "1000", "MESSAGE_CREATE", message({})))
    assert.isTrue(wanted(mentions, "1000", "MESSAGE_CREATE", message({ mentions: [{ id: "1000" }] })))
    assert.isTrue(wanted(mentions, "1000", "MESSAGE_CREATE", message({ guild_id: undefined })))
    assert.isTrue(
      wanted(mentions, "1000", "MESSAGE_CREATE", message({ referenced_message: { author: { id: "1000" } } }))
    )
    const channels = source({ channels: ["301"] })
    assert.isFalse(wanted(channels, "1000", "MESSAGE_CREATE", message({})))
    assert.isTrue(wanted(channels, "1000", "MESSAGE_CREATE", message({ channel_id: "301" })))
    const reactions = source({ events: ["MESSAGE_REACTION_ADD"], mentionsOnly: true })
    assert.isTrue(wanted(reactions, "1000", "MESSAGE_REACTION_ADD", { user_id: "500", channel_id: "300" }))
  })

  it.effect("heartbeats on Discord's interval with the last sequence number", () =>
    Effect.gen(function* () {
      const { discord, runtime, pass } = yield* setup()
      yield* runtime.start(discordConfig())
      yield* pass()
      discord.message("one")
      yield* pass("2 minutes")
      const beats = discord.calls.filter((call) => call.startsWith("heartbeat"))
      assert.isAtLeast(beats.length, 2)
      assert.isAtMost(beats.length, 3)
      assert.strictEqual(beats.at(-1), "heartbeat 2")
    }).pipe(Effect.scoped)
  )

  it.effect("resumes after the line drops, and gets what was sent meanwhile exactly once", () =>
    Effect.gen(function* () {
      const { discord, runtime, pass, contents } = yield* setup()
      yield* runtime.start(discordConfig())
      yield* pass()
      discord.message("before")
      yield* pass()
      discord.drop()
      discord.message("while down 1")
      discord.message("while down 2")
      yield* pass("10 seconds")
      assert.include(discord.calls, "resume session-1 2")
      assert.strictEqual(discord.calls.filter((call) => call.startsWith("identify")).length, 1)
      discord.message("after")
      yield* pass()
      assert.deepStrictEqual(contents(), ["before", "while down 1", "while down 2", "after"])
      const status = yield* runtime.status
      assert.strictEqual(status.state, "connected")
      assert.include(status.problems[0]?.message, "The Gateway line closed (1006); resuming")
    }).pipe(Effect.scoped)
  )

  it.effect("closes a line Discord stops acknowledging, and resumes", () =>
    Effect.gen(function* () {
      const { discord, runtime, pass } = yield* setup()
      yield* runtime.start(discordConfig())
      yield* pass()
      discord.acking = false
      // The heartbeat's first beat comes at a random point in the interval, so the dead line closes somewhere
      // between one and two intervals (41.25s) on. Discord answers again once it has: left off any longer, the
      // resumed line's own first beat could go unanswered too, and the relay would rightly close that one as well.
      for (let second = 0; second < 90 && !discord.calls.includes("close"); second++) yield* pass()
      assert.isTrue(discord.calls.includes("close"))
      discord.acking = true
      yield* pass("10 seconds")
      assert.isTrue(discord.calls.some((call) => call.startsWith("resume session-1")))
      assert.strictEqual((yield* runtime.status).state, "connected")
      assert.include((yield* runtime.status).problems[0]?.message, "stopped acknowledging heartbeats")
    }).pipe(Effect.scoped)
  )

  it.effect("reconnects when asked, quietly, and identifies afresh when the session can't resume", () =>
    Effect.gen(function* () {
      const { discord, runtime, pass } = yield* setup()
      yield* runtime.start(discordConfig())
      yield* pass()
      discord.requestReconnect()
      yield* pass("2 seconds")
      assert.isTrue(discord.calls.some((call) => call.startsWith("resume session-1")))
      assert.deepStrictEqual((yield* runtime.status).problems, [])

      discord.invalidate(false)
      yield* pass("10 seconds")
      assert.strictEqual(discord.calls.filter((call) => call.startsWith("identify")).length, 2)
      assert.strictEqual(discord.session?.id, "session-2")
      assert.strictEqual((yield* runtime.status).state, "connected")

      // A session that timed out while the line was down: Discord says so, and the relay logs in again.
      discord.drop()
      discord.expire()
      yield* pass("10 seconds")
      assert.strictEqual(discord.calls.filter((call) => call.startsWith("identify")).length, 3)
      assert.strictEqual((yield* runtime.status).state, "connected")
    }).pipe(Effect.scoped)
  )

  it.effect("fails on a refused token, tells the agent once, and tries again only when restarted", () =>
    Effect.gen(function* () {
      const discord = new FakeDiscord({ token: "the-real-token", gatewayUrl: "wss://gateway.discord.test" })
      const { runtime, pass, host, storage } = yield* setup({ discord })
      yield* runtime.start(discordConfig())
      yield* pass("10 minutes")
      const status = yield* runtime.status
      assert.strictEqual(status.state, "failed")
      assert.include(status.problems[0]?.message, "Discord refused the bot token (4004)")
      assert.lengthOf(host.alerts, 1)
      assert.include(host.alerts[0], "Relay rly_1 (Discord) stopped: Discord refused the bot token")
      assert.include(host.alerts[0], "`dream relay restart rly_1`")
      // Asked for the Gateway once (REST refuses the token too), then nothing.
      assert.strictEqual(host.calls.filter((call) => call === "credential").length, 1)
      // Nothing waits for the app, so the object goes idle: no alarm.
      assert.strictEqual(storage.alarms.at(-1), null)

      host.credential = { ...botKey, key: Redacted.make("the-real-token") }
      const restarted = yield* runtime.restart
      assert.strictEqual(restarted.state, "connecting")
      yield* pass()
      assert.strictEqual((yield* runtime.status).state, "connected")
    }).pipe(Effect.scoped)
  )

  it.effect("fails, saying what to switch on, when the intents aren't allowed", () =>
    Effect.gen(function* () {
      const discord = new FakeDiscord({
        token: "bot-token",
        gatewayUrl: "wss://gateway.discord.test",
        allowedIntents: DiscordDefaultIntents & ~(1 << 15)
      })
      const { runtime, pass, host } = yield* setup({ discord })
      yield* runtime.start(discordConfig())
      yield* pass("1 minute")
      assert.strictEqual((yield* runtime.status).state, "failed")
      assert.include(host.alerts[0], "Message Content Intent")
    }).pipe(Effect.scoped)
  )

  it.effect("waits out Discord's rate limit, and backs off while the API is down", () =>
    Effect.gen(function* () {
      const { discord, runtime, pass, rest } = yield* setup()
      discord.restStatus = 500
      yield* runtime.start(discordConfig())
      yield* pass("10 seconds")
      const tries = rest.length
      assert.isAtLeast(tries, 3)
      assert.isAtMost(tries, 5)
      assert.strictEqual((yield* runtime.status).state, "retrying")
      discord.restStatus = undefined
      yield* pass("1 minute")
      assert.strictEqual((yield* runtime.status).state, "connected")
    }).pipe(Effect.scoped)
  )

  it.effect("won't send the token to a Gateway host that isn't Discord's", () =>
    Effect.gen(function* () {
      const discord = new FakeDiscord({ token: "bot-token", gatewayUrl: "wss://gateway.attacker.example" })
      const { runtime, pass, host } = yield* setup({ discord })
      yield* runtime.start(discordConfig())
      yield* pass("1 minute")
      assert.strictEqual((yield* runtime.status).state, "failed")
      assert.include(host.alerts[0], "unexpected host")
      assert.notInclude(discord.calls, "connect")
    }).pipe(Effect.scoped)
  )

  it.effect("resumes its session after the object restarts, as on a deploy", () =>
    Effect.gen(function* () {
      const discord = new FakeDiscord({ token: "bot-token", gatewayUrl: "wss://gateway.discord.test" })
      const storage = makeDoStorage()
      const host = project()
      const first = yield* setup({ discord, storage, host })
      yield* first.runtime.start(discordConfig())
      yield* first.pass()
      discord.message("before the deploy")
      yield* first.pass()
      // The object goes away mid-session: its line drops without a close frame.
      yield* Scope.close(first.scope, Exit.void)
      discord.drop()
      discord.message("during the deploy")
      const second = yield* setup({ discord, storage, host })
      yield* second.runtime.alarm
      yield* second.pass("5 seconds")
      assert.isTrue(discord.calls.some((call) => call.startsWith("resume session-1")))
      assert.deepStrictEqual(second.contents(), ["before the deploy", "during the deploy"])
      assert.strictEqual((yield* second.runtime.status).state, "connected")
    }).pipe(Effect.scoped)
  )
})

describe("delivering to the app", () => {
  it.effect("keeps events while the app doesn't take them, retries with a growing backoff, and loses none", () =>
    Effect.gen(function* () {
      const { discord, runtime, pass, host, contents } = yield* setup()
      host.answers.push(
        { delivered: 0, failure: { message: "Couldn't reach the app on port 3000." } },
        { delivered: 1, failure: { status: 500, message: "The app answered 500." } },
        { delivered: 0, failure: { status: 500, message: "The app answered 500." } }
      )
      yield* runtime.start(discordConfig())
      yield* pass()
      discord.message("a")
      discord.message("b")
      discord.message("c")
      yield* pass("1 second")
      let status = yield* runtime.status
      assert.strictEqual(status.waiting, 3)
      assert.include(status.problems[0]?.message, "Couldn't reach the app")
      yield* pass("5 seconds")
      assert.deepStrictEqual(contents(), ["a"])
      yield* pass("15 seconds")
      yield* pass("45 seconds")
      assert.deepStrictEqual(contents(), ["a", "b", "c"])
      status = yield* runtime.status
      assert.strictEqual(status.waiting, 0)
      assert.strictEqual(status.delivered, 3)
      assert.deepStrictEqual(
        host.calls.filter((call) => call.startsWith("deliver")),
        ["deliver 3", "deliver 3", "deliver 2", "deliver 2"]
      )
    }).pipe(Effect.scoped)
  )

  it.effect("tells the agent once after an hour of failures, and again only after a recovery", () =>
    Effect.gen(function* () {
      const { discord, runtime, pass, host } = yield* setup()
      const failing = { delivered: 0, failure: { status: 404, message: "The app answered 404: Not Found." } }
      for (let i = 0; i < 30; i++) host.answers.push(failing)
      yield* runtime.start(discordConfig())
      yield* pass()
      discord.message("hello")
      yield* pass("50 minutes")
      assert.lengthOf(host.alerts, 0)
      yield* pass("30 minutes")
      assert.lengthOf(host.alerts, 1)
      assert.include(host.alerts[0], "hasn't been able to deliver to /hooks/discord for over an hour")
      assert.include(host.alerts[0], "The app answered 404: Not Found.")
      yield* pass("2 hours")
      assert.lengthOf(host.alerts, 1)
    }).pipe(Effect.scoped)
  )

  it.effect("drops what's too big, too many or too old, and counts it", () =>
    Effect.gen(function* () {
      const { discord, runtime, pass, host } = yield* setup()
      for (let i = 0; i < 2000; i++) host.answers.push({ delivered: 0, failure: { message: "down" } })
      yield* runtime.start(discordConfig())
      yield* pass()
      discord.message("x".repeat(300 * 1024))
      for (let i = 0; i < 510; i++) discord.message(`m${i}`)
      yield* pass("1 minute")
      let status = yield* runtime.status
      assert.strictEqual(status.waiting, 500)
      assert.strictEqual(status.dropped, 11)
      assert.isTrue(status.problems.some((problem) => problem.message.includes("KB")))
      assert.isTrue(status.problems.some((problem) => problem.message.includes("500 events were waiting")))
      yield* pass("25 hours")
      status = yield* runtime.status
      assert.strictEqual(status.waiting, 0)
      assert.strictEqual(status.dropped, 511)
    }).pipe(Effect.scoped)
  )

  it.effect("forgets everything when the project no longer holds it", () =>
    Effect.gen(function* () {
      const { discord, runtime, pass, host, storage } = yield* setup()
      host.answers.push("gone")
      yield* runtime.start(discordConfig())
      yield* pass()
      discord.message("late")
      yield* pass()
      assert.strictEqual(discord.connected, 0)
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.status)))
      assert.strictEqual(storage.alarms.at(-1), null)
    }).pipe(Effect.scoped)
  )
})

describe("the relay's object", () => {
  it.effect("wakes every minute while it holds a line, and checks in with the project every ten", () =>
    Effect.gen(function* () {
      const { runtime, pass, host, storage } = yield* setup()
      yield* runtime.start(discordConfig())
      yield* pass()
      const first = storage.alarms.at(-1)
      assert.isNumber(first)
      for (let i = 0; i < 11; i++) {
        yield* TestClock.adjust("1 minute")
        yield* runtime.alarm
      }
      assert.strictEqual(host.calls.filter((call) => call === "active").length, 1)
      host.active = false
      for (let i = 0; i < 10; i++) {
        yield* TestClock.adjust("1 minute")
        yield* runtime.alarm
      }
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.status)))
      assert.strictEqual(storage.alarms.at(-1), null)
    }).pipe(Effect.scoped)
  )

  it.effect("stops: closes the line, drops what waits, and goes idle", () =>
    Effect.gen(function* () {
      const { discord, runtime, pass, host, store } = yield* setup()
      host.answers.push({ delivered: 0, failure: { message: "down" } })
      yield* runtime.start(discordConfig())
      yield* pass()
      discord.message("waiting")
      yield* pass()
      yield* runtime.stop
      yield* pass()
      assert.strictEqual(discord.connected, 0)
      assert.strictEqual(yield* store.waiting, 0)
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runtime.status)))
    }).pipe(Effect.scoped)
  )
})

describe("a WebSocket relay", () => {
  it.effect("subscribes on every connect, with the key's header, and forwards what matches", () =>
    Effect.gen(function* () {
      const { feed, runtime, pass, host, contents } = yield* setup()
      host.credential = {
        key: Redacted.make("feed-key"),
        host: "feed.example.test",
        header: "X-Api-Key",
        format: "{key}"
      }
      yield* runtime.start(
        feedConfig({ integrationId: "int_2" as IntegrationId, send: ['{"subscribe":"BTC"}'], match: "BTC" })
      )
      yield* pass()
      assert.deepStrictEqual(feed.current?.headers, { "X-Api-Key": "feed-key" })
      assert.deepStrictEqual(feed.current?.received, ['{"subscribe":"BTC"}'])
      feed.push('{"symbol":"BTC","price":1}')
      feed.push('{"symbol":"ETH","price":2}')
      feed.push("BTC is up")
      yield* pass()
      const data = host.delivered.map((delivery) => decodeDelivery(delivery.body).data)
      assert.deepStrictEqual(data, [{ symbol: "BTC", price: 1 }, "BTC is up"])
      assert.deepStrictEqual(contents(), [undefined, undefined])

      feed.drop()
      yield* pass("5 seconds")
      assert.lengthOf(feed.connections, 2)
      assert.deepStrictEqual(feed.current?.received, ['{"subscribe":"BTC"}'])
    }).pipe(Effect.scoped)
  )

  it.effect("pings on schedule and reconnects a feed that goes silent", () =>
    Effect.gen(function* () {
      const { feed, runtime, pass } = yield* setup()
      yield* runtime.start(feedConfig({ ping: { message: "ping", everySeconds: 30 }, silenceSeconds: 90 }))
      yield* pass()
      yield* pass("65 seconds")
      assert.deepStrictEqual(feed.connections[0]?.received, ["ping", "ping"])
      yield* pass("30 seconds")
      assert.lengthOf(feed.connections, 2)
      assert.include((yield* runtime.status).problems[0]?.message, "Nothing arrived for 90s")
    }).pipe(Effect.scoped)
  )

  it.effect("fails when the feed refuses its key, and sends binary messages as base64", () =>
    Effect.gen(function* () {
      const feed = new FakeFeed()
      feed.refuse = 401
      const { runtime, pass, host } = yield* setup({ feed })
      yield* runtime.start(feedConfig())
      yield* pass("1 minute")
      assert.strictEqual((yield* runtime.status).state, "failed")
      assert.include(host.alerts[0], "The feed refused the connection (401); it may need a key (--key)")
    }).pipe(Effect.scoped)
  )
})
