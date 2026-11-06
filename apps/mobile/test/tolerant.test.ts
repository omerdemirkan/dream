/**
 * What a newer API can send this build: the lists the phone reads decode what they know and set aside what they
 * don't, through the same JSON codec the RPC client uses. The live stream is covered in live.test.ts.
 */
import { AppAuth, AppRpcs, Message, ProjectEvent } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import { PhoneAppRpcs, TolerantMessage, TolerantProjectEvent, unsupportedText } from "../src/data/Tolerant.ts"

type AnyCodec = Schema.Codec<unknown, unknown, never, never>
const success = (group: typeof AppRpcs, tag: string) =>
  Schema.toCodecJson(group.requests.get(tag)!.successSchema as unknown as AnyCodec)
const decodeWith = (group: typeof AppRpcs, tag: string) =>
  Schema.decodeUnknownSync(success(group, tag)) as (u: unknown) => any
const encodeWith = (group: typeof AppRpcs, tag: string) =>
  Schema.encodeSync(success(group, tag)) as (u: unknown) => unknown

const header = { projectId: Fx.liftLog.id, createdAt: "2026-11-05T10:00:00.000Z" }
const futureAccess = {
  _tag: "Access",
  id: "msg_passkey",
  ...header,
  request: { _tag: "Passkey" },
  why: "x",
  state: { _tag: "Open" }
}
const futureState = { ...futureAccess, id: "msg_state", request: { _tag: "Apple" }, state: { _tag: "Expired" } }

describe("PhoneAppRpcs", () => {
  it("is AppRpcs with the same RPCs and middleware", () => {
    assert.deepStrictEqual([...PhoneAppRpcs.requests.keys()].sort(), [...AppRpcs.requests.keys()].sort())
    for (const tag of ["ListMessages", "ListOpenAsks", "ListProjects", "ListIntegrations"]) {
      assert.isTrue(PhoneAppRpcs.requests.get(tag)!.middlewares.has(AppAuth as never), tag)
      assert.notStrictEqual(PhoneAppRpcs.requests.get(tag), AppRpcs.requests.get(tag), tag)
    }
  })

  it("decodes and encodes what the domain knows exactly as the domain does", () => {
    const cases: Array<[string, unknown]> = [
      ["ListMessages", { messages: [...Fx.messages, Fx.telegramKey], hasEarlier: true }],
      ["ListOpenAsks", [{ project: Fx.liftLog, message: Fx.appleAccess }]],
      ["ListProjects", [{ project: Fx.recipeScaler, openAsks: 1 }]],
      [
        "ListProjects",
        [
          {
            project: Fx.liftLog,
            openAsks: 0,
            activity: { state: "working", since: DateTime.makeUnsafe("2026-11-04T22:02:30Z") }
          }
        ]
      ],
      ["ListIntegrations", [Fx.google, Fx.telegramKeyFile]]
    ]
    for (const [tag, value] of cases) {
      const wire = JSON.parse(JSON.stringify(encodeWith(AppRpcs, tag)(value)))
      assert.deepStrictEqual(encodeWith(PhoneAppRpcs, tag)(value), wire, tag)
      assert.deepStrictEqual(decodeWith(PhoneAppRpcs, tag)(wire), decodeWith(AppRpcs, tag)(wire), tag)
    }
  })

  it("shows messages it doesn't know as a neutral row, and drops what isn't a message at all", () => {
    const known = JSON.parse(JSON.stringify(Schema.encodeSync(Schema.toCodecJson(Message))(Fx.liftLogUpdate)))
    const wire = {
      messages: [known, futureAccess, futureState, { _tag: "Poll", id: "msg_poll", ...header }, { nope: 1 }],
      hasEarlier: false
    }
    assert.throws(() => decodeWith(AppRpcs, "ListMessages")(wire))
    const { messages } = decodeWith(PhoneAppRpcs, "ListMessages")(wire)
    assert.deepStrictEqual(
      messages.map((m: Message) => [m.id, m._tag, m._tag === "Text" ? m.text === unsupportedText : undefined]),
      [
        [Fx.liftLogUpdate.id, "Text", false],
        ["msg_passkey", "Text", true],
        ["msg_state", "Text", true],
        ["msg_poll", "Text", true]
      ]
    )
  })

  it("leaves out open asks, projects and integrations it doesn't know", () => {
    const encode = (tag: string, value: unknown) => JSON.parse(JSON.stringify(encodeWith(AppRpcs, tag)(value)))
    const [ask] = encode("ListOpenAsks", [{ project: Fx.liftLog, message: Fx.appleAccess }])
    const asks = decodeWith(PhoneAppRpcs, "ListOpenAsks")([ask, { project: ask.project, message: futureAccess }])
    assert.deepStrictEqual(
      asks.map((a: any) => a.message.id),
      [Fx.appleAccess.id]
    )

    const [summary] = encode("ListProjects", [{ project: Fx.recipeScaler, openAsks: 1 }])
    const future = { ...summary, project: { ...summary.project, phase: "hibernating" } }
    assert.lengthOf(decodeWith(PhoneAppRpcs, "ListProjects")([summary, future]), 1)

    const [google] = encode("ListIntegrations", [Fx.google])
    const passkey = { ...google, id: "int_passkey", access: { _tag: "Passkey" } }
    assert.deepStrictEqual(
      decodeWith(PhoneAppRpcs, "ListIntegrations")([google, passkey]).map((i: any) => i.id),
      [Fx.google.id]
    )
  })
})

describe("TolerantMessage and TolerantProjectEvent", () => {
  it("decode an unknown event to null and keep known ones", () => {
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(TolerantProjectEvent))
    assert.isNull(decode({ _tag: "TypingStarted" }))
    assert.deepStrictEqual(
      decode({ _tag: "WorkingChanged", working: true }),
      ProjectEvent.cases.WorkingChanged.make({ working: true })
    )
    assert.deepStrictEqual(
      decode({
        _tag: "Usage",
        usage: {
          provider: "chatgpt",
          billing: "subscription",
          weekly: { usedPercent: 38, projectPercent: 4 },
          observedAt: "2026-11-04T22:10:00.000Z"
        }
      }),
      ProjectEvent.cases.Usage.make({
        usage: {
          provider: "chatgpt",
          billing: "subscription",
          weekly: { usedPercent: 38, projectPercent: 4 },
          observedAt: DateTime.makeUnsafe("2026-11-04T22:10:00Z")
        }
      })
    )
  })

  it("decode the activity, and drop one with a state this build doesn't know rather than the snapshot", () => {
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(TolerantProjectEvent))
    assert.deepStrictEqual(
      decode({ _tag: "ActivityChanged", activity: { state: "starting", since: "2026-11-04T22:02:01.000Z" } }),
      ProjectEvent.cases.ActivityChanged.make({
        activity: { state: "starting", since: DateTime.makeUnsafe("2026-11-04T22:02:01Z") }
      })
    )
    assert.isNull(decode({ _tag: "ActivityChanged", activity: { state: "dreaming" } }))
    const snapshot = ProjectEvent.cases.Snapshot.make({
      project: Fx.liftLog,
      status: Fx.liftLogStatus,
      messages: [Fx.liftLogUpdate],
      hasEarlierMessages: false,
      working: false
    })
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(Schema.toCodecJson(ProjectEvent))(snapshot)))
    assert.deepStrictEqual(decode({ ...wire, activity: { state: "dreaming" } }), snapshot)
    const withActivity = decode({ ...wire, activity: { state: "idle", awakeUntil: "2026-11-04T22:14:00.000Z" } })
    assert.deepStrictEqual(withActivity?._tag === "Snapshot" && withActivity.activity, {
      state: "idle",
      awakeUntil: DateTime.makeUnsafe("2026-11-04T22:14:00Z")
    })

    const [summary] = JSON.parse(
      JSON.stringify(encodeWith(AppRpcs, "ListProjects")([{ project: Fx.recipeScaler, openAsks: 1 }]))
    )
    const rows = decodeWith(PhoneAppRpcs, "ListProjects")([{ ...summary, activity: { state: "dreaming" } }])
    assert.lengthOf(rows, 1)
    assert.isFalse("activity" in rows[0])
  })

  it("refuse a message with no id, so a list leaves it out", () => {
    assert.throws(() => Schema.decodeUnknownSync(Schema.toCodecJson(TolerantMessage))({ _tag: "Poll" }))
  })
})

describe("a field this build doesn't know", () => {
  it("leaves the message as it is, the way builds before a question's context read one with it", () => {
    const wire = { ...JSON.parse(JSON.stringify(Schema.encodeSync(Schema.toCodecJson(Message))(Fx.cabinQuestion))) }
    const decoded = Schema.decodeUnknownSync(TolerantMessage)({ ...wire, summary: "A field from a newer API" })
    assert.deepStrictEqual(decoded, Fx.cabinQuestion)
  })
})
