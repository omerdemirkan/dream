import type { Message, WorkstreamId } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import type { ProjectState } from "../src/data/projectState.ts"
import { liftWorkstreams, makeWorld, mockNow, type WorkstreamsStage } from "../src/fake/fixtures.ts"
import { cardOf, labelsOf, trackOf } from "../src/ui/statusView.ts"

const world = makeWorld(mockNow)
const stateOf = (slug: string, change: Partial<ProjectState> = {}): ProjectState => {
  const p = world.projects.find((x) => x.project.slug === slug)
  if (!p) throw new Error(slug)
  return { ...p, hasEarlierMessages: false, ...change }
}

describe("the Status card over Chat", () => {
  it("working: the now sentence and the track, and no amber line for a need that's later", () => {
    const card = cardOf(stateOf("lift-log"), mockNow)
    assert.strictEqual(card.stand, "now")
    assert.strictEqual(card.text, "Charting your estimated 1RM")
    assert.strictEqual(card.track?.position, 3)
    assert.strictEqual(card.track?.states.length, 5)
    assert.isUndefined(card.need)
  })

  it("needs you: the first open ask is one amber line, named by the need it's pinned to", () => {
    const card = cardOf(stateOf("cabin"), mockNow)
    assert.strictEqual(card.need?.ask.id, "msg_cabinrule")
    assert.strictEqual(card.need?.text, "Needs a rule for double-booked weekends")
    assert.strictEqual(card.need?.more, 2)
    assert.strictEqual(card.track?.position, 1)
  })

  it("an ask that isn't pinned names what it asks for", () => {
    const brief = stateOf("morning-brief")
    const unpinned = { ...brief, status: { ...brief.status, milestones: [] } }
    assert.strictEqual(cardOf(unpinned, mockNow).need?.text, "Needs your Telegram key")
  })

  it("before any Status: the last thing the agent said, else the early note", () => {
    const lift = stateOf("lift-log")
    const { now: _now, ...rest } = lift.status
    const blank = { ...rest, milestones: [] }
    const said = cardOf({ ...lift, status: blank }, mockNow)
    assert.strictEqual(said.stand, "latest")
    const idea: ReadonlyArray<Message> = lift.messages.slice(0, 1)
    const early = cardOf({ ...lift, status: blank, messages: idea }, mockNow)
    assert.strictEqual(early.stand, "early")
    assert.match(early.text, /looking into this/)
  })

  it("a log of runs has no track", () => {
    assert.isUndefined(cardOf(stateOf("morning-brief"), mockNow).track)
  })

  it("paused", () => {
    const lift = stateOf("lift-log")
    const card = cardOf(
      { ...lift, status: { ...lift.status, pausedUntil: DateTime.add(mockNow, { hours: 2 }) } },
      mockNow
    )
    assert.isTrue(card.paused)
  })

  it("every milestone done fills the track", () => {
    const lift = stateOf("lift-log")
    const done = lift.status.milestones.map((m) => ({ ...m, state: "done" as const }))
    assert.strictEqual(trackOf(done)?.position, 5)
  })
})

describe("workstreams on the card", () => {
  /** Lift Log in one of the workstream states, as the fixtures backend's scenarios put it. */
  const liftIn = (stage: WorkstreamsStage): ProjectState => {
    const lift = stateOf("lift-log")
    const latest = lift.messages.at(-1)!.createdAt
    const { workstreams, labels, added } = liftWorkstreams(stage, lift.project.id, latest)
    return {
      ...lift,
      status: { ...lift.status, workstreams },
      messages: [
        ...lift.messages.map((m) => {
          const label = labels.get(m.id)
          return label === undefined ? m : { ...m, workstream: label }
        }),
        ...added
      ]
    }
  }

  it("none, or one active: the card is the sentence and the track, and nothing is labeled", () => {
    for (const state of [stateOf("lift-log"), liftIn("one")]) {
      const card = cardOf(state, mockNow)
      assert.isUndefined(card.rows)
      assert.strictEqual(card.text, "Charting your estimated 1RM")
      assert.strictEqual(card.track?.position, 3)
      assert.isUndefined(labelsOf(state.status))
    }
  })

  it("three in flight (A1): a row each, and the Health import folded", () => {
    const state = liftIn("three")
    const rows = cardOf(state, mockNow).rows!
    assert.deepStrictEqual(
      rows.rows.map((r) => [r.title, r.line, r.waiting?.id]),
      [
        ["Progress charts", "Charting estimated 1RM for each lift", undefined],
        ["Rest timer", "Wiring it into a Live Activity", undefined],
        ["Android?", "Finding out what it would take", undefined]
      ]
    )
    assert.isUndefined(rows.more)
    assert.deepStrictEqual(rows.done, { text: "Health import · 214 workouts from a sample export", others: 0 })
    assert.strictEqual(labelsOf(state.status)?.get("ws_android" as WorkstreamId), "Android?")
  })

  it("one waits on them (A2): its row is amber, at the top, with the question, and it isn't a second amber line", () => {
    const card = cardOf(liftIn("waiting"), mockNow)
    const [first] = card.rows!.rows
    assert.strictEqual(first?.title, "Rest timer")
    assert.strictEqual(first?.waiting?.id, "msg_wssound")
    assert.strictEqual(first?.line, "Which sound should the rest timer end with?")
    assert.strictEqual(card.need?.ask.id, "msg_wssound")
    assert.isUndefined(card.looseNeed)
    assert.strictEqual(card.rows!.done?.text, "Progress charts · Estimated 1RM on every chart")
  })

  it("five active: two rows and the rest summed up", () => {
    const rows = cardOf(liftIn("many"), mockNow).rows!
    assert.deepStrictEqual(
      rows.rows.map((r) => r.title),
      ["Progress charts", "Rest timer"]
    )
    assert.deepStrictEqual(rows.more, { text: "3 more: Android?, Onboarding, Lock Screen widget", waiting: false })
    assert.strictEqual(rows.all.length, 5)
  })

  it("an ask outside any workstream still gets the amber line under the rows", () => {
    const state = liftIn("three")
    const loose = { ...Fx.cabinQuestion, projectId: state.project.id, createdAt: mockNow }
    const card = cardOf({ ...state, messages: [...state.messages, loose] }, mockNow)
    assert.strictEqual(card.looseNeed?.ask.id, loose.id)
  })
})
