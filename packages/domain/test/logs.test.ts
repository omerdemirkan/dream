/** The project's log shapes, and the additions to `AgentEvent` that tell the agent about trouble. */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import {
  AgentEvent,
  boundedLogEntry,
  EventId,
  LogEntry,
  LogLimits,
  matchesLogQuery,
  renderAgentEvent,
  SandboxRpcs,
  WakeId
} from "../src/index.ts"

const at = DateTime.makeUnsafe("2026-11-08T14:02:00Z")
const json = <S extends Schema.Top>(schema: S) =>
  Schema.toCodecJson(schema) as unknown as Schema.Codec<S["Type"], unknown>

describe("an Alert Dream noticed", () => {
  const alert = AgentEvent.cases.Alert.make({
    id: EventId.make("evt_1"),
    at,
    reason: "Your published app answered 3 requests with server errors.",
    noticed: "server-errors"
  })

  it("reaches an older dreamd as the Alert it knows, without `noticed`", () => {
    // AgentEvent as dreamd builds before November 8, 2026 had it: an Alert was a reason and nothing else.
    const OldAgentEvent = Schema.TaggedUnion({
      Alert: { id: EventId, at: Schema.DateTimeUtc, reason: Schema.String },
      UsageReset: { id: EventId, at: Schema.DateTimeUtc, window: Schema.Literals(["fiveHour", "weekly"]) }
    })
    const wire = Schema.encodeSync(json(AgentEvent))(alert)
    const old = Schema.decodeUnknownSync(json(OldAgentEvent))(wire)
    assert.deepStrictEqual(old, { _tag: "Alert", id: alert.id, at, reason: alert.reason })
  })

  it("renders as Dream's, with where the log shows more", () => {
    const text = renderAgentEvent(alert)
    assert.include(text, "Dream noticed a problem:")
    assert.include(text, "> Your published app answered 3 requests")
    assert.include(text, "`dream logs --source gateway,app --errors`")
    assert.notInclude(text, "called `dream wake`")
  })

  it("leaves a `dream wake` from the sandbox as it was", () => {
    const text = renderAgentEvent(AgentEvent.cases.Alert.make({ id: EventId.make("evt_2"), at, reason: "db down" }))
    assert.include(text, "Something in the sandbox called `dream wake`:\n> db down")
  })
})

describe("a scheduled command that keeps failing", () => {
  it("says how often it failed without waking the agent", () => {
    const event = AgentEvent.cases.WakeDue.make({
      id: EventId.make("evt_3"),
      at,
      wakeId: WakeId.make("wak_1"),
      why: "check the feed",
      run: {
        command: "curl -fsS localhost:3000/check",
        result: {
          exitCode: 22,
          outputTail: "curl: (22) The requested URL returned error: 500",
          failedBefore: { count: 7, since: DateTime.makeUnsafe("2026-11-08T12:00:00Z") }
        }
      }
    })
    const text = renderAgentEvent(event)
    assert.include(text, "exited with code 22. It had failed 7 times in a row before this")
    assert.include(text, "`dream logs --source run --name wak_1`")
  })
})

describe("log entries", () => {
  const entry: LogEntry = { at, source: "gateway", level: "error", text: "GET /api → 500 in 12 ms" }

  it("match a query by source, time, level and name", () => {
    assert.isTrue(matchesLogQuery(entry, {}))
    assert.isTrue(matchesLogQuery(entry, { sources: ["gateway"], errors: true, since: at }))
    assert.isFalse(matchesLogQuery(entry, { sources: ["app"] }))
    assert.isFalse(matchesLogQuery(entry, { since: DateTime.makeUnsafe("2026-11-08T14:03:00Z") }))
    assert.isFalse(matchesLogQuery({ ...entry, level: "info" }, { errors: true }))
    assert.isFalse(matchesLogQuery(entry, { name: "web" }))
  })

  it("keep a line short and a detail's end", () => {
    const long = boundedLogEntry({ ...entry, text: "x".repeat(2000), detail: `start${"y".repeat(20_000)}end` })
    assert.strictEqual(long.text.length, LogLimits.text)
    assert.strictEqual(long.detail?.length, LogLimits.detail)
    assert.isTrue(long.detail?.endsWith("end"))
  })

  it("go over the wire with a machine reading", () => {
    const reading: LogEntry = {
      at,
      source: "machine",
      level: "info",
      text: "memory …",
      sample: {
        memoryTotalMb: 3900,
        memoryAvailableMb: 2100,
        swapTotalMb: 2048,
        swapUsedMb: 12,
        diskTotalMb: 20_000,
        diskFreeMb: 9000,
        load1: 0.4,
        cpus: 2,
        oomKills: 0,
        swapInPages: 10,
        swapOutPages: 30
      }
    }
    const codec = json(LogEntry)
    assert.deepStrictEqual(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(reading)), reading)
  })

  it("are what ReadLog returns", () => {
    assert.isTrue(SandboxRpcs.requests.has("ReadLog"))
  })
})
