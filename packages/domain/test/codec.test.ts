/**
 * Every RPC payload is encoded with `Schema.toCodecJson` and sent as JSON.
 * These tests push representative values through exactly that path.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Exit, Redacted, Schema } from "effect"
import {
  AccessRequest,
  accessHostProblem,
  AgentEvent,
  keyFileNameFor,
  keyFileNameProblem,
  renderAgentEvent,
  sandboxKeyPath,
  AuthedAppRpcs,
  ConnectLink,
  IntegrationAccess,
  LiveActivityContent,
  Message,
  ProjectEvent,
  ProjectSummary,
  PublicAppRpcs,
  PushData,
  Routes,
  StatusCard,
  UsageSnapshot
} from "../src/index.ts"
import * as Fixtures from "../src/fixtures.ts"

const roundTrip = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: S["Type"]) => {
  const codec = Schema.toCodecJson(schema)
  const wire = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(value)))
  return { wire, decoded: Schema.decodeUnknownSync(codec)(wire) }
}

describe("JSON codecs", () => {
  it("round-trips every message kind", () => {
    for (const message of Fixtures.messages) {
      const { decoded } = roundTrip(Message, message)
      assert.deepStrictEqual(decoded, message)
    }
  })

  it("encodes DateTime.Utc as an ISO string", () => {
    const { wire } = roundTrip(StatusCard, Fixtures.liftLogStatus)
    assert.strictEqual(wire.updatedAt, "2026-11-04T22:09:00.000Z")
    assert.strictEqual(wire.milestones[0].date, "2026-10-14T20:00:00.000Z")
  })

  it("omits absent optional keys instead of sending null", () => {
    const { wire } = roundTrip(ProjectSummary, { project: Fixtures.recipeScaler, openAsks: 1 })
    assert.isFalse("headline" in wire.project)
    assert.isFalse("progress" in wire)
  })

  it("round-trips the live snapshot", () => {
    const snapshot = ProjectEvent.cases.Snapshot.make({
      project: Fixtures.liftLog,
      status: Fixtures.liftLogStatus,
      messages: [Fixtures.appleAccess, Fixtures.liftLogUpdate],
      hasEarlierMessages: true,
      working: true
    })
    assert.deepStrictEqual(roundTrip(ProjectEvent, snapshot).decoded, snapshot)
  })

  it("round-trips agent events, usage and integrations", () => {
    for (const event of Fixtures.events) {
      assert.deepStrictEqual(roundTrip(AgentEvent, event).decoded, event)
    }
    assert.deepStrictEqual(roundTrip(UsageSnapshot, Fixtures.usage).decoded, Fixtures.usage)
    assert.deepStrictEqual(roundTrip(IntegrationAccess, Fixtures.google.access).decoded, Fixtures.google.access)
  })

  it("round-trips a file key request, its integration, and the events about it", () => {
    assert.deepStrictEqual(roundTrip(Message, Fixtures.telegramKey).decoded, Fixtures.telegramKey)
    assert.deepStrictEqual(
      roundTrip(IntegrationAccess, Fixtures.telegramKeyFile.access).decoded,
      Fixtures.telegramKeyFile.access
    )
    const fields = { id: "evt_k" as AgentEvent["id"], at: DateTime.makeUnsafe("2026-10-21T09:04:00Z") }
    const connected = AgentEvent.cases.AccessConnected.make({
      ...fields,
      messageId: Fixtures.telegramKey.id,
      label: "Telegram",
      access: Fixtures.telegramKeyFile.access
    })
    const removed = AgentEvent.cases.AccessRemoved.make({
      ...fields,
      label: "Telegram",
      access: Fixtures.telegramKeyFile.access
    })
    for (const event of [connected, removed]) assert.deepStrictEqual(roundTrip(AgentEvent, event).decoded, event)
    assert.include(renderAgentEvent(connected), "Dream wrote it to /home/user/.dream/keys/telegram-bot-token")
    assert.include(renderAgentEvent(removed), "Dream deleted /home/user/.dream/keys/telegram-bot-token")
    assert.strictEqual(
      sandboxKeyPath("telegram-bot-token"),
      Fixtures.telegramKeyFile.access._tag === "File" ? Fixtures.telegramKeyFile.access.path : ""
    )
  })

  it("renders an OAuth connection for the agent with its hosts, placeholder and notes", () => {
    const access = IntegrationAccess.cases.OAuth.make({
      provider: "github",
      service: "GitHub",
      account: "octocat",
      scopes: ["repo"],
      hosts: ["api.github.com", "github.com"],
      placeholder: "dream-github-oauth-placeholder",
      notes: "api.github.com wants a User-Agent header."
    })
    assert.deepStrictEqual(roundTrip(IntegrationAccess, access).decoded, access)
    const event = AgentEvent.cases.AccessConnected.make({
      id: "evt_1" as never,
      at: DateTime.makeUnsafe("2026-11-05T12:00:00Z"),
      messageId: "msg_1" as never,
      label: "GitHub",
      access
    })
    assert.strictEqual(
      renderAgentEvent(event),
      "[Thu, Nov 5, 12:00 PM] They connected GitHub as octocat (repo). HTTPS requests to api.github.com, github.com " +
        'carry their GitHub access token, which Dream keeps fresh. Where a library needs a token configured, use the placeholder "dream-github-oauth-placeholder"; never refresh it yourself. ' +
        "api.github.com wants a User-Agent header. This answers your request msg_1."
    )
  })

  it("keeps Live Activity content flat for Swift Codable", () => {
    const content: LiveActivityContent = {
      title: "Building progress charts",
      detail: "Squat, bench and deadlift",
      next: "Rest timer",
      step: { current: 3, total: 5 },
      badge: "Day 3"
    }
    const { wire } = roundTrip(LiveActivityContent, content)
    assert.deepStrictEqual(wire, content)
  })

  it("tags push data", () => {
    const data = PushData.cases.Withdraw.make({ notificationIds: [Fixtures.cabinQuestion.notificationId!] })
    assert.deepStrictEqual(roundTrip(PushData, data).wire, {
      _tag: "Withdraw",
      notificationIds: ["0b6a2d1e-3c4f-4e5a-8b7c-9d0e1f2a3b4c"]
    })
  })
})

describe("CreateConnectLink", () => {
  it("sends expiresAt as an ISO string and accepts only Claude", () => {
    const link = {
      url: `https://dream.example.com${Routes.connect("claude")}?t=abc`,
      expiresAt: DateTime.makeUnsafe("2026-11-05T12:15:00Z")
    }
    const { wire, decoded } = roundTrip(ConnectLink, link)
    assert.deepStrictEqual(wire, {
      url: "https://dream.example.com/connect/claude?t=abc",
      expiresAt: "2026-11-05T12:15:00.000Z"
    })
    assert.deepStrictEqual(decoded, link)
    const rpc = AuthedAppRpcs.requests.get("CreateConnectLink")!
    const payload = Schema.toCodecJson(rpc.payloadSchema)
    assert.deepStrictEqual(Schema.decodeUnknownSync(payload)({ provider: "claude" }), { provider: "claude" })
    assert.isTrue(Exit.isFailure(Schema.decodeUnknownExit(payload)({ provider: "chatgpt" })))
  })
})

describe("validation", () => {
  const decodeAccess = Schema.decodeUnknownExit(Schema.toCodecJson(AccessRequest))

  it("requires {key} in a key access format", () => {
    const valid = {
      _tag: "Key",
      service: "Stripe",
      host: "api.stripe.com",
      header: "Authorization",
      format: "Bearer {key}"
    }
    assert.isTrue(Exit.isSuccess(decodeAccess(valid)))
    assert.isTrue(Exit.isFailure(decodeAccess({ ...valid, format: "Bearer" })))
  })

  it("accepts bare DNS names as key hosts, and says what's wrong with anything else", () => {
    for (const host of ["api.stripe.com", "discord.com", "API.Spotify.com", "xn--bcher-kva.example"]) {
      assert.isUndefined(accessHostProblem(host), host)
    }
    const problems: Array<[string, string]> = [
      ["spotify-oauth", "isn't a hostname that requests go to"],
      ["localhost", "isn't a hostname that requests go to"],
      ["", "is empty"],
      ["api.spotify .com", "contains spaces"],
      ["*.stripe.com", "is a wildcard; name the exact host the requests go to, like api.stripe.com"],
      ["https://api.spotify.com/v1/me", "should be just the hostname: --host api.spotify.com"],
      ["api.spotify.com:443", "should be just the hostname: --host api.spotify.com"],
      ["api.spotify.com/v1", "should be just the hostname: --host api.spotify.com"],
      ["10.0.0.1", "isn't a valid hostname"],
      ["-bad.example.com", "isn't a valid hostname"],
      ["api..example.com", "isn't a valid hostname"]
    ]
    for (const [host, problem] of problems) assert.include(accessHostProblem(host), problem, host)
  })

  it("still decodes a stored key card whose host is no hostname", () => {
    const stored = { _tag: "Key", service: "Spotify", host: "spotify-oauth", header: "X", format: "{key}" }
    assert.isTrue(Exit.isSuccess(decodeAccess(stored)))
  })

  it("takes file key names that are one plain path segment", () => {
    for (const name of ["telegram-bot-token", "smtp.password", "discord_bot", "a"]) {
      assert.isUndefined(keyFileNameProblem(name), name)
    }
    for (const name of ["", "../env", ".hidden", "Telegram", "a b", "a/b", "x".repeat(65), "$(id)"]) {
      assert.isDefined(keyFileNameProblem(name), name)
    }
    assert.strictEqual(keyFileNameFor("Telegram bot"), "telegram-bot")
    assert.strictEqual(keyFileNameFor("  SMTP (Fastmail) "), "smtp-fastmail")
    assert.strictEqual(keyFileNameFor("日本"), "key")
    assert.isUndefined(keyFileNameProblem(keyFileNameFor("x".repeat(80) + " y")))
  })

  it("decodes an OAuth request with or without its display name and scopes", () => {
    const fromCli = { _tag: "OAuth", provider: "spotify", scopes: ["user-read-private"] }
    assert.isTrue(Exit.isSuccess(decodeAccess(fromCli)))
    assert.isTrue(Exit.isSuccess(decodeAccess({ _tag: "OAuth", provider: "notion", service: "Notion", scopes: [] })))
    assert.isTrue(Exit.isFailure(decodeAccess({ ...fromCli, provider: "" })))
  })

  it("requires at least one Google scope", () => {
    assert.isTrue(Exit.isFailure(decodeAccess({ _tag: "Google", scopes: [] })))
  })

  it("bounds usage percentages", () => {
    const decode = Schema.decodeUnknownExit(Schema.toCodecJson(UsageSnapshot))
    const base = { provider: "claude", observedAt: DateTime.formatIso(DateTime.makeUnsafe(0)) }
    assert.isTrue(Exit.isSuccess(decode({ ...base, weekly: { usedPercent: 62 } })))
    assert.isTrue(Exit.isFailure(decode({ ...base, weekly: { usedPercent: 140 } })))
  })

  it("keeps the dev sign-in secret redacted after decoding", () => {
    const rpc = PublicAppRpcs.requests.get("DevSignIn")!
    const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(rpc.payloadSchema))({
      email: "omer@example.com",
      secret: "s3cret"
    }) as { readonly secret: Redacted.Redacted<string> }
    assert.isTrue(Redacted.isRedacted(decoded.secret))
    assert.strictEqual(Redacted.value(decoded.secret), "s3cret")
    assert.notInclude(String(decoded.secret), "s3cret")
  })
})
