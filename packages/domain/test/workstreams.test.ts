/**
 * Workstreams: the shapes on the wire, what older builds make of them, and how the card lays them out.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import {
  AgentEvent,
  cardRows,
  doneLine,
  type EventId,
  type Message,
  type MessageId,
  moreLine,
  ProjectEvent,
  QuestionMessage,
  renderAgentEvent,
  RowsOnCard,
  rowOnCard,
  SandboxRpcs,
  StatusCard,
  TextMessage,
  type Workstream,
  type WorkstreamId,
  Workstreams,
  WorkstreamTitleMaxLength,
  workstreamWaits
} from "../src/index.ts"
import * as Fixtures from "../src/fixtures.ts"

const at = (iso: string) => DateTime.makeUnsafe(iso)
const now = at("2026-11-04T22:10:00Z")

const roundTrip = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: S["Type"]) => {
  const codec = Schema.toCodecJson(schema)
  const wire = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(value)))
  return { wire, decoded: Schema.decodeUnknownSync(codec)(wire) }
}

const status: StatusCard = { ...Fixtures.liftLogStatus, workstreams: Fixtures.liftLogWorkstreams }
const [charts, timer, android, health] = Fixtures.liftLogWorkstreams as [Workstream, Workstream, Workstream, Workstream]

const question = (id: string, workstream: WorkstreamId | undefined, state: QuestionMessage["state"]): Message =>
  QuestionMessage.make({
    id: id as MessageId,
    projectId: Fixtures.liftLog.id,
    createdAt: at("2026-11-04T22:00:00Z"),
    question: "Which sound should the rest timer end with?",
    options: ["A soft chime", "Three short buzzes"],
    state,
    ...(workstream === undefined ? {} : { workstream })
  })

describe("the wire", () => {
  it("round-trips a Status card with workstreams, and a labeled message", () => {
    const { wire, decoded } = roundTrip(StatusCard, status)
    assert.deepStrictEqual(decoded, status)
    assert.strictEqual(wire.workstreams[3].endedAt, "2026-11-04T21:40:00.000Z")
    const labeled = { ...Fixtures.liftLogUpdate, workstream: health.id }
    assert.deepStrictEqual(roundTrip(TextMessage, labeled).decoded, labeled)
  })

  it("leaves both out when there are none", () => {
    assert.isFalse("workstreams" in roundTrip(StatusCard, Fixtures.liftLogStatus).wire)
    assert.isFalse("workstream" in roundTrip(TextMessage, Fixtures.liftLogUpdate).wire)
  })

  it("decodes in builds that predate it: the extra keys are dropped", () => {
    // What an app or dreamd from before workstreams declares.
    const OldStatus = StatusCard.mapFields(({ workstreams: _, ...rest }) => rest)
    const OldText = TextMessage.mapFields(({ workstream: _, ...rest }) => rest)
    const card = Schema.decodeUnknownSync(Schema.toCodecJson(OldStatus))(roundTrip(StatusCard, status).wire)
    assert.isFalse("workstreams" in card)
    assert.strictEqual(card.now, status.now)
    const text = Schema.decodeUnknownSync(Schema.toCodecJson(OldText))(
      roundTrip(TextMessage, { ...Fixtures.liftLogUpdate, workstream: charts.id }).wire
    )
    assert.isFalse("workstream" in text)
    const event = ProjectEvent.cases.StatusChanged.make({ status })
    assert.deepStrictEqual(roundTrip(ProjectEvent, event).decoded, event)
  })

  it("round-trips what `dream work` gets back, and the new RPC payloads", () => {
    const report = {
      workstreams: Fixtures.liftLogWorkstreams,
      waiting: [{ workstream: timer.id, messageId: "msg_sound" as MessageId }]
    }
    assert.deepStrictEqual(roundTrip(Workstreams, report).decoded, report)
    const start = SandboxRpcs.requests.get("StartWorkstream")!
    assert.deepStrictEqual(roundTrip(start.payloadSchema, { title: "Android?", from: "msg_x" as MessageId }).decoded, {
      title: "Android?",
      from: "msg_x" as MessageId
    })
    const send = SandboxRpcs.requests.get("SendMessage")!
    const payload = { text: "Charts are in.", media: [], notify: false, workstream: charts.id }
    assert.deepStrictEqual(roundTrip(send.payloadSchema, payload).decoded, payload)
  })

  it("refuses a title past the limit", () => {
    const start = SandboxRpcs.requests.get("StartWorkstream")!
    assert.throws(() =>
      Schema.decodeUnknownSync(Schema.toCodecJson(start.payloadSchema))({
        title: "x".repeat(WorkstreamTitleMaxLength + 1)
      })
    )
  })

  it("names the workstream a message was written into, in the turn prompt", () => {
    const fields = { id: "evt_1" as EventId, at: at("2026-11-04T22:02:00Z"), messageId: "msg_q" as MessageId }
    const plain = AgentEvent.cases.UserMessage.make({ ...fields, text: "And Android?" })
    const into = AgentEvent.cases.UserMessage.make({
      ...fields,
      text: "Only if it doesn't slow down iPhone",
      workstream: { id: android.id, title: android.title }
    })
    assert.strictEqual(renderAgentEvent(plain), "[Wed, Nov 4, 10:02 PM] They wrote (msg_q):\n> And Android?")
    assert.strictEqual(
      renderAgentEvent(into),
      '[Wed, Nov 4, 10:02 PM] They wrote (msg_q) into your workstream "Android?" (ws_android):\n' +
        "> Only if it doesn't slow down iPhone"
    )
    assert.deepStrictEqual(roundTrip(AgentEvent, into).decoded, into)
  })
})

describe("the card", () => {
  it("keeps the sentence with one active workstream or none", () => {
    assert.isUndefined(cardRows(undefined, [], now))
    assert.isUndefined(cardRows([], [], now))
    assert.isUndefined(cardRows([charts, health], [], now))
  })

  it("shows a row for each in the order they started, and folds the finished one", () => {
    const card = cardRows(status.workstreams, [], now)!
    assert.deepStrictEqual(
      card.rows.map((r) => r.workstream.title),
      ["Progress charts", "Rest timer", "Android?"]
    )
    assert.deepStrictEqual(card.more, [])
    assert.deepStrictEqual(doneLine(card.done), {
      text: "Health import · 214 workouts from a sample export",
      others: 0
    })
  })

  it("moves a row waiting on them to the top", () => {
    const messages = [
      question("msg_old", timer.id, {
        _tag: "Answered",
        answer: { _tag: "Choice", option: "A soft chime" },
        answeredAt: now
      }),
      question("msg_sound", timer.id, { _tag: "Open" }),
      question("msg_loose", undefined, { _tag: "Open" })
    ]
    const waits = workstreamWaits(messages)
    assert.deepStrictEqual(waits, [{ workstream: timer.id, messageId: "msg_sound" as MessageId }])
    const card = cardRows(status.workstreams, waits, now)!
    assert.deepStrictEqual(
      card.rows.map((r) => [r.workstream.title, r.waitingOn]),
      [
        ["Rest timer", "msg_sound"],
        ["Progress charts", undefined],
        ["Android?", undefined]
      ]
    )
  })

  it(`sums up past ${RowsOnCard} rows`, () => {
    const more = ["Onboarding", "Search"].map(
      (title, i): Workstream => ({
        ...charts,
        id: `ws_more${i}` as WorkstreamId,
        title,
        startedAt: at(`2026-11-04T22:0${7 + i}:00Z`)
      })
    )
    const card = cardRows([...Fixtures.liftLogWorkstreams, ...more], [], now)!
    assert.strictEqual(card.rows.length, RowsOnCard - 1)
    assert.strictEqual(moreLine(card.more), "3 more: Android?, Onboarding, Search")
  })

  it("lets finished ones go after a few days, and dropped ones at once", () => {
    const later = at("2026-11-09T12:00:00Z")
    assert.deepStrictEqual(cardRows(status.workstreams, [], later)!.done, [])
    const dropped: Workstream = { ...health, state: "dropped" }
    assert.deepStrictEqual(cardRows([charts, timer, dropped], [], now)!.done, [])
  })

  it("says what a row shows, cut where it runs past one line", () => {
    assert.deepStrictEqual(rowOnCard(charts), {
      title: "Progress charts",
      now: "Charting estimated 1RM for each lift",
      whole: true
    })
    const long = rowOnCard({
      title: "Progress charts for every lift you log",
      now: "Charting estimated one-rep max for squat, bench, deadlift and overhead press"
    })
    assert.isFalse(long.whole)
    assert.isTrue(long.now!.endsWith("…"))
  })
})
