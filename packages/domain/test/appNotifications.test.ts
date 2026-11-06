/**
 * App notifications on the wire: the sender and its history, the opt-in card, the push the phone decodes, the
 * agent's events, and the shapes old clients have to tolerate.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Exit, Schema } from "effect"
import {
  AccessMessage,
  accessHeading,
  AgentEvent,
  AppId,
  AppName,
  AppNotification,
  AppNotifications,
  AppNotificationText,
  AppNotificationTitle,
  AppSender,
  askHeadline,
  Message,
  PushData,
  reachedPhone,
  renderAgentEvent,
  SandboxRpcs
} from "../src/index.ts"
import * as Fixtures from "../src/fixtures.ts"

const roundTrip = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: S["Type"]) => {
  const codec = Schema.toCodecJson(schema)
  const wire = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(value)))
  return { wire, decoded: Schema.decodeUnknownSync(codec)(wire) }
}

const decodes = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(Schema.toCodecJson(schema))(value))

describe("app notifications", () => {
  it("round-trips a sender, its history and the opt-in card", () => {
    assert.deepStrictEqual(roundTrip(AppSender, Fixtures.morningBriefApp).decoded, Fixtures.morningBriefApp)
    const list = { apps: [Fixtures.morningBriefApp], notifications: Fixtures.morningBriefAppNotifications }
    const { wire, decoded } = roundTrip(AppNotifications, list)
    assert.deepStrictEqual(decoded, list)
    assert.strictEqual(wire.notifications[0].sentAt, "2026-11-04T15:00:00.000Z")
    assert.isFalse("held" in wire.notifications[0])
    assert.deepStrictEqual(
      roundTrip(Message, Fixtures.morningBriefNotificationsCard).decoded,
      Fixtures.morningBriefNotificationsCard
    )
  })

  it("app ids are lowercase words joined by hyphens", () => {
    for (const ok of ["fare-watch", "brief", "a1-b2"]) assert.isTrue(decodes(AppId, ok), ok)
    for (const bad of ["Fare-watch", "fare_watch", "-fare", "fare-", "fare--watch", "", "x".repeat(41)]) {
      assert.isFalse(decodes(AppId, bad), bad)
    }
  })

  it("names, titles and text have limits the lock screen can show", () => {
    assert.isTrue(decodes(AppName, "Fare watch"))
    assert.isFalse(decodes(AppName, " Fare watch"))
    assert.isFalse(decodes(AppName, "Fare\nwatch"))
    assert.isFalse(decodes(AppName, "x".repeat(31)))
    assert.isFalse(decodes(AppNotificationTitle, "Two\nlines"))
    assert.isFalse(decodes(AppNotificationTitle, "x".repeat(81)))
    assert.isTrue(decodes(AppNotificationText, "x".repeat(500)))
    assert.isFalse(decodes(AppNotificationText, "x".repeat(501)))
    assert.isFalse(decodes(AppNotificationText, ""))
  })

  it("the card's heading names the app, and the lock screen reads it whole", () => {
    const card = Fixtures.morningBriefNotificationsCard
    assert.deepStrictEqual(accessHeading(card), {
      title: "Let Morning Brief notify you",
      reason: "When today’s digest is ready"
    })
    assert.strictEqual(askHeadline(card), "Let Morning Brief notify you: When today’s digest is ready")
    const open = AccessMessage.make({ ...card, state: { _tag: "Open" } })
    assert.deepStrictEqual(roundTrip(Message, open).decoded, open)
  })

  it("an app's push carries where a tap goes", () => {
    const push = PushData.cases.OpenApp.make({
      projectId: Fixtures.morningBrief.id,
      app: Fixtures.morningBriefApp.id,
      notificationId: Fixtures.morningBriefAppNotifications[0]!.id,
      url: "https://morning-brief-k3x9q2.dream.example/digest/2026-11-04"
    })
    const { wire, decoded } = roundTrip(PushData, push)
    assert.strictEqual(wire._tag, "OpenApp")
    assert.deepStrictEqual(decoded, push)
  })

  it("an outcome says whether it reached their phone", () => {
    assert.deepStrictEqual(AppNotification.fields.outcome.literals.filter(reachedPhone), ["sent", "quiet"])
  })

  it("renders the agent's events in plain words", () => {
    const at = DateTime.makeUnsafe("2026-11-04T15:00:00Z")
    const base = { id: "evt_a" as AgentEvent["id"], at, app: "fare-watch" as AppId, name: "Fare watch" }
    const allowed = renderAgentEvent(AgentEvent.cases.AppNotificationsChanged.make({ ...base, change: "allowed" }))
    assert.include(allowed, "They allowed Fare watch (fare-watch) to notify them")
    assert.include(allowed, "dream notify --app fare-watch")
    const declined = renderAgentEvent(
      AgentEvent.cases.AppNotificationsChanged.make({ ...base, change: "declined", reason: "Only under $400" })
    )
    assert.include(declined, "> Only under $400")
    const muted = renderAgentEvent(
      AgentEvent.cases.AppNotificationsChanged.make({
        ...base,
        change: "muted",
        until: DateTime.makeUnsafe("2026-11-05T15:00:00Z")
      }),
      { timeZone: "America/Los_Angeles" }
    )
    assert.include(muted, "muted Fare watch (fare-watch) until Thu, Nov 5, 7:00 AM")
    const held = renderAgentEvent(AgentEvent.cases.AppNotificationsHeld.make({ ...base, limit: "hour" }))
    assert.include(held, "limit of 6 notifications an hour")
  })

  it("the agent's calls decode with only what the CLI sends", () => {
    const send = SandboxRpcs.requests.get("SendAppNotification")!
    assert.isTrue(
      decodes(send.payloadSchema, { app: "fare-watch", text: "Lisbon is $412.", quiet: false, dryRun: false })
    )
    assert.isFalse(decodes(send.payloadSchema, { app: "fare-watch", text: "", quiet: false, dryRun: false }))
  })
})
