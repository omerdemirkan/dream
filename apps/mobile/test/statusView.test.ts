import type { Message } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import type { ProjectState } from "../src/data/projectState.ts"
import { makeWorld, mockNow } from "../src/fake/fixtures.ts"
import { cardOf, neededLabel, trackOf } from "../src/ui/statusView.ts"

const world = makeWorld(mockNow)
const stateOf = (slug: string, change: Partial<ProjectState> = {}): ProjectState => {
  const p = world.projects.find((x) => x.project.slug === slug)
  if (!p) throw new Error(slug)
  return { ...p, hasEarlierMessages: false, ...change }
}

describe("the Status card over Chat", () => {
  it("working: the now line, the track and the next need", () => {
    const card = cardOf(stateOf("lift-log"), mockNow)
    assert.strictEqual(card._tag, "Status")
    if (card._tag !== "Status") return
    assert.strictEqual(card.label, "Now")
    assert.strictEqual(card.text, "Building progress charts for squat, bench and deadlift.")
    assert.deepStrictEqual(card.track && { title: card.track.title, position: card.track.position }, {
      title: "Progress charts",
      position: 3
    })
    assert.strictEqual(card.track?.states.length, 5)
    assert.deepStrictEqual(card.need, { what: "Your Apple Developer account", when: "around Thursday" })
    assert.strictEqual(neededLabel("around Thursday"), "needed around Thursday")
  })

  it("needs you: the first open ask leads and the rest are named by their needs", () => {
    const card = cardOf(stateOf("cabin"), mockNow)
    assert.strictEqual(card._tag, "Needs")
    if (card._tag !== "Needs") return
    assert.strictEqual(card.ask.id, "msg_cabinrule")
    assert.strictEqual(card.count, 3)
    assert.deepStrictEqual(card.also, ["Your pick of the three", "Google Calendar"])
    assert.strictEqual(card.track?.title, "Prototypes")
  })

  it("a later access request is a need ahead, not an ask", () => {
    const card = cardOf(stateOf("lift-log"), mockNow)
    assert.notStrictEqual(card._tag, "Needs")
  })

  it("before any Status: the last thing the agent said, else the early note", () => {
    const lift = stateOf("lift-log")
    const { now: _now, justDid: _justDid, ...rest } = lift.status
    const blank = { ...rest, milestones: [] }
    const said = cardOf({ ...lift, status: blank }, mockNow)
    assert.strictEqual(said._tag, "Status")
    if (said._tag === "Status") assert.strictEqual(said.label, "Latest in Chat")
    const idea = lift.messages.slice(0, 1)
    const early = cardOf({ ...lift, status: blank, messages: idea }, mockNow)
    assert.strictEqual(early._tag, "Early")
    if (early._tag === "Early") assert.match(early.text, /looking into this/)
  })

  it("a log of runs has no track; its latest run stands in for now", () => {
    const brief = stateOf("morning-brief")
    const messages = brief.messages.filter((m: Message) => m._tag === "Text")
    const card = cardOf({ ...brief, messages }, mockNow)
    assert.strictEqual(card._tag, "Status")
    if (card._tag !== "Status") return
    assert.isUndefined(card.track)
    assert.strictEqual(card.label, "Latest")
    assert.match(card.text, /Sent today’s digest/)
  })

  it("paused says until when", () => {
    const lift = stateOf("lift-log")
    const card = cardOf(
      { ...lift, status: { ...lift.status, pausedUntil: DateTime.add(mockNow, { hours: 2 }) } },
      mockNow
    )
    assert.strictEqual(card._tag, "Status")
    if (card._tag === "Status") {
      assert.isTrue(card.paused)
      assert.match(card.label, /^Paused until /)
    }
  })

  it("every milestone done reads as all done", () => {
    const lift = stateOf("lift-log")
    const done = lift.status.milestones.map((m) => ({ ...m, state: "done" as const }))
    assert.deepStrictEqual(trackOf(done)?.title, "All done")
  })
})
