/**
 * The control plane end to end, in memory: the phone and dreamd talk to the
 * Worker over real RPC; ProjectDOs run on their own SQLite; providers are
 * fakes that record what they were asked.
 */
import { assert, describe, it } from "@effect/vitest"
import { DaemonEnvFile, type NotificationId, type ProjectId, QuestionAnswer } from "@dream/domain"
import { Context, DateTime, Effect, Exit, Fiber, Option, Redacted, Stream } from "effect"
import { ProjectClients } from "../src/project/Client.ts"
import { Core } from "../src/project/Core.ts"
import { Store } from "../src/project/Store.ts"
import { makeCloud } from "./support/Cloud.ts"

const claudeUrl =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"
const claudeToken = `sk-ant-oat01-${"x".repeat(60)}`

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

/** Signs in, registers a device, connects Claude, and creates a project. */
const setup = (cloud: Cloud) =>
  Effect.gen(function* () {
    const signedIn = yield* cloud.phone.DevSignIn({
      email: "Omer@Example.com",
      name: "Omer",
      secret: Redacted.make("dev-secret")
    })
    cloud.session.token = Redacted.value(signedIn.sessionToken)
    yield* cloud.phone.RegisterDevice({
      deviceId: "8f14e45f-ceea-4e7b-9a0c-6a3f1b2c3d4e" as any,
      apnsToken: "apns-token-1",
      pushToStartToken: "start-token-1",
      timeZone: "America/Los_Angeles"
    })
    cloud.world.scripts.set("claude setup-token", [
      {
        _tag: "Output",
        text: `Browser didn't open? Use the url below\r\n\u001b]8;id=s1;${claudeUrl}\u0007${claudeUrl.slice(0, 80)}\u001b]8;;\u0007\r\n`
      },
      { _tag: "Output", text: "Paste code here if prompted > " }
    ])
    const started = yield* cloud.phone.StartModelConnection({ provider: "claude" })
    cloud.world.attachOutput = [
      {
        _tag: "Output",
        text: "\u001b[32m✓ Long-lived authentication token created successfully!\u001b[0m\r\nYour OAuth token (valid for 1 year):\r\n"
      },
      { _tag: "Output", text: `\u001b[33m${claudeToken}\u001b[0m\r\n` }
    ]
    const connection = yield* cloud.phone.CompleteModelConnection({
      connectionId: started.connection.id,
      code: Redacted.make("code123#state")
    })
    const project = yield* cloud.phone.CreateProject({
      idea: "A strength log that reads Apple Health and tells me when to add weight."
    })
    return { user: signedIn.user, started, connection, project }
  })

const envFileOf = (cloud: Cloud, projectId: ProjectId) => {
  const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === projectId)!
  const lines = sandbox.files.get(DaemonEnvFile)!.trim().split("\n")
  return {
    sandbox,
    env: Object.fromEntries(
      lines.map((line) => [line.slice(0, line.indexOf("=")), JSON.parse(line.slice(line.indexOf("=") + 1))])
    )
  }
}

describe("sign-in", () => {
  it.live("dev sign-in needs the deployment's secret", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const wrong = yield* cloud.phone.DevSignIn({ email: "a@b.c", secret: Redacted.make("nope") }).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(wrong))
      const ok = yield* cloud.phone.DevSignIn({ email: "A@B.c", secret: Redacted.make("dev-secret") })
      assert.strictEqual(ok.user.email, "a@b.c")
      cloud.session.token = Redacted.value(ok.sessionToken)
      const me = yield* cloud.phone.GetMe()
      assert.strictEqual(me.id, ok.user.id)
      yield* cloud.close
    })
  )

  it.live("Google sign-in requires an invite", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const denied = yield* Effect.flip(cloud.phone.SignIn({ googleIdToken: "valid:friend@example.com" }))
      assert.strictEqual(denied._tag, "NotInvited")
      cloud.db.exec("INSERT INTO invites (email, created_at) VALUES ('friend@example.com', '2026-11-05T00:00:00Z')")
      const ok = yield* cloud.phone.SignIn({ googleIdToken: "valid:friend@example.com" })
      assert.strictEqual(ok.user.email, "friend@example.com")
      yield* cloud.close
    })
  )

  it.live("rejects calls without a session", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const error = yield* Effect.flip(cloud.phone.ListProjects())
      assert.strictEqual(error._tag, "Unauthorized")
      yield* cloud.close
    })
  )
})

describe("a project, end to end", () => {
  it.live("connects Claude through setup-token and keeps the token encrypted", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { started, connection } = yield* setup(cloud)
      assert.strictEqual(started.flow._tag, "PasteCode")
      assert.strictEqual(started.flow._tag === "PasteCode" && started.flow.authorizeUrl, claudeUrl)
      assert.strictEqual(connection.status, "connected")
      assert.deepStrictEqual(
        cloud.world.inputs.map((input) => input.text),
        ["code123#state\r"]
      )
      // The auth sandbox is gone, and nothing in D1 holds the token in the clear.
      const authSandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.purpose === "model-connect")!
      assert.strictEqual(authSandbox.state, "killed")
      const dump = JSON.stringify(cloud.db.prepare("SELECT * FROM secrets").all())
      assert.notInclude(dump, claudeToken)
      yield* cloud.close
    })
  )

  it.live("creates the sandbox on first delivery, with the model credential as an egress rule", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, user } = yield* setup(cloud)
      assert.strictEqual(project.title, "New idea")
      assert.strictEqual(project.harness, "claude-code")
      assert.match(project.publicUrl, /^https:\/\/strength-log-reads-[a-z0-9]{8}\.dream\.test$/)

      yield* cloud.alarm(project.id)
      const { sandbox, env } = envFileOf(cloud, project.id)
      assert.strictEqual(sandbox.template, "dream-sandbox")
      assert.deepStrictEqual(sandbox.rules["api.anthropic.com"], [
        { transform: { headers: { Authorization: `Bearer ${claudeToken}` } } }
      ])
      assert.strictEqual(env.DREAM_PROJECT_ID, project.id)
      assert.strictEqual(env.DREAM_HARNESS, "claude-code")
      assert.strictEqual(env.DREAM_API_URL, "https://api.dream.test")
      assert.notProperty(env, "DREAM_MODEL")
      assert.notInclude(JSON.stringify(env), claudeToken)

      const [first] = cloud.world.delivered
      assert.strictEqual(first?.timeZone, "America/Los_Angeles")
      assert.deepStrictEqual(
        first?.events.map((e: any) => [e._tag, e.text]),
        [["UserMessage", project.idea]]
      )
      // Delivered once: another alarm sends nothing new.
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 1)

      const projects = yield* cloud.phone.ListProjects()
      assert.strictEqual(projects[0]?.project.ownerId, user.id)
      yield* cloud.close
    })
  )

  it.live("runs the agent on the configured model, and rewrites dreamd's env between turns when settings change", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud({ agentModel: Option.some("claude-haiku-4-5-20251001") })
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const { sandbox, env } = envFileOf(cloud, project.id)
      assert.strictEqual(env.DREAM_MODEL, "claude-haiku-4-5-20251001")
      const core = Context.get((yield* Effect.promise(() => cloud.project(project.id))).context, Core)
      const written = (yield* core.sandbox).envHash
      assert.isString(written)

      // Same settings: the next delivery leaves the file (and dreamd) alone.
      sandbox.files.set(DaemonEnvFile, "untouched")
      yield* cloud.phone.SendMessage({ projectId: project.id, text: "Track sets too" })
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 2)
      assert.strictEqual(sandbox.files.get(DaemonEnvFile), "untouched")

      // Written under other settings, mid-turn: still left alone, so the turn isn't cut short.
      yield* core.saveSandbox({ ...(yield* core.sandbox), envHash: "older settings", working: true })
      yield* cloud.phone.SendMessage({ projectId: project.id, text: "And rest times" })
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 3)
      assert.strictEqual(sandbox.files.get(DaemonEnvFile), "untouched")

      // Between turns: rewritten before delivering, with the model.
      yield* core.saveSandbox({ ...(yield* core.sandbox), working: false })
      yield* cloud.phone.SendMessage({ projectId: project.id, text: "Thanks" })
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 4)
      assert.strictEqual(envFileOf(cloud, project.id).env.DREAM_MODEL, "claude-haiku-4-5-20251001")
      assert.strictEqual((yield* core.sandbox).envHash, written)
      yield* cloud.close
    })
  )

  it.live("after rewriting dreamd's env file, delivers only to the dreamd that read it", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud({ agentModel: Option.some("claude-haiku-4-5-20251001") })
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const core = Context.get((yield* Effect.promise(() => cloud.project(project.id))).context, Core)
      const written = (yield* core.sandbox).envHash!
      assert.strictEqual(envFileOf(cloud, project.id).env.DREAM_ENV_HASH, written)
      assert.strictEqual(cloud.world.delivered[0]?.envHash, written)

      // The settings changed; the old dreamd keeps answering for a moment after the rewrite, as in QA.
      yield* core.saveSandbox({ ...(yield* core.sandbox), envHash: "older settings" })
      const { sandbox } = envFileOf(cloud, project.id)
      sandbox.files.set(DaemonEnvFile, sandbox.files.get(DaemonEnvFile)!.replace(written, "older settings"))
      cloud.world.daemons.set(sandbox.access.sandboxId, { envHash: "older settings" })
      cloud.world.restartLag = 1
      yield* cloud.phone.SendMessage({ projectId: project.id, text: "Track sets too" })
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 2)
      assert.strictEqual(cloud.world.delivered[1]?.envHash, written)
      // It saw the old dreamd (the hash it read) and waited past it.
      assert.include(cloud.world.healthChecks, "older settings")
      yield* cloud.close
    })
  )

  it.live("a dreamd that's restarting is delivered to again later, without restarting it again", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const env = envFileOf(cloud, project.id).sandbox.files.get(DaemonEnvFile)
      cloud.world.deliverRestarting = 1
      yield* cloud.phone.SendMessage({ projectId: project.id, text: "Track sets too" })
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 1)
      assert.strictEqual(envFileOf(cloud, project.id).sandbox.files.get(DaemonEnvFile), env)
      const storage = (yield* Effect.promise(() => cloud.project(project.id))).storage
      storage.db.exec("UPDATE timers SET due_ms = 0 WHERE name = 'deliver'")
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 2)
      yield* cloud.close
    })
  )

  it.live("questions notify, show on Home, and their answers wake the agent", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)

      const question = yield* dreamd.AskQuestion({
        question: "Who'll use this besides you?",
        options: ["Just me", "My gym friends"],
        why: "It decides whether accounts matter."
      })
      const alert = cloud.world.pushes.find((p) => p.kind === "alert")!
      assert.strictEqual(alert.token, "apns-token-1")
      assert.strictEqual((alert.payload as any).category, "question")
      assert.strictEqual((alert.payload as any).id, question.notificationId)

      const asks = yield* cloud.phone.ListOpenAsks()
      assert.deepStrictEqual(
        asks.map((a) => a.message.id),
        [question.id]
      )
      assert.strictEqual((yield* cloud.phone.ListProjects())[0]?.openAsks, 1)

      const invalid = yield* Effect.flip(
        cloud.phone.AnswerQuestion({
          projectId: project.id,
          messageId: question.id,
          answer: QuestionAnswer.cases.Choice.make({ option: "Everyone" })
        })
      )
      assert.strictEqual(invalid._tag, "InvalidRequest")

      const answered = yield* cloud.phone.AnswerQuestion({
        projectId: project.id,
        messageId: question.id,
        answer: QuestionAnswer.cases.Choice.make({ option: "Just me" })
      })
      assert.strictEqual(answered.state._tag, "Answered")
      assert.deepStrictEqual((yield* cloud.phone.ListOpenAsks()).length, 0)
      // The answered question's notification is withdrawn (silent push + stale list).
      const withdraw = cloud.world.pushes.find((p) => p.kind === "silent")!
      assert.deepStrictEqual((withdraw.payload as any).notificationIds, [question.notificationId])
      const stale = yield* cloud.phone.FilterStaleNotifications({
        notificationIds: [question.notificationId as NotificationId]
      })
      assert.deepStrictEqual(stale.stale, [question.notificationId as NotificationId])

      yield* cloud.alarm(project.id)
      const last = cloud.world.delivered.at(-1)!
      assert.deepStrictEqual(
        last.events.map((e: any) => [e._tag, e.answer?.option]),
        [["QuestionAnswered", "Just me"]]
      )
      yield* cloud.close
    })
  )

  it.live("streams a snapshot, then changes", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const live = yield* cloud.live(project.id)
      const events = yield* live.Subscribe().pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
      yield* Effect.sleep("50 millis")
      yield* dreamd.UpdateStatus({ title: "Lift Log", now: "Building progress charts" })
      const received = yield* Fiber.await(events)
      assert.isTrue(Exit.isSuccess(received))
      const tags = Exit.isSuccess(received) ? received.value.map((e) => e._tag) : []
      assert.strictEqual(tags[0], "Snapshot")
      assert.includeMembers(tags, ["StatusChanged"])
      const first = Exit.isSuccess(received) ? received.value[0] : undefined
      assert.strictEqual(first?._tag === "Snapshot" && first.messages[0]?._tag, "Text")
      yield* cloud.close
    })
  )

  it.live("access requests: a pasted key becomes an egress rule in every sandbox", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const request = yield* dreamd.RequestAccess({
        request: {
          _tag: "Key",
          service: "Stripe",
          host: "api.stripe.com",
          header: "Authorization",
          format: "Bearer {key}"
        },
        why: "Take payments for cabin weekends."
      })
      const connected = yield* cloud.phone.SubmitKeyAccess({
        projectId: project.id,
        messageId: request.id,
        key: Redacted.make("sk_live_123")
      })
      assert.strictEqual(connected.state._tag, "Connected")
      const { sandbox } = envFileOf(cloud, project.id)
      assert.deepStrictEqual(sandbox.rules["api.stripe.com"], [
        { transform: { headers: { Authorization: "Bearer sk_live_123" } } }
      ])
      const access = yield* dreamd.ListAccess()
      assert.deepStrictEqual(
        access.map((i) => i.access._tag === "Key" && i.access.placeholder),
        ["dream-stripe-key"]
      )
      yield* cloud.alarm(project.id)
      const event: any = cloud.world.delivered.at(-1)!.events[0]
      assert.strictEqual(event._tag, "AccessConnected")
      assert.strictEqual(event.access.placeholder, "dream-stripe-key")
      yield* cloud.close
    })
  )

  it.live("status updates feed Home", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      yield* dreamd.UpdateStatus({
        title: "Lift Log",
        kind: "iOS app",
        icon: "dumbbell",
        phase: "building",
        now: "Building progress charts",
        milestones: [
          { title: "Prototype", state: "done", needs: [] },
          { title: "Health import", state: "done", needs: [] },
          { title: "Progress charts", state: "current", needs: [] },
          {
            title: "On your phone",
            state: "upcoming",
            needs: [{ what: "Your Apple Developer account", when: "around Thursday" }]
          }
        ]
      })
      const [row] = yield* cloud.phone.ListProjects()
      assert.strictEqual(row?.project.title, "Lift Log")
      assert.strictEqual(row?.project.kind, "iOS app")
      assert.strictEqual(row?.project.phase, "building")
      assert.strictEqual(row?.project.headline, "Building progress charts")
      assert.deepStrictEqual(row?.progress, { done: 2, total: 4 })
      const cleared = yield* dreamd.UpdateStatus({ now: null, justDid: "Charts are in" })
      assert.isUndefined(cleared.now)
      assert.strictEqual((yield* cloud.phone.ListProjects())[0]?.project.headline, "Charts are in")
      yield* cloud.close
    })
  )

  it.live("scheduled wakes fire from the alarm", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const at = DateTime.add(yield* DateTime.now, { milliseconds: 300 })
      const wake = yield* dreamd.ScheduleWake({
        when: { _tag: "At", at },
        why: "Check the digest",
        run: "node check.js"
      })
      const cron = yield* dreamd.ScheduleWake({ when: { _tag: "Cron", expression: "0 7 * * *" }, why: "Morning brief" })
      assert.isDefined(cron.nextAt)
      const bad = yield* Effect.flip(dreamd.ScheduleWake({ when: { _tag: "Cron", expression: "not cron" }, why: "x" }))
      assert.strictEqual(bad._tag, "InvalidRequest")
      assert.strictEqual((yield* dreamd.ListWakes()).length, 2)
      yield* Effect.sleep("400 millis")
      yield* cloud.alarm(project.id)
      const event: any = cloud.world.delivered.at(-1)!.events[0]
      assert.strictEqual(event._tag, "WakeDue")
      assert.strictEqual(event.wakeId, wake.id)
      assert.strictEqual(event.run.command, "node check.js")
      yield* dreamd.CancelWake({ wakeId: cron.id })
      assert.deepStrictEqual(
        (yield* dreamd.ListWakes()).map((w) => w.id),
        [wake.id]
      )
      yield* cloud.close
    })
  )

  it.live("a usage limit holds delivery until the reset, then wakes the agent", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const until = DateTime.add(yield* DateTime.now, { milliseconds: 300 })
      yield* dreamd.ReportUsage({
        usage: {
          provider: "claude",
          fiveHour: { usedPercent: 100 },
          limitedUntil: { window: "fiveHour", until },
          observedAt: yield* DateTime.now
        }
      })
      const usage = yield* dreamd.GetUsage()
      assert.strictEqual(usage.fiveHour?.usedPercent, 100)
      assert.isDefined((yield* cloud.phone.ListProjects())[0]?.pausedUntil)
      yield* cloud.phone.SendMessage({ projectId: project.id, text: "Also track RPE" })
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 1)
      yield* Effect.sleep("400 millis")
      yield* cloud.alarm(project.id)
      const events = cloud.world.delivered.at(-1)!.events.map((e: any) => e._tag)
      assert.deepStrictEqual(events, ["UserMessage", "UsageReset"])
      assert.isUndefined((yield* cloud.phone.ListProjects())[0]?.pausedUntil)
      yield* cloud.close
    })
  )

  it.live("redelivers after dreamd fails", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      cloud.world.deliverFails = true
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 0)
      cloud.world.deliverFails = false
      yield* cloud.alarm(project.id)
      // The retry is scheduled a few seconds out; an alarm before then is a no-op for delivery.
      const storage = (yield* Effect.promise(() => cloud.project(project.id))).storage
      assert.isTrue(storage.alarms.some((at) => at !== null))
      cloud.db.exec("SELECT 1")
      storage.db.exec("UPDATE timers SET due_ms = 0 WHERE name = 'deliver'")
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 1)
      yield* cloud.close
    })
  )

  it.live("publishing points the gateway at the sandbox port", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const refused = yield* Effect.flip(dreamd.Publish({ port: 4747 }))
      assert.strictEqual(refused._tag, "InvalidRequest")
      const published = yield* dreamd.Publish({ port: 3000 })
      assert.strictEqual(published.url, project.publicUrl)
      const [row] = yield* cloud.phone.ListProjects()
      assert.strictEqual(row?.project.publishedPort, 3000)
      yield* cloud.close
    })
  )

  it.live("brokers a browser and a Mac", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const browser = yield* dreamd.StartBrowser()
      assert.match(browser.cdpUrl, /^wss:\/\//)
      const early = yield* Effect.flip(dreamd.GetBrowserRecording({ sessionId: browser.id }))
      assert.strictEqual(early._tag, "InvalidRequest")
      yield* dreamd.StopBrowser({ sessionId: browser.id })
      const recording = yield* dreamd.GetBrowserRecording({ sessionId: browser.id })
      assert.strictEqual(recording.contentType, "video/mp4")

      const none = yield* Effect.flip(dreamd.GetMacSsh())
      assert.strictEqual(none._tag, "InvalidRequest")
      const mac = yield* dreamd.StartMac()
      assert.strictEqual(mac.state, "running")
      const ssh = yield* dreamd.GetMacSsh()
      assert.strictEqual(ssh.host, "ssh.test.namespace.so")
      assert.include(Redacted.value(ssh.privateKey), "OPENSSH PRIVATE KEY")
      yield* dreamd.StopMac()
      assert.strictEqual((yield* dreamd.GetMac()).state, "stopped")
      const usage = cloud.db.prepare("SELECT kind, minutes FROM usage_events ORDER BY kind").all()
      assert.deepStrictEqual(
        usage.map((row) => row.kind),
        ["browser", "mac"]
      )
      assert.strictEqual(usage[0]?.minutes, 4)
      yield* cloud.close
    })
  )

  it.live("drives a Live Activity, switching to Needs you while a question is open", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const noActivity = yield* Effect.flip(dreamd.UpdateLiveActivity({ content: { title: "x" } }))
      assert.strictEqual(noActivity._tag, "InvalidRequest")
      yield* dreamd.StartLiveActivity({
        content: { title: "Building progress charts", step: { current: 3, total: 5 } }
      })
      const start = cloud.world.pushes.find((p) => p.kind === "live:start")!
      assert.strictEqual(start.token, "start-token-1")
      yield* cloud.phone.RegisterLiveActivity({
        projectId: project.id,
        deviceId: "8f14e45f-ceea-4e7b-9a0c-6a3f1b2c3d4e" as any,
        activityId: "activity-1",
        pushToken: "update-token-1"
      })
      yield* dreamd.AskQuestion({ question: "Kilograms or pounds?", options: ["kg", "lb"] })
      const update = cloud.world.pushes.filter((p) => p.kind === "live:update").at(-1)!
      assert.strictEqual(update.token, "update-token-1")
      assert.deepStrictEqual((update.payload as any).content.needsYou, { prompt: "Kilograms or pounds?" })
      yield* dreamd.EndLiveActivity({})
      assert.isDefined(cloud.world.pushes.find((p) => p.kind === "live:end"))
      yield* cloud.close
    })
  )

  it.live("checks project ownership", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      const other = yield* cloud.phone.DevSignIn({ email: "someone@else.com", secret: Redacted.make("dev-secret") })
      cloud.session.token = Redacted.value(other.sessionToken)
      const error = yield* Effect.flip(cloud.phone.SendMessage({ projectId: project.id, text: "hi" }))
      assert.strictEqual(error._tag, "NotFound")
      yield* cloud.close
    })
  )

  it.live("archiving stops the project: no sandbox, no deliveries, gone from Home", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const clients = Context.get(cloud.workerContext, ProjectClients)
      yield* cloud.phone.SendMessage({ projectId: project.id, text: "One more thing" })
      yield* clients.use(project.id, (client) => client.Archive())
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 1)
      assert.strictEqual(envFileOf(cloud, project.id).sandbox.state, "killed")
      assert.deepStrictEqual(yield* cloud.phone.ListProjects(), [])
      yield* cloud.close
    })
  )

  it.live("keeps the sandbox running through a long turn: resumes it if paused, cycles it before the run cap", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const { sandbox, env } = envFileOf(cloud, project.id)
      const dreamd = yield* cloud.sandbox(env.DREAM_PROJECT_TOKEN)
      const store = Context.get((yield* Effect.promise(() => cloud.project(project.id))).context, Store)
      /** The next keepalive tick, without waiting five minutes. */
      const tick = Effect.andThen(store.setTimer("turn-keepalive", 0), cloud.alarm(project.id))
      yield* dreamd.ReportTurn({ state: "started", eventIds: [] })
      assert.strictEqual(sandbox.timeoutSeconds, 15 * 60)

      // E2B pauses it mid-turn (the run cap); nothing sends it traffic. The next keepalive resumes it.
      sandbox.state = "paused"
      yield* tick
      assert.strictEqual(sandbox.state, "running")
      assert.strictEqual(sandbox.resumes, 1)

      // Running, far from the cap: just extends the timeout.
      sandbox.timeoutSeconds = 0
      yield* tick
      assert.strictEqual(sandbox.timeoutSeconds, 15 * 60)
      assert.strictEqual(sandbox.pauses, 0)

      // Within a tick of the 1-hour cap: pauses and resumes it now, which restarts E2B's clock.
      sandbox.startedAt = DateTime.subtract(yield* DateTime.now, { minutes: 55 })
      yield* tick
      assert.strictEqual(sandbox.pauses, 1)
      assert.strictEqual(sandbox.resumes, 2)
      assert.strictEqual(sandbox.state, "running")

      // After the turn, the keepalive stops and the sandbox gets the idle timeout.
      yield* dreamd.ReportTurn({ state: "finished", eventIds: [] })
      sandbox.state = "paused"
      yield* tick
      assert.strictEqual(sandbox.state, "paused")
      yield* cloud.close
    })
  )
})
