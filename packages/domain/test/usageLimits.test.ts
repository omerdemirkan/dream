/**
 * Usage limits on a project, added in November 2026. The phone on someone's lock screen may be TestFlight build
 * 26858598, from before them: it must still decode the Status card, Home's rows, the usage sheet and their pushes,
 * and show a project paused by a limit as paused.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Option, Schema } from "effect"
import {
  AgentEvent,
  AppRpcs,
  type EventId,
  type NotificationId,
  ProjectSummary,
  ProjectUsage,
  PushData,
  reachedLimit,
  renderAgentEvent,
  StatusCard,
  UsageLimits
} from "../src/index.ts"
import * as Fixtures from "../src/fixtures.ts"

const wire = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: S["Type"]): unknown =>
  JSON.parse(JSON.stringify(Schema.encodeSync(Schema.toCodecJson(schema))(value)))
const decode = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema))(value)

// The shapes as build 26858598 knew them: no limits, no pausedBy, no OpenUsage.
const OldStatus = StatusCard.mapFields(({ pausedBy: _, ...rest }) => rest)
const OldSummary = ProjectSummary.mapFields(({ pausedBy: _, ...rest }) => rest)
const OldUsage = ProjectUsage.mapFields(({ weekWindow: _w, limits: _l, limitReached: _r, ...rest }) => rest)
const { OpenUsage: _, ...oldPushCases } = PushData.cases
const OldPushData = Schema.Union(Object.values(oldPushCases))

const at = DateTime.makeUnsafe("2026-11-08T12:00:00Z")
const resets = DateTime.makeUnsafe("2026-11-09T16:00:00Z")
const week = { usedPercent: 62, projectPercent: 21, resetsAt: resets }

describe("reachedLimit", () => {
  it("reaches the project's cap at its share, and the plan's floor at what's left", () => {
    assert.isUndefined(reachedLimit({}, week))
    assert.isUndefined(reachedLimit({ projectWeekPercent: 25 }, week))
    assert.deepStrictEqual(reachedLimit({ projectWeekPercent: 21 }, week), { limit: "project", percent: 21 })
    assert.isUndefined(reachedLimit({ planLeftPercent: 37 }, week))
    assert.deepStrictEqual(reachedLimit({ planLeftPercent: 38 }, week), { limit: "planLeft", percent: 38 })
    assert.deepStrictEqual(reachedLimit({ projectWeekPercent: 20, planLeftPercent: 40 }, week), {
      limit: "project",
      percent: 20
    })
    assert.isUndefined(reachedLimit({ projectWeekPercent: 1 }, undefined))
  })

  it("takes whole percents from 1 to 99", () => {
    assert.deepStrictEqual(decode(UsageLimits, { projectWeekPercent: 1, planLeftPercent: 99 }), {
      projectWeekPercent: 1,
      planLeftPercent: 99
    })
    for (const bad of [{ projectWeekPercent: 0 }, { planLeftPercent: 100 }, { projectWeekPercent: 12.5 }]) {
      assert.throws(() => decode(UsageLimits, bad))
    }
  })
})

describe("UsageLimitsChanged", () => {
  const event = (limits: UsageLimits, previous: UsageLimits) =>
    AgentEvent.cases.UsageLimitsChanged.make({
      id: "evt_limits" as EventId,
      at,
      limits,
      previous,
      week
    })

  it("says what the limits are, what happens at them, and where the project stands", () => {
    const text = renderAgentEvent(event({ projectWeekPercent: 30, planLeftPercent: 10 }, {}), {
      timeZone: "America/Los_Angeles"
    })
    assert.include(text, "They set the usage limits on this project: it may use up to 30% of their plan's week")
    assert.include(text, "Dream stops it when the plan has 10% of its week left")
    assert.include(text, "it has used about 21%, and the plan has 38% left; the week resets Mon, Nov 9, 8:00 AM.")
    assert.include(text, "`dream usage`")
    assert.include(renderAgentEvent(event({ planLeftPercent: 20 }, { planLeftPercent: 10 })), "They changed")
    assert.include(renderAgentEvent(event({}, { planLeftPercent: 10 })), "They cleared the usage limits")
  })

  it("round-trips", () => {
    const value = event({ projectWeekPercent: 30 }, {})
    assert.deepStrictEqual(decode(AgentEvent, wire(AgentEvent, value)), value)
  })
})

describe("usage limits in an app from before them", () => {
  it("shows a project a limit pauses as paused until the week resets", () => {
    const status: StatusCard = {
      ...Fixtures.liftLogStatus,
      pausedUntil: resets,
      pausedBy: { limit: "project", percent: 30 }
    }
    assert.deepStrictEqual(decode(StatusCard, wire(StatusCard, status)), status)
    const old = decode(OldStatus, wire(StatusCard, status))
    assert.deepStrictEqual(old.pausedUntil, resets)
    assert.notProperty(old, "pausedBy")

    const summary: ProjectSummary = {
      project: Fixtures.liftLog,
      openAsks: 0,
      pausedUntil: resets,
      pausedBy: { limit: "planLeft", percent: 10 }
    }
    assert.deepStrictEqual(decode(OldSummary, wire(ProjectSummary, summary)).pausedUntil, resets)
  })

  it("decodes the usage sheet with limits, and SetUsageLimits round-trips", () => {
    const usage: ProjectUsage = {
      provider: "claude",
      billing: "subscription",
      weekly: week,
      observedAt: at,
      today: {},
      fiveHour: {},
      week: { sharePercent: 21 },
      projects: [],
      weekWindow: week,
      limits: { projectWeekPercent: 30 },
      limitReached: { limit: "project", percent: 30 }
    }
    assert.deepStrictEqual(decode(ProjectUsage, wire(ProjectUsage, usage)), usage)
    assert.notProperty(decode(OldUsage, wire(ProjectUsage, usage)), "limits")
    const set = AppRpcs.requests.get("SetUsageLimits")!
    const payload = { projectId: Fixtures.liftLog.id, limits: { planLeftPercent: 15 } }
    assert.deepStrictEqual(decode(set.payloadSchema, wire(set.payloadSchema, payload)), payload)
  })

  it("leaves the paused push undecoded in an old app, whose tap then just opens Dream", () => {
    const push = PushData.cases.OpenUsage.make({
      projectId: Fixtures.liftLog.id,
      notificationId: "6f1c2b9e-3d4a-4c8b-9e7f-1a2b3c4d5e6f" as NotificationId
    })
    assert.deepStrictEqual(decode(PushData, wire(PushData, push)), push)
    assert.isTrue(Option.isNone(Schema.decodeUnknownOption(Schema.toCodecJson(OldPushData))(wire(PushData, push))))
  })
})
