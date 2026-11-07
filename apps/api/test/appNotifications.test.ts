/**
 * Notifications from a project's apps (`dream notify`): set up with a card in Chat that they allow or decline, sent
 * from any process under the app's own name, and held to their controls and Dream's limits. The agent hears what
 * they decide, and once a day that an app is being held back.
 */
import { assert, describe, it } from "@effect/vitest"
import {
  type AgentEvent,
  type AppId,
  type AppNotification,
  type AppSender,
  DaemonEnvFile,
  type ProjectId,
  PushData
} from "@dream/domain"
import { DateTime, Effect, Redacted, Result } from "effect"
import { type AlertPush, alertPayload } from "../src/push/Apns.ts"
import { decideOutcome, resolveAppUrl } from "../src/project/AppNotifications.ts"
import { makeCloud } from "./support/Cloud.ts"

const claudeUrl =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"
const claudeToken = `sk-ant-oat01-${"x".repeat(60)}`

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const setup = (cloud: Cloud) =>
  Effect.gen(function* () {
    const signedIn = yield* cloud.phone.DevSignIn({ email: "ada@example.com", secret: Redacted.make("dev-secret") })
    cloud.session.token = Redacted.value(signedIn.sessionToken)
    yield* cloud.phone.RegisterDevice({
      deviceId: "8f14e45f-ceea-4e7b-9a0c-6a3f1b2c3d4e" as any,
      apnsToken: "apns-token-1",
      timeZone: "America/Los_Angeles"
    })
    cloud.world.scripts.set("claude setup-token", [
      { _tag: "Output", text: `Use the url below\r\n${claudeUrl}\r\n` },
      { _tag: "Output", text: "Paste code here if prompted > " }
    ])
    const started = yield* cloud.phone.StartModelConnection({ provider: "claude" })
    cloud.world.attachOutput = [
      { _tag: "Output", text: "Long-lived authentication token created successfully!\r\n" },
      { _tag: "Output", text: `${claudeToken}\r\n` }
    ]
    yield* cloud.phone.CompleteModelConnection({
      connectionId: started.connection.id,
      code: Redacted.make("code123#state")
    })
    const project = yield* cloud.phone.CreateProject({ idea: "Tell me when flights to Lisbon get cheap." })
    yield* cloud.alarm(project.id)
    const dreamd = yield* cloud.sandbox(tokenOf(cloud, project.id))
    return { project, dreamd }
  })

const tokenOf = (cloud: Cloud, projectId: ProjectId): string => {
  const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === projectId)!
  const line = sandbox.files
    .get(DaemonEnvFile)!
    .split("\n")
    .find((l) => l.startsWith("DREAM_PROJECT_TOKEN="))!
  return JSON.parse(line.slice("DREAM_PROJECT_TOKEN=".length))
}

const appEvents = (cloud: Cloud) =>
  cloud.world.delivered
    .flatMap((d) => d.events as ReadonlyArray<AgentEvent>)
    .filter((e) => e._tag === "AppNotificationsChanged" || e._tag === "AppNotificationsHeld")

const alerts = (cloud: Cloud) => cloud.world.pushes.filter((p) => p.kind === "alert").map((p) => p.payload as AlertPush)

const appAlerts = (cloud: Cloud) => alerts(cloud).filter((a) => a.category === "app")

const fareWatch = {
  app: "fare-watch" as AppId,
  name: "Fare watch",
  why: "When a fare you're watching drops below your target",
  often: "A few times a week at most",
  icon: { _tag: "Symbol" as const, name: "airplane" },
  color: "blue" as const
}

const send = (text: string, extra: { title?: string; url?: string; key?: string; quiet?: boolean } = {}) => ({
  app: fareWatch.app,
  text,
  ...extra,
  quiet: extra.quiet ?? false,
  dryRun: false
})

describe("app notifications", () => {
  it.live("an app asks once, they allow it, and its notifications reach the phone as the app", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)

      const { app, card } = yield* dreamd.SetUpAppNotifications({ ...fareWatch, url: "/" })
      assert.strictEqual(app.state._tag, "Waiting")
      assert.strictEqual(app.url, `${project.publicUrl}/`)
      assert.strictEqual(card.request._tag, "Notifications")
      assert.strictEqual(card.state._tag, "Open")
      // The card reaches their phone like any access request, and waits on them.
      const asked = alerts(cloud).at(-1)!
      assert.strictEqual(asked.category, "access")
      assert.strictEqual(asked.body, "Let Fare watch notify you: When a fare you're watching drops below your target")
      const home = yield* cloud.phone.ListProjects()
      assert.strictEqual(home.find((p) => p.project.id === project.id)!.openAsks, 1)

      // Nothing from the app reaches them until they allow it, and that isn't an error.
      const early = yield* dreamd.SendAppNotification(send("Lisbon is $412."))
      assert.strictEqual(early.outcome, "waiting")
      assert.lengthOf(appAlerts(cloud), 0)

      const allowed = yield* cloud.phone.AllowAppNotifications({ projectId: project.id, messageId: card.id })
      assert.strictEqual(allowed.state._tag, "Allowed")
      assert.deepStrictEqual(
        cloud.world.pushes.filter((p) => p.kind === "silent").map((p) => (p.payload as PushData)._tag),
        ["Withdraw"]
      )
      assert.strictEqual(
        (yield* cloud.phone.AllowAppNotifications({ projectId: project.id, messageId: card.id })).state._tag,
        "Allowed"
      )

      const sent = yield* dreamd.SendAppNotification(
        send("Round trip May 14–21, down $90 since Monday.", { title: "Lisbon dropped to $412", url: "/routes/lis" })
      )
      assert.strictEqual(sent.outcome, "sent")
      assert.strictEqual(sent.url, `${project.publicUrl}/routes/lis`)
      const push = appAlerts(cloud).at(-1)!
      assert.deepStrictEqual(
        { title: push.title, subtitle: push.subtitle, body: push.body, threadId: push.threadId, passive: push.passive },
        {
          title: "Fare watch",
          subtitle: "Lisbon dropped to $412",
          body: "Round trip May 14–21, down $90 since Monday.",
          threadId: `${project.id}/fare-watch`,
          passive: false
        }
      )
      assert.deepStrictEqual(
        push.data,
        PushData.cases.OpenApp.make({
          projectId: project.id,
          app: fareWatch.app,
          notificationId: sent.id,
          url: `${project.publicUrl}/routes/lis`
        })
      )
      assert.strictEqual(push.id, sent.id)

      // Without a page of its own, a tap goes to the app's page from setup.
      const plain = yield* dreamd.SendAppNotification(send("Porto is $388."))
      assert.strictEqual(plain.url, `${project.publicUrl}/`)

      // The phone sees the apps and their history; a tap is recorded so the agent can see what gets read.
      const listed = yield* cloud.phone.GetAppNotifications({ projectId: project.id })
      assert.deepStrictEqual(
        listed.apps.map((a) => [a.id, a.state._tag]),
        [["fare-watch", "Allowed"]]
      )
      assert.deepStrictEqual(
        listed.notifications.map((n) => n.text),
        ["Porto is $388.", "Round trip May 14–21, down $90 since Monday."]
      )
      yield* cloud.phone.OpenedAppNotification({ projectId: project.id, notificationId: sent.id })
      const forAgent = yield* dreamd.ListAppNotifications({ app: fareWatch.app })
      assert.isDefined(forAgent.notifications.find((n) => n.id === sent.id)!.openedAt)

      // The agent heard they allowed it.
      yield* cloud.alarm(project.id)
      assert.deepStrictEqual(
        appEvents(cloud).map((e) => (e._tag === "AppNotificationsChanged" ? e.change : e.limit)),
        ["allowed"]
      )

      // Withdrawing one removes it from the lock screen and says so in the history.
      yield* dreamd.WithdrawNotification({ notificationId: plain.id })
      const withdrawn = (yield* dreamd.ListAppNotifications({})).notifications.find((n) => n.id === plain.id)!
      assert.isDefined(withdrawn.withdrawnAt)
      yield* cloud.close
    })
  )

  it.live("repeats are dropped, a shared key replaces, and a dry run sends nothing", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const { card } = yield* dreamd.SetUpAppNotifications(fareWatch)
      yield* cloud.phone.AllowAppNotifications({ projectId: project.id, messageId: card.id })

      const dry = yield* dreamd.SendAppNotification({ ...send("Lisbon is $412."), dryRun: true })
      assert.strictEqual(dry.outcome, "sent")
      assert.lengthOf(appAlerts(cloud), 0)
      assert.lengthOf((yield* dreamd.ListAppNotifications({})).notifications, 0)

      const first = yield* dreamd.SendAppNotification(send("Lisbon is $412.", { key: "lis" }))
      const again = yield* dreamd.SendAppNotification(send("Lisbon is $412.", { key: "lis" }))
      assert.strictEqual(again.outcome, "duplicate")
      assert.lengthOf(appAlerts(cloud), 1)

      const lower = yield* dreamd.SendAppNotification(send("Lisbon is $398.", { key: "lis" }))
      assert.strictEqual(lower.outcome, "sent")
      const [a, b] = appAlerts(cloud)
      assert.isDefined(a!.collapseId)
      assert.strictEqual(a!.collapseId, b!.collapseId)
      assert.isAtMost(a!.collapseId!.length, 64)
      const history = (yield* dreamd.ListAppNotifications({})).notifications
      assert.isDefined(history.find((n) => n.id === first.id)!.replacedAt)
      assert.isUndefined(history.find((n) => n.id === lower.id)!.replacedAt)
      // Another key is another thing.
      yield* dreamd.SendAppNotification(send("Porto is $388.", { key: "opo" }))
      assert.notStrictEqual(appAlerts(cloud).at(-1)!.collapseId, a!.collapseId)
      yield* cloud.close
    })
  )

  it.live("over the hourly limit, notifications are held and the agent hears once", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const { card } = yield* dreamd.SetUpAppNotifications(fareWatch)
      yield* cloud.phone.AllowAppNotifications({ projectId: project.id, messageId: card.id })

      const outcomes: Array<string> = []
      for (let i = 1; i <= 8; i++) outcomes.push((yield* dreamd.SendAppNotification(send(`Check ${i}`))).outcome)
      assert.deepStrictEqual(outcomes, ["sent", "sent", "sent", "sent", "sent", "sent", "held", "held"])
      assert.lengthOf(appAlerts(cloud), 6)
      const held = (yield* dreamd.ListAppNotifications({})).notifications.filter((n) => n.outcome === "held")
      assert.deepStrictEqual(
        held.map((n) => n.held),
        ["hour", "hour"]
      )
      yield* cloud.alarm(project.id)
      assert.deepStrictEqual(
        appEvents(cloud)
          .filter((e) => e._tag === "AppNotificationsHeld")
          .map((e) => e._tag === "AppNotificationsHeld" && e.limit),
        ["hour"]
      )
      yield* cloud.close
    })
  )

  it.live("their Off, Mute and Quietly decide, and the agent hears each", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const { card } = yield* dreamd.SetUpAppNotifications(fareWatch)
      // Not before they allow it.
      const early = yield* cloud.phone
        .UpdateAppNotifications({ projectId: project.id, app: fareWatch.app, delivery: "off" })
        .pipe(Effect.flip)
      assert.strictEqual(early._tag, "InvalidRequest")
      yield* cloud.phone.AllowAppNotifications({ projectId: project.id, messageId: card.id })

      yield* cloud.phone.UpdateAppNotifications({ projectId: project.id, app: fareWatch.app, delivery: "quiet" })
      const quiet = yield* dreamd.SendAppNotification(send("Quiet one"))
      assert.strictEqual(quiet.outcome, "quiet")
      assert.isTrue(appAlerts(cloud).at(-1)!.passive)

      const off = yield* cloud.phone.UpdateAppNotifications({
        projectId: project.id,
        app: fareWatch.app,
        delivery: "off"
      })
      assert.strictEqual(off.delivery, "off")
      const muted = yield* dreamd.SendAppNotification(send("Nobody hears this"))
      assert.strictEqual(muted.outcome, "muted")
      assert.lengthOf(appAlerts(cloud), 1)
      // Kept in the history, so it's there if they look.
      assert.isDefined((yield* dreamd.ListAppNotifications({})).notifications.find((n) => n.id === muted.id))

      yield* cloud.phone.UpdateAppNotifications({ projectId: project.id, app: fareWatch.app, delivery: "immediate" })
      const until = DateTime.add(yield* DateTime.now, { hours: 10 })
      const snoozed = yield* cloud.phone.UpdateAppNotifications({
        projectId: project.id,
        app: fareWatch.app,
        mutedUntil: until
      })
      assert.isDefined(snoozed.mutedUntil)
      assert.strictEqual((yield* dreamd.SendAppNotification(send("Snoozed"))).outcome, "muted")
      yield* cloud.phone.UpdateAppNotifications({ projectId: project.id, app: fareWatch.app, mutedUntil: null })
      assert.strictEqual((yield* dreamd.SendAppNotification(send("Back"))).outcome, "sent")
      // An app's own --quiet goes quietly too.
      assert.strictEqual((yield* dreamd.SendAppNotification(send("Hush", { quiet: true }))).outcome, "quiet")

      yield* cloud.alarm(project.id)
      assert.deepStrictEqual(
        appEvents(cloud).map((e) => (e._tag === "AppNotificationsChanged" ? e.change : e.limit)),
        ["allowed", "quiet", "off", "immediate", "muted", "immediate"]
      )
      yield* cloud.close
    })
  )

  it.live("declining keeps it quiet, tells the agent why, and asking again is a new card", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const { card } = yield* dreamd.SetUpAppNotifications(fareWatch)
      const declined = yield* cloud.phone.DeclineAccess({
        projectId: project.id,
        messageId: card.id,
        reason: "Only under $400"
      })
      assert.strictEqual(declined.state._tag, "Declined")
      assert.strictEqual((yield* dreamd.SendAppNotification(send("Lisbon is $412."))).outcome, "declined")
      yield* cloud.alarm(project.id)
      const event = appEvents(cloud).at(-1)!
      assert.deepStrictEqual(event._tag === "AppNotificationsChanged" ? [event.change, event.reason] : [], [
        "declined",
        "Only under $400"
      ])

      // Asked again (with what they said in mind): a new card, and the old one can't be allowed anymore.
      const again = yield* dreamd.SetUpAppNotifications({ ...fareWatch, why: "When a fare drops below $400" })
      assert.notStrictEqual(again.card.id, card.id)
      assert.strictEqual(again.app.state._tag, "Waiting")
      const stale = yield* cloud.phone
        .AllowAppNotifications({ projectId: project.id, messageId: card.id })
        .pipe(Effect.flip)
      assert.strictEqual(stale._tag, "InvalidRequest")
      // Set up again while open: the same card, updated.
      const updated = yield* dreamd.SetUpAppNotifications({ ...fareWatch, why: "When a fare drops under $400" })
      assert.strictEqual(updated.card.id, again.card.id)
      assert.strictEqual(updated.card.why, "When a fare drops under $400")
      yield* cloud.phone.AllowAppNotifications({ projectId: project.id, messageId: again.card.id })
      // Allowed: set up again keeps the permission, with the new name.
      const renamed = yield* dreamd.SetUpAppNotifications({ ...fareWatch, name: "Fares" })
      assert.strictEqual(renamed.app.state._tag, "Allowed")
      assert.strictEqual(renamed.card.state._tag, "Allowed")
      yield* dreamd.SendAppNotification(send("Lisbon is $398."))
      assert.strictEqual(appAlerts(cloud).at(-1)!.title, "Fares")
      yield* cloud.close
    })
  )

  it.live("refuses what's wrong: unknown apps, links elsewhere, file keys, and asking through dream access", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const unknown = yield* dreamd.SendAppNotification(send("Hi")).pipe(Effect.flip)
      assert.strictEqual(unknown._tag, "InvalidRequest")
      assert.include(unknown.message, "dream notify setup fare-watch")

      for (const url of ["https://evil.example/", "//evil.example/x", "http://" + new URL(project.publicUrl).host]) {
        const refused = yield* dreamd.SetUpAppNotifications({ ...fareWatch, url }).pipe(Effect.flip)
        assert.strictEqual(refused._tag, "InvalidRequest", url)
      }
      const { card } = yield* dreamd.SetUpAppNotifications(fareWatch)
      yield* cloud.phone.AllowAppNotifications({ projectId: project.id, messageId: card.id })
      const elsewhere = yield* dreamd
        .SendAppNotification(send("Book it", { url: "https://airline.example/book" }))
        .pipe(Effect.flip)
      assert.include(elsewhere.message, project.publicUrl)

      const viaAccess = yield* dreamd
        .RequestAccess({
          request: { _tag: "Notifications", app: fareWatch.app, name: "Fare watch", often: "Daily" },
          why: "Tell you"
        })
        .pipe(Effect.flip)
      assert.include(viaAccess.message, "dream notify setup")

      // A file key never reaches the lock screen.
      const fakeKey = "123456:FAKE-telegram-token-for-tests"
      const request = yield* dreamd.RequestAccess({
        request: { _tag: "File", service: "Telegram", name: "telegram-bot-token" },
        why: "Your bot token."
      })
      yield* cloud.phone.SubmitKeyAccess({ projectId: project.id, messageId: request.id, key: Redacted.make(fakeKey) })
      const before = appAlerts(cloud).length
      const leak = yield* dreamd.SendAppNotification(send(`Token ${fakeKey}`)).pipe(Effect.flip)
      assert.strictEqual(leak._tag, "InvalidRequest")
      const titled = yield* dreamd.SendAppNotification(send("Hi", { title: fakeKey })).pipe(Effect.flip)
      assert.strictEqual(titled._tag, "InvalidRequest")
      assert.lengthOf(appAlerts(cloud), before)
      yield* cloud.close
    })
  )
})

// ---------------------------------------------------------------------------
// The decisions on their own, with time moved by hand
// ---------------------------------------------------------------------------

const nowMs = Date.parse("2026-11-06T15:00:00Z")
const allowedSender: AppSender = {
  id: "fare-watch" as AppId,
  name: "Fare watch",
  color: "blue",
  why: "When fares drop",
  often: "Weekly",
  messageId: "msg_x" as AppSender["messageId"],
  state: { _tag: "Allowed", allowedAt: DateTime.makeUnsafe(nowMs - 86_400_000 * 3) },
  delivery: "immediate",
  createdAt: DateTime.makeUnsafe(nowMs - 86_400_000 * 3)
}
let counter = 0
const past = (minutesAgo: number, fields: Partial<AppNotification> = {}): AppNotification => ({
  id: `00000000-0000-4000-8000-${String(counter++).padStart(12, "0")}` as AppNotification["id"],
  app: allowedSender.id,
  text: `n${counter}`,
  outcome: "sent",
  sentAt: DateTime.makeUnsafe(nowMs - minutesAgo * 60_000),
  ...fields
})
const decide = (recent: ReadonlyArray<AppNotification>, fields: Partial<Parameters<typeof decideOutcome>[0]> = {}) =>
  decideOutcome({ sender: allowedSender, title: undefined, text: "new", quiet: false, nowMs, recent, ...fields })

describe("decideOutcome", () => {
  it("the hourly limit counts only the last hour", () => {
    const sixThisHour = Array.from({ length: 6 }, (_, i) => past(5 + i * 5))
    assert.deepStrictEqual(decide(sixThisHour), { outcome: "held", held: "hour" })
    const sixEarlier = Array.from({ length: 6 }, (_, i) => past(65 + i * 5))
    assert.deepStrictEqual(decide(sixEarlier), { outcome: "sent" })
  })

  it("the daily limit counts the last 24 hours, and held or muted ones don't count", () => {
    const day = Array.from({ length: 24 }, (_, i) => past(70 + i * 50))
    assert.deepStrictEqual(decide(day), { outcome: "held", held: "day" })
    assert.deepStrictEqual(decide(day.map((n, i) => (i === 0 ? { ...n, outcome: "held" as const } : n))), {
      outcome: "sent"
    })
  })

  it("the project's limit counts every app", () => {
    const others = Array.from({ length: 48 }, (_, i) => past(70 + i * 20, { app: `other-${i % 3}` as AppId }))
    assert.deepStrictEqual(decide(others), { outcome: "held", held: "project" })
  })

  it("a repeat is the same title and text within six hours", () => {
    assert.strictEqual(decide([past(300, { text: "new" })]).outcome, "duplicate")
    assert.strictEqual(decide([past(400, { text: "new" })]).outcome, "sent")
    assert.strictEqual(decide([past(30, { text: "new", title: "A" })]).outcome, "sent")
    assert.strictEqual(decide([past(30, { text: "new", app: "other" as AppId })]).outcome, "sent")
  })

  it("permission comes first, then repeats, then their Off and Mute", () => {
    assert.strictEqual(decide([], { sender: { ...allowedSender, state: { _tag: "Waiting" } } }).outcome, "waiting")
    const off = { ...allowedSender, delivery: "off" as const }
    assert.strictEqual(decide([past(10, { text: "new", outcome: "muted" })], { sender: off }).outcome, "duplicate")
    assert.strictEqual(decide([], { sender: off }).outcome, "muted")
    const snoozed = { ...allowedSender, mutedUntil: DateTime.makeUnsafe(nowMs + 60_000) }
    assert.strictEqual(decide([], { sender: snoozed }).outcome, "muted")
    const expired = { ...allowedSender, mutedUntil: DateTime.makeUnsafe(nowMs - 60_000) }
    assert.strictEqual(decide([], { sender: expired }).outcome, "sent")
    assert.strictEqual(decide([], { quiet: true }).outcome, "quiet")
  })
})

describe("resolveAppUrl", () => {
  const base = "https://fares-x8k2.omer.build"
  it("takes a path or a page of the published URL", () => {
    assert.deepStrictEqual(resolveAppUrl(base, "/routes/lis?d=14"), Result.succeed(`${base}/routes/lis?d=14`))
    assert.deepStrictEqual(resolveAppUrl(base, `${base}/x`), Result.succeed(`${base}/x`))
  })
  it("refuses anywhere else", () => {
    for (const url of [
      "https://evil.example",
      "//evil.example",
      "http://fares-x8k2.omer.build/",
      "javascript:alert(1)",
      "routes"
    ]) {
      assert.isTrue(Result.isFailure(resolveAppUrl(base, url)), url)
    }
  })
})

describe("alertPayload", () => {
  const push: AlertPush = {
    id: "3a5a8caa-e32b-4754-9af8-c485d3b38983",
    title: "Fare watch",
    subtitle: "Lisbon dropped to $412",
    body: "Round trip.",
    category: "app",
    threadId: "prj_x/fare-watch",
    data: PushData.cases.Withdraw.make({ notificationIds: ["3a5a8caa-e32b-4754-9af8-c485d3b38983" as never] })
  }
  it("rings by default, and a quiet one goes to Notification Center without a sound", () => {
    const loud: any = alertPayload(push)
    assert.strictEqual(loud.aps.sound, "default")
    assert.isUndefined(loud.aps["interruption-level"])
    assert.strictEqual(loud.aps.alert.subtitle, "Lisbon dropped to $412")
    const quiet: any = alertPayload({ ...push, passive: true })
    assert.strictEqual(quiet.aps["interruption-level"], "passive")
    assert.isUndefined(quiet.aps.sound)
    const plain: any = alertPayload({ ...push, subtitle: undefined, category: "message" })
    assert.isFalse("subtitle" in plain.aps.alert)
  })
})
