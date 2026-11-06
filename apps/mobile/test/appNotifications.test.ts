/**
 * Notifications from a project's apps on the phone: how the sheet reads (each app's line, its history, mute until
 * tomorrow), what a newer API can send it, and allowing, declining and quieting an app through the real client
 * against the fixtures backend.
 */
import { AppRpcs, type AppSender, type MessageId, type ProjectId } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Redacted, Schema } from "effect"
import { Reactivity } from "effect/reactivity"
import { Socket } from "effect/socket"
import { AppClient } from "../src/data/AppClient.ts"
import { makeAppLayer } from "../src/data/AppLayer.ts"
import { appLine, historyRows, historyTag, startOfTomorrow } from "../src/data/appNotifications.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"
import { PhoneAppRpcs } from "../src/data/Tolerant.ts"
import { FakeBackend } from "../src/fake/FakeBackend.ts"

const zone = "America/Los_Angeles"
const now = DateTime.makeUnsafe("2026-11-04T22:12:00Z") // 2:12 PM in Los Angeles

describe("startOfTomorrow", () => {
  it("is midnight where they are", () => {
    assert.strictEqual(DateTime.formatIso(startOfTomorrow(now, zone)), "2026-11-05T08:00:00.000Z")
    assert.strictEqual(DateTime.formatIso(startOfTomorrow(now, "Asia/Tokyo")), "2026-11-05T15:00:00.000Z")
    // Late in the evening in Los Angeles is already tomorrow in UTC.
    const late = DateTime.makeUnsafe("2026-11-05T07:30:00Z")
    assert.strictEqual(DateTime.formatIso(startOfTomorrow(late, zone)), "2026-11-05T08:00:00.000Z")
  })
})

describe("the sheet's words", () => {
  const app = Fx.morningBriefApp
  const sent = Fx.morningBriefAppNotifications

  it("each app's line says where it stands with them", () => {
    assert.strictEqual(appLine(app, sent, now, zone), "3 in the last 30 days · you opened 1")
    assert.strictEqual(appLine(app, [], now, zone), "Nothing sent yet")
    assert.strictEqual(appLine({ ...app, delivery: "off" }, [], now, zone), "Off")
    assert.strictEqual(appLine({ ...app, state: { _tag: "Waiting" } }, sent, now, zone), "Waiting for you to allow it")
    assert.strictEqual(appLine({ ...app, mutedUntil: startOfTomorrow(now, zone) }, sent, now, zone), "Muted for today")
    assert.strictEqual(
      appLine({ ...app, mutedUntil: DateTime.add(now, { hours: 2 }) }, sent, now, zone),
      "Muted until 4:12 PM"
    )
  })

  it("the history leads with the headline and says what happened when it didn't simply arrive", () => {
    const rows = historyRows(app, sent, now, zone)
    assert.deepStrictEqual(
      rows.map((r) => [r.title, r.tag, r.dim, r.time]),
      [
        ["Today’s digest: 6 newsletters, 5 minutes", undefined, false, "7:00 AM"],
        ["Today’s digest: 4 newsletters, 3 minutes", "Replaced", true, "Yesterday"],
        ["Gmail stopped answering", "Quietly", false, "Mon, Nov 2"]
      ]
    )
    // Without a page of its own, a row opens the app's page.
    assert.strictEqual(rows[2]!.url, app.url)
    assert.strictEqual(historyTag({ ...sent[0]!, outcome: "held", held: "hour" }), "Held · too many")
    assert.strictEqual(historyTag({ ...sent[0]!, outcome: "muted" }), "Muted")
  })
})

describe("what a newer API can send the sheet", () => {
  const decode = Schema.decodeUnknownSync(
    Schema.toCodecJson(
      PhoneAppRpcs.requests.get("GetAppNotifications")!.successSchema as unknown as Schema.Codec<
        unknown,
        unknown,
        never,
        never
      >
    )
  ) as (u: unknown) => { apps: ReadonlyArray<AppSender>; notifications: ReadonlyArray<unknown> }
  const encode = Schema.encodeSync(Schema.toCodecJson(AppRpcs.requests.get("GetAppNotifications")!.successSchema))

  it("leaves out an app or a notification it can't read, and keeps the rest", () => {
    const wire = encode({ apps: [Fx.morningBriefApp], notifications: Fx.morningBriefAppNotifications }) as any
    const later = {
      apps: [...wire.apps, { ...wire.apps[0], id: "later-app", state: { _tag: "Paused" } }],
      notifications: [...wire.notifications, { ...wire.notifications[0], outcome: "digested" }]
    }
    const decoded = decode(later)
    assert.deepStrictEqual(
      decoded.apps.map((a) => a.id),
      ["morning-brief"]
    )
    assert.lengthOf(decoded.notifications, 3)
  })
})

const appLayer = makeAppLayer(
  { apiUrl: "https://dream.test", backend: "fixtures" },
  { storage: SecureStorage.layerMemory(), webSocket: Socket.layerWebSocketConstructorGlobal, fetch: globalThis.fetch }
).pipe(Layer.provideMerge(Reactivity.layer))

const run = <A, E>(effect: Effect.Effect<A, E, any>) => effect.pipe(Effect.provide(appLayer)) as Effect.Effect<A, E>

const signIn = Effect.gen(function* () {
  const app = yield* AppClient
  const session = yield* Session
  const result = yield* app.DevSignIn({ email: "ada@example.com", secret: Redacted.make("fixtures") })
  yield* session.signIn({ token: result.sessionToken, user: result.user })
})

describe("an app's notifications through the client", () => {
  it.effect("asks, is allowed, and is quieted and muted from the sheet", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        const backend = yield* FakeBackend
        yield* backend.setPace(0)
        const lift = "prj_liftlog" as ProjectId
        yield* backend.scenario("notify-ask")
        const asked = yield* app.GetAppNotifications({ projectId: lift })
        assert.deepStrictEqual(
          asked.apps.map((a) => [a.id, a.state._tag]),
          [["lift-log", "Waiting"]]
        )
        const card = asked.apps[0]!.messageId
        const early = yield* Effect.flip(
          app.UpdateAppNotifications({ projectId: lift, app: asked.apps[0]!.id, delivery: "off" })
        )
        assert.strictEqual(early._tag, "InvalidRequest")

        const allowed = yield* app.AllowAppNotifications({ projectId: lift, messageId: card })
        assert.strictEqual(allowed.state._tag, "Allowed")
        const quiet = yield* app.UpdateAppNotifications({ projectId: lift, app: asked.apps[0]!.id, delivery: "quiet" })
        assert.strictEqual(quiet.delivery, "quiet")
        const until = startOfTomorrow(yield* DateTime.now)
        const muted = yield* app.UpdateAppNotifications({ projectId: lift, app: quiet.id, mutedUntil: until })
        assert.deepStrictEqual(muted.mutedUntil, until)
        const unmuted = yield* app.UpdateAppNotifications({ projectId: lift, app: quiet.id, mutedUntil: null })
        assert.isUndefined(unmuted.mutedUntil)
        assert.strictEqual(unmuted.delivery, "quiet")
      })
    )
  )

  it.effect("declined with a reason, and a delivered notification opened", () =>
    run(
      Effect.gen(function* () {
        yield* signIn
        const app = yield* AppClient
        const backend = yield* FakeBackend
        yield* backend.setPace(0)
        const lift = "prj_liftlog" as ProjectId
        yield* backend.scenario("notify-ask")
        const declined = yield* app.DeclineAccess({
          projectId: lift,
          messageId: "msg_liftnotify" as MessageId,
          reason: "Too often for me"
        })
        assert.strictEqual(declined.state._tag, "Declined")
        const after = yield* app.GetAppNotifications({ projectId: lift })
        assert.strictEqual(after.apps[0]!.state._tag, "Declined")

        const brief = Fx.morningBrief.id
        yield* backend.scenario("notify-app")
        const history = yield* app.GetAppNotifications({ projectId: brief })
        const latest = history.notifications[0]!
        assert.strictEqual(latest.title, "Today’s digest: 7 newsletters, 6 minutes")
        assert.isDefined(history.notifications.find((n) => n.id === Fx.morningBriefAppNotifications[0]!.id)!.replacedAt)
        yield* app.OpenedAppNotification({ projectId: brief, notificationId: latest.id })
        const opened = yield* app.GetAppNotifications({ projectId: brief })
        assert.isDefined(opened.notifications[0]!.openedAt)
        // Its id isn't stale, so opening Dream doesn't clear it from the lock screen.
        const { stale } = yield* app.FilterStaleNotifications({ notificationIds: [latest.id] })
        assert.lengthOf(stale, 0)
      })
    )
  )
})
