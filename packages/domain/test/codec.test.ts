/**
 * Every RPC payload is encoded with `Schema.toCodecJson` and sent as JSON.
 * These tests push representative values through exactly that path.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Exit, Schema } from "effect"
import {
  AccessRequest,
  AgentEvent,
  IntegrationAccess,
  LiveActivityContent,
  Message,
  ProjectEvent,
  ProjectSummary,
  PushData,
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

  it("requires at least one Google scope", () => {
    assert.isTrue(Exit.isFailure(decodeAccess({ _tag: "Google", scopes: [] })))
  })

  it("bounds usage percentages", () => {
    const decode = Schema.decodeUnknownExit(Schema.toCodecJson(UsageSnapshot))
    const base = { provider: "claude", observedAt: DateTime.formatIso(DateTime.makeUnsafe(0)) }
    assert.isTrue(Exit.isSuccess(decode({ ...base, weekly: { usedPercent: 62 } })))
    assert.isTrue(Exit.isFailure(decode({ ...base, weekly: { usedPercent: 140 } })))
  })
})
