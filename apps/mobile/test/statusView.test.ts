import type { Message } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import type { ProjectState } from "../src/data/projectState.ts"
import { makeWorld, mockNow } from "../src/fake/fixtures.ts"
import { cardOf, trackOf } from "../src/ui/statusView.ts"

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
