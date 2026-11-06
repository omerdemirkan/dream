/**
 * The relay contract: its shapes round-trip as JSON, what the agent passes is checked where it's decoded, and the
 * additions to existing RPCs (StayAwake's "relay", Sleep, ForwardRelay) leave older callers working.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Exit, Schema } from "effect"
import {
  DaemonRpcs,
  DiscordDefaultEvents,
  DiscordDefaultIntents,
  type IntegrationId,
  Relay,
  RelayDelivery,
  RelayForwardResult,
  type RelayId,
  RelaySource,
  RelayTarget,
  relayPathProblem,
  relayUrlHost,
  relayUrlProblem,
  SandboxRpcs
} from "../src/index.ts"

type Codec = Schema.Codec<unknown, unknown, never, never>
const json = <S extends Codec>(schema: S) => Schema.toCodecJson(schema)
const roundTrip = <S extends Codec>(schema: S, value: S["Type"]) => {
  const text = JSON.stringify(Schema.encodeSync(json(schema))(value))
  return { text, decoded: Schema.decodeUnknownSync(json(schema))(JSON.parse(text)) }
}

const relay: Relay = {
  id: "rly_1" as RelayId,
  source: RelaySource.cases.Discord.make({
    integrationId: "int_1" as IntegrationId,
    intents: DiscordDefaultIntents,
    events: DiscordDefaultEvents,
    mentionsOnly: true
  }),
  target: { path: "/hooks/discord", port: 3000 },
  createdAt: DateTime.makeUnsafe("2026-11-06T20:00:00Z"),
  state: "connected",
  since: DateTime.makeUnsafe("2026-11-06T20:00:02Z"),
  account: "Helper#0001",
  waiting: 0,
  delivered: 12,
  dropped: 0,
  problems: [{ at: DateTime.makeUnsafe("2026-11-06T19:59:00Z"), message: "The line dropped (1006)." }]
}

describe("relay shapes", () => {
  it("round-trip as JSON, with absent keys left out", () => {
    const { text, decoded } = roundTrip(Relay, relay)
    assert.deepStrictEqual(decoded, relay)
    assert.notInclude(text, "channels")
    assert.notInclude(text, "lastEventAt")
    assert.include(text, '"createdAt":"2026-11-06T20:00:00.000Z"')
  })

  it("carry a WebSocket feed with its subscribe messages, ping and filter", () => {
    const feed = RelaySource.cases.WebSocket.make({
      url: "wss://ws-feed.exchange.coinbase.com",
      send: [JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] })],
      ping: { message: "ping", everySeconds: 30 },
      silenceSeconds: 60,
      match: "BTC-USD"
    })
    assert.deepStrictEqual(roundTrip(RelaySource, feed).decoded, feed)
  })

  it("defaults the Discord intents to servers, messages, DMs and message content", () => {
    assert.strictEqual(DiscordDefaultIntents, 1 + 512 + 4096 + 32768)
    assert.deepStrictEqual([...DiscordDefaultEvents], ["MESSAGE_CREATE"])
  })

  it("describe a delivery's body, binary or not", () => {
    const delivery: RelayDelivery = {
      id: "discord:MESSAGE_CREATE:123",
      relay: "rly_1" as RelayId,
      source: "discord",
      type: "MESSAGE_CREATE",
      at: DateTime.makeUnsafe("2026-11-06T20:01:00Z"),
      data: { id: "123", content: "hi" }
    }
    assert.deepStrictEqual(roundTrip(RelayDelivery, delivery).decoded, delivery)
    const binary = { ...delivery, source: "websocket" as const, data: "AAEC", binary: true }
    const { type: _, ...withoutType } = binary
    assert.deepStrictEqual(roundTrip(RelayDelivery, withoutType).decoded, withoutType)
  })

  it("report how many deliveries the app took and why the next didn't go", () => {
    const result = { delivered: 2, failure: { message: "404 Not Found", status: 404 } }
    assert.deepStrictEqual(roundTrip(RelayForwardResult, result).decoded, result)
    assert.deepStrictEqual(roundTrip(RelayForwardResult, { delivered: 3 }).decoded, { delivered: 3 })
  })
})

describe("relay validation", () => {
  it("takes paths that start with / and says what's wrong with others", () => {
    assert.isUndefined(relayPathProblem("/hooks/discord"))
    assert.isUndefined(relayPathProblem("/hooks/feed?source=coinbase"))
    assert.include(relayPathProblem("hooks/discord") ?? "", 'starts with "/"')
    assert.include(relayPathProblem("/a b") ?? "", "spaces")
    assert.include(relayPathProblem(`/${"a".repeat(600)}`) ?? "", "512")
    const decode = Schema.decodeUnknownExit(json(RelayTarget))
    assert.isTrue(Exit.isSuccess(decode({ path: "/hooks" })))
    assert.isTrue(Exit.isFailure(decode({ path: "hooks" })))
    assert.isTrue(Exit.isFailure(decode({ path: "/hooks", port: 0 })))
  })

  it("takes wss:// feeds on public hosts, without credentials in the URL", () => {
    assert.isUndefined(relayUrlProblem("wss://ws-feed.exchange.coinbase.com"))
    assert.isUndefined(relayUrlProblem("wss://stream.example.com:8443/v1/feed?symbols=AAPL"))
    assert.include(relayUrlProblem("ws://stream.example.com") ?? "", "wss://")
    assert.include(relayUrlProblem("https://stream.example.com") ?? "", "wss://")
    assert.include(relayUrlProblem("wss://user:pass@stream.example.com") ?? "", "--key")
    assert.include(relayUrlProblem("wss://localhost/feed") ?? "", "public host")
    assert.strictEqual(relayUrlHost("wss://Stream.Example.com:8443/x"), "stream.example.com")
    assert.isUndefined(relayUrlHost("wss://"))
    const decode = Schema.decodeUnknownExit(json(RelaySource))
    assert.isTrue(Exit.isFailure(decode({ _tag: "WebSocket", url: "ws://x.example.com", send: [] })))
  })

  it("bounds a feed's ping and silence", () => {
    const decode = Schema.decodeUnknownExit(json(RelaySource))
    const feed = { _tag: "WebSocket", url: "wss://x.example.com", send: [] }
    assert.isTrue(Exit.isFailure(decode({ ...feed, ping: { message: "p", everySeconds: 1 } })))
    assert.isTrue(Exit.isFailure(decode({ ...feed, silenceSeconds: 3 })))
    assert.isTrue(Exit.isSuccess(decode({ ...feed, ping: { message: "p", everySeconds: 30 }, silenceSeconds: 90 })))
  })
})

describe("additions to existing RPCs", () => {
  const payload = (group: { requests: ReadonlyMap<string, { payloadSchema: Schema.Top }> }, tag: string) =>
    Schema.decodeUnknownExit(json(group.requests.get(tag)!.payloadSchema as unknown as Codec))

  it("StayAwake still takes the reasons older dreamd builds send, and now 'relay'", () => {
    const decode = payload(SandboxRpcs, "StayAwake")
    for (const reason of ["command", "app", "relay"]) assert.isTrue(Exit.isSuccess(decode({ reason })))
    assert.isTrue(Exit.isFailure(decode({ reason: "other" })))
  })

  it("adds Sleep, the relay calls and ForwardRelay as new RPCs", () => {
    for (const tag of ["Sleep", "AddRelay", "ListRelays", "RemoveRelay", "RestartRelay"]) {
      assert.isTrue(SandboxRpcs.requests.has(tag), tag)
    }
    assert.isTrue(DaemonRpcs.requests.has("ForwardRelay"))
    const forward = payload(DaemonRpcs, "ForwardRelay")
    assert.isTrue(
      Exit.isSuccess(
        forward({ relayId: "rly_1", port: 3000, path: "/hooks/discord", deliveries: [{ id: "d1", body: "{}" }] })
      )
    )
    assert.isTrue(Exit.isFailure(forward({ relayId: "rly_1", port: 3000, path: "/hooks/discord", deliveries: [] })))
  })
})
