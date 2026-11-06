/**
 * The agent's presence as Chat, the project header and Home show it (Deck v3, A+B+C), in the mock's scenario: at
 * 2:02 PM, with Lift Log asleep, they ask about estimated 1RM; its computer starts, it works, and replies at 2:09.
 */
import type { AgentActivity, Message, MessageId, TextMessage } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import {
  aheadLabel,
  chatRowOf,
  dotOf,
  elapsedLabel,
  headerLine,
  homeLine,
  type Presence,
  presenceOf,
  receiptOf
} from "../src/data/presence.ts"

const tz = "America/Los_Angeles"
// 2:02 PM in Los Angeles on Nov 4, 2026.
const at = (hhmm: string, day = "04") => DateTime.makeUnsafe(`2026-11-${day}T${hhmm}:00-08:00`)

const text = (id: string, from: "user" | "agent", time: DateTime.Utc, seenAt?: DateTime.Utc): TextMessage => ({
  _tag: "Text",
  id: id as MessageId,
  projectId: Fx.liftLog.id,
  createdAt: time,
  from,
  text: id,
  media: [],
  ...(seenAt ? { seenAt } : {})
})

const update = text("update", "agent", at("13:40"))
const ask = text("ask", "user", at("14:02"))
const askSeen = text("ask", "user", at("14:02"), at("14:02"))
const reply = text("reply", "agent", at("14:09"))

const presence = (
  activity: AgentActivity | undefined,
  now: DateTime.Utc,
  extra: Partial<{ working: boolean; pausedUntil: DateTime.Utc }> = {}
) => presenceOf({ activity, now, working: extra.working ?? false, pausedUntil: extra.pausedUntil })

const context = (now: DateTime.Utc, messages: ReadonlyArray<Message>, openAsks = 0) => ({
  now,
  harness: "claude-code" as const,
  openAsks,
  timeZone: tz,
  messages,
  headline: "Three prototypes are ready for your reaction."
})

const asleep: AgentActivity = { state: "idle", since: at("11:00"), awakeUntil: at("11:05") }
const starting: AgentActivity = { state: "starting", since: at("14:02") }
const working: AgentActivity = { state: "working", since: at("14:02") }
const done: AgentActivity = { state: "idle", since: at("14:09"), awakeUntil: at("14:14") }

const line = (l: { lead: string; rest?: string | undefined } | undefined) =>
  l === undefined ? undefined : l.rest ? `${l.lead} · ${l.rest}` : l.lead

describe("presence through one message (A+B+C)", () => {
  it("right after sending: Sent, typing dots, and the header admits it's asleep and waking", () => {
    const now = at("14:02")
    const messages = [update, ask]
    const p = presence(asleep, now)
    assert.strictEqual(p._tag, "Asleep")
    assert.strictEqual(dotOf(p), "asleep")
    assert.deepStrictEqual(receiptOf(messages, asleep), { messageId: ask.id, seen: false })
    assert.deepStrictEqual(chatRowOf(p, messages, now), { _tag: "Sent" })
    assert.strictEqual(line(headerLine(p, context(now, messages))), "Asleep · waking up")
  })

  it("starting: Seen once a turn takes it; the row says what's happening and how long it takes", () => {
    const now = at("14:02")
    const p = presence(starting, now)
    assert.strictEqual(dotOf(p), "starting")
    assert.deepStrictEqual(chatRowOf(p, [update, ask], now), { _tag: "Starting", fresh: false })
    assert.deepStrictEqual(headerLine(p, context(now, [update, ask])), { lead: "Starting up", strong: true })
    assert.strictEqual(line(homeLine(p, context(now, [update, ask]))), "Starting its computer…")
  })

  it("working: a white pulse and the elapsed time, in the header, the row and on Home", () => {
    const now = at("14:04")
    const messages = [update, askSeen]
    const p = presence(working, now)
    assert.strictEqual(dotOf(p), "working")
    assert.deepStrictEqual(receiptOf(messages, working), { messageId: ask.id, seen: true })
    assert.deepStrictEqual(chatRowOf(p, messages, now), { _tag: "Working", since: at("14:02") })
    assert.strictEqual(line(headerLine(p, context(now, messages))), "Working · 2m")
    assert.strictEqual(line(homeLine(p, context(now, messages))), "Working · 2m")
  })

  it("replied: Done for now under the reply, a green dot, and the receipt stays Seen", () => {
    const now = at("14:09")
    const messages = [update, askSeen, reply]
    const p = presence(done, now)
    assert.strictEqual(dotOf(p), "awake")
    assert.deepStrictEqual(chatRowOf(p, messages, now), { _tag: "Done" })
    assert.deepStrictEqual(receiptOf(messages, done), { messageId: ask.id, seen: true })
    assert.strictEqual(line(headerLine(p, context(now, messages))), "Done for now · replied 2:09 PM")
    assert.strictEqual(line(homeLine(p, context(now, messages))), "Done for now · 2:09 PM")
  })

  it("goes grey when its computer sleeps, and keeps the headline on Home when nothing's scheduled", () => {
    const now = at("14:20")
    const p = presence(done, now)
    assert.strictEqual(dotOf(p), "asleep")
    assert.deepStrictEqual(chatRowOf(p, [update, askSeen, reply], now), { _tag: "Done" })
    assert.isUndefined(homeLine(p, context(now, [])))
    assert.strictEqual(line(headerLine(p, context(now, []))), "Asleep")
  })

  it("a new idea's first half-minute: Seen, starting, and permission to leave", () => {
    const idea = text("idea", "user", at("14:12"), at("14:12"))
    const p = presence({ state: "starting", since: at("14:12") }, at("14:12"))
    assert.deepStrictEqual(chatRowOf(p, [idea], at("14:12")), { _tag: "Starting", fresh: true })
  })
})

describe("Home (B)", () => {
  const now = at("14:12")

  it("says asleep until the next wake, paused until the reset, and waiting while something's open", () => {
    const brief = presence({ ...asleep, nextWakeAt: at("06:55", "05") }, now)
    assert.strictEqual(line(homeLine(brief, context(now, []))), "Asleep · wakes 6:55 AM")

    const recipe = presence(asleep, now, { pausedUntil: at("16:00") })
    assert.strictEqual(dotOf(recipe), "paused")
    assert.strictEqual(line(homeLine(recipe, context(now, [], 1))), "Paused · Claude usage resets 4 PM")
    assert.strictEqual(
      line(homeLine(recipe, { ...context(now, [], 1), harness: "codex" })),
      "Paused · ChatGPT usage resets 4 PM"
    )

    const cabin = presence({ state: "idle", since: at("14:10"), awakeUntil: at("14:15") }, now)
    assert.strictEqual(dotOf(cabin), "awake")
    assert.strictEqual(
      line(homeLine(cabin, context(now, [], 2))),
      "Waiting for you · Three prototypes are ready for your reaction."
    )
  })

  it("puts working ahead of waiting and paused", () => {
    const p = presence(working, at("14:05"), { pausedUntil: at("16:00") })
    assert.strictEqual(line(homeLine(p, context(at("14:05"), [], 3))), "Working · 3m")
  })
})

describe("edges", () => {
  it("falls back to the working flag from an API that sends no activity, and shows no receipts", () => {
    const now = at("14:03")
    assert.deepStrictEqual(presence(undefined, now, { working: true }), { _tag: "Working", since: undefined })
    assert.strictEqual(line(homeLine(presence(undefined, now, { working: true }), context(now, []))), "Working")
    const idle: Presence = presence(undefined, now)
    assert.strictEqual(dotOf(idle), "none")
    assert.isUndefined(homeLine(idle, context(now, [])))
    assert.isUndefined(receiptOf([ask], undefined))
    // The dots still cover the first moments after sending; nothing claims it's done.
    assert.deepStrictEqual(chatRowOf(idle, [update, ask], now), { _tag: "Sent" })
    assert.isUndefined(chatRowOf(idle, [update, ask], at("14:10")))
  })

  it("stops saying starting once that has gone on too long", () => {
    assert.strictEqual(presence(starting, at("14:04"))._tag, "Starting")
    assert.strictEqual(presence(starting, at("14:06"))._tag, "Asleep")
  })

  it("only says done when the turn ended after their latest message", () => {
    const now = at("14:30")
    const p = presence({ state: "idle", since: at("14:01"), awakeUntil: at("14:40") }, now)
    // Sent at 2:02, never taken (delivery is failing): no "Done for now", and no dots after a while either.
    assert.isUndefined(chatRowOf(p, [update, ask], now))
    assert.deepStrictEqual(receiptOf([update, ask], { state: "idle" }), { messageId: ask.id, seen: false })
  })

  it("counts a message from before receipts as seen once the agent answered or finished a turn after it", () => {
    assert.deepStrictEqual(receiptOf([ask, reply], { state: "idle" }), { messageId: ask.id, seen: true })
    assert.deepStrictEqual(receiptOf([ask], { state: "idle", since: at("14:05") }), { messageId: ask.id, seen: true })
    assert.deepStrictEqual(receiptOf([ask], { state: "working", since: at("14:05") }), {
      messageId: ask.id,
      seen: false
    })
  })

  it("says nothing in Chat while paused; the header says why", () => {
    const now = at("14:02")
    const p = presence(asleep, now, { pausedUntil: at("16:00") })
    assert.isUndefined(chatRowOf(p, [update, ask], now))
    assert.strictEqual(line(headerLine(p, context(now, [update, ask]))), "Paused · Claude usage resets 4 PM")
  })

  it("formats elapsed time and times ahead", () => {
    assert.strictEqual(elapsedLabel(at("14:02"), DateTime.add(at("14:02"), { seconds: 40 })), "40s")
    assert.strictEqual(elapsedLabel(at("14:02"), at("15:02")), "1h")
    assert.strictEqual(elapsedLabel(at("14:02"), at("15:17")), "1h 15m")
    assert.strictEqual(aheadLabel(at("09:30", "07"), at("14:02"), tz), "Sat 9:30 AM")
  })
})
