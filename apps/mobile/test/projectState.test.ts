import type { Message, MessageId, TextMessage } from "@dream/domain"
import { ProjectEvent } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { addEarlier, applyEvent, type ProjectState } from "../src/data/projectState.ts"

const text = (id: string, iso: string): TextMessage => ({
  _tag: "Text",
  id: id as MessageId,
  projectId: Fx.liftLog.id,
  createdAt: DateTime.makeUnsafe(iso),
  from: "agent",
  text: id,
  media: []
})

const snapshot = (messages: ReadonlyArray<Message>, hasEarlierMessages = false) =>
  ProjectEvent.cases.Snapshot.make({
    project: Fx.liftLog,
    status: Fx.liftLogStatus,
    messages,
    hasEarlierMessages,
    working: false
  })

const ids = (state: ProjectState | undefined) => state?.messages.map((m) => m.id)

describe("applyEvent", () => {
  it("ignores changes until the first snapshot", () => {
    assert.isUndefined(applyEvent(undefined, ProjectEvent.cases.WorkingChanged.make({ working: true })))
  })

  it("keeps the agent's activity from the snapshot and its changes", () => {
    let state = applyEvent(undefined, snapshot([]))
    assert.isUndefined(state?.activity)
    const since = DateTime.makeUnsafe("2026-11-04T22:02:30Z")
    state = applyEvent(state, ProjectEvent.cases.ActivityChanged.make({ activity: { state: "working", since } }))
    assert.deepStrictEqual(state?.activity, { state: "working", since })
    assert.isTrue(state?.working)
    state = applyEvent(state, ProjectEvent.cases.ActivityChanged.make({ activity: { state: "idle", since } }))
    assert.isFalse(state?.working)
  })

  it("folds changes after a snapshot, in order", () => {
    let state = applyEvent(undefined, snapshot([text("a", "2026-11-04T10:00:00Z")]))
    state = applyEvent(state, ProjectEvent.cases.MessageAdded.make({ message: text("b", "2026-11-04T11:00:00Z") }))
    state = applyEvent(state, ProjectEvent.cases.WorkingChanged.make({ working: true }))
    assert.deepStrictEqual(ids(state), ["a", "b"])
    assert.isTrue(state?.working)
  })

  it("replaces a changed message in place", () => {
    const open = Fx.cabinQuestion
    let state = applyEvent(undefined, snapshot([open]))
    const answered = {
      ...open,
      state: {
        _tag: "Answered" as const,
        answer: { _tag: "Choice" as const, option: "First to ask" },
        answeredAt: open.createdAt
      }
    }
    state = applyEvent(state, ProjectEvent.cases.MessageChanged.make({ message: answered }))
    assert.strictEqual(state?.messages.length, 1)
    assert.strictEqual(state?.messages[0]?._tag === "Question" ? state.messages[0].state._tag : "", "Answered")
  })

  it("a reconnect snapshot replaces state but keeps loaded history older than it", () => {
    let state = applyEvent(undefined, snapshot([text("c", "2026-11-04T12:00:00Z")], true))
    state =
      state &&
      addEarlier(state, {
        messages: [text("b", "2026-11-04T11:00:00Z"), text("a", "2026-11-04T10:00:00Z")],
        hasEarlier: false
      })
    assert.deepStrictEqual(ids(state), ["a", "b", "c"])
    assert.isFalse(state?.hasEarlierMessages)
    state = applyEvent(state, snapshot([text("c", "2026-11-04T12:00:00Z"), text("d", "2026-11-04T13:00:00Z")], true))
    assert.deepStrictEqual(ids(state), ["a", "b", "c", "d"])
    assert.isFalse(state?.hasEarlierMessages)
  })

  it("a snapshot that needs no earlier history drops what came before", () => {
    let state = applyEvent(undefined, snapshot([text("a", "2026-11-04T10:00:00Z")]))
    state = applyEvent(state, snapshot([text("z", "2026-11-04T14:00:00Z")]))
    assert.deepStrictEqual(ids(state), ["z"])
  })

  it("takes the header's usage from Usage events, and keeps it through a new snapshot", () => {
    const usage = {
      provider: "chatgpt",
      billing: "subscription",
      weekly: { usedPercent: 38, projectPercent: 4 },
      observedAt: DateTime.makeUnsafe("2026-11-04T22:10:00Z")
    } as const
    let state = applyEvent(undefined, snapshot([]))
    assert.isUndefined(state?.usage)
    state = applyEvent(state, ProjectEvent.cases.Usage.make({ usage }))
    assert.deepStrictEqual(state?.usage, usage)
    state = applyEvent(state, snapshot([text("a", "2026-11-04T10:00:00Z")]))
    assert.deepStrictEqual(state?.usage, usage)
  })
})
