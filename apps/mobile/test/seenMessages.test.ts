import { MessageId, NotificationId, ProjectId, PushData } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import {
  batchMs,
  dwellMs,
  emptySeen,
  notificationsAbout,
  type SeenState,
  stepSeen,
  visibleIds
} from "../src/data/seenMessages.ts"

const a = MessageId.make("msg_a")
const b = MessageId.make("msg_b")
const c = MessageId.make("msg_c")

/** Steps through `[now, visible]` pairs and collects every batch that went out. */
const run = (steps: ReadonlyArray<readonly [number, ReadonlyArray<MessageId>]>) => {
  let state: SeenState = emptySeen
  const batches: Array<ReadonlyArray<MessageId>> = []
  let wakeIn: number | undefined
  for (const [now, visible] of steps) {
    const step = stepSeen(state, visible, now)
    state = step.state
    wakeIn = step.wakeIn
    if (step.flush.length > 0) batches.push(step.flush)
  }
  return { batches, state, wakeIn }
}

describe("visibleIds", () => {
  const rows = [
    [a, { y: 0, height: 100 }],
    [b, { y: 150, height: 100 }],
    [c, { y: 300, height: 1000 }]
  ] as const

  it("counts rows mostly inside the window", () => {
    assert.deepStrictEqual(visibleIds(rows, { top: 0, bottom: 260 }), [a, b])
    // 30 of a's 100 points show: not enough.
    assert.deepStrictEqual(visibleIds(rows, { top: 70, bottom: 260 }), [b])
  })

  it("counts a row taller than the window when it fills most of it", () => {
    assert.deepStrictEqual(visibleIds(rows, { top: 400, bottom: 800 }), [c])
    assert.deepStrictEqual(visibleIds(rows, { top: 0, bottom: 400 }), [a, b])
  })

  it("counts nothing in an empty window or an unmeasured row", () => {
    assert.deepStrictEqual(visibleIds(rows, { top: 100, bottom: 100 }), [])
    assert.deepStrictEqual(visibleIds([[a, { y: 0, height: 0 }]], { top: 0, bottom: 100 }), [])
  })
})

describe("stepSeen", () => {
  it("counts a message that stays on screen for a moment, after the batch window", () => {
    const first = run([[0, [a]]])
    assert.deepStrictEqual(first.batches, [])
    assert.strictEqual(first.wakeIn, dwellMs)
    const later = run([
      [0, [a]],
      [dwellMs, [a]]
    ])
    assert.deepStrictEqual(later.batches, [])
    assert.strictEqual(later.wakeIn, batchMs)
    const done = run([
      [0, [a]],
      [dwellMs, [a]],
      [dwellMs + batchMs, [a]]
    ])
    assert.deepStrictEqual(done.batches, [[a]])
    assert.strictEqual(done.wakeIn, undefined)
  })

  it("ignores a message scrolled past", () => {
    const { batches, state } = run([
      [0, [a, b]],
      [100, [b]],
      [dwellMs, [b]],
      [dwellMs + 50, [a, b]],
      [dwellMs + batchMs, []]
    ])
    assert.deepStrictEqual(batches, [[b]])
    // a came back at dwellMs + 50, so its moment starts again.
    assert.isFalse(state.seen.has(a))
  })

  it("sends messages seen close together in one batch", () => {
    const { batches } = run([
      [0, [a]],
      [200, [a, b]],
      [dwellMs, [a, b]],
      [dwellMs + 200, [a, b]],
      [dwellMs + batchMs, [a, b]]
    ])
    assert.deepStrictEqual(batches, [[a, b]])
  })

  it("never sends a message twice", () => {
    const { batches } = run([
      [0, [a]],
      [dwellMs, [a]],
      [dwellMs + batchMs, [a]],
      [5000, []],
      [6000, [a]],
      [9000, [a]],
      [12000, [a]]
    ])
    assert.deepStrictEqual(batches, [[a]])
  })

  it("still sends what was seen after the screen goes away", () => {
    const { batches } = run([
      [0, [a]],
      [dwellMs, [a]],
      [dwellMs + 10, []],
      [dwellMs + batchMs, []]
    ])
    assert.deepStrictEqual(batches, [[a]])
  })

  it("counts nothing while nothing is on screen", () => {
    const { batches, wakeIn } = run([
      [0, []],
      [10000, []]
    ])
    assert.deepStrictEqual(batches, [])
    assert.strictEqual(wakeIn, undefined)
  })
})

describe("notificationsAbout", () => {
  const lift = ProjectId.make("prj_lift")
  const open = (identifier: string, messageId: MessageId) => ({
    identifier,
    data: Option.some(
      PushData.cases.OpenMessage.make({ projectId: lift, messageId, notificationId: NotificationId.make(identifier) })
    )
  })
  const presented = [
    open("6f1c2a54-3b8e-4d2f-9a1e-0c5b7d9e2f41", a),
    open("0b2d4f60-1a3c-4e5f-8a9b-1c2d3e4f5a6b", b),
    {
      identifier: "withdraw",
      data: Option.some(
        PushData.cases.Withdraw.make({ notificationIds: [NotificationId.make("6f1c2a54-3b8e-4d2f-9a1e-0c5b7d9e2f41")] })
      )
    },
    { identifier: "foreign", data: Option.none() }
  ]

  it("picks the notifications about the seen messages", () => {
    assert.deepStrictEqual(notificationsAbout(presented, [b]), ["0b2d4f60-1a3c-4e5f-8a9b-1c2d3e4f5a6b"])
  })

  it("ignores messages without a notification", () => {
    assert.deepStrictEqual(notificationsAbout(presented, [c]), [])
    assert.deepStrictEqual(notificationsAbout([], [a, b]), [])
  })
})
