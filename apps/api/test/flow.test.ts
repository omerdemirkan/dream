/**
 * The control plane end to end, in memory: the phone and dreamd talk to the
 * Worker over real RPC; ProjectDOs run on their own SQLite; providers are
 * fakes that record what they were asked.
 */
import { assert, describe, it } from "@effect/vitest"
import { DaemonEnvFile, type NotificationId, type ProjectId, QuestionAnswer, RequestId } from "@dream/domain"
import { Context, DateTime, Effect, Exit, Fiber, Option, Redacted, Stream } from "effect"
import { gateway } from "../src/http/Gateway.ts"
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
      assert.strictEqual(project.title, "Strength log")
      assert.strictEqual(project.phase, "new")
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

  it.live("retried writes (a lost response) don't post twice or wake the agent twice", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)

      // A new idea, sent twice with one request id: one project.
      const ideaRequest = RequestId.make("7d0b6f1e-2c4a-4e8b-9f3d-1a2b3c4d5e6f")
      const idea = { idea: "A cabin booking site", requestId: ideaRequest }
      const first = yield* cloud.phone.CreateProject(idea)
      const again = yield* cloud.phone.CreateProject(idea)
      assert.strictEqual(again.id, first.id)
      assert.strictEqual((yield* cloud.phone.ListProjects()).length, 2)

      // A message, sent twice with one request id: one message, one wake.
      const before = cloud.world.delivered.length
      const say = { projectId: project.id, text: "Track sets too", requestId: RequestId.make(crypto.randomUUID()) }
      const sent = yield* cloud.phone.SendMessage(say)
      const resent = yield* cloud.phone.SendMessage(say)
      assert.strictEqual(resent.id, sent.id)
      const history = yield* cloud.phone.ListMessages({ projectId: project.id })
      assert.strictEqual(history.messages.filter((m) => m._tag === "Text" && m.text === "Track sets too").length, 1)
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, before + 1)

      // The same answer twice: answered once, delivered once.
      const question = yield* dreamd.AskQuestion({ question: "Who'll use this?", options: ["Just me", "Friends"] })
      const answer = {
        projectId: project.id,
        messageId: question.id,
        answer: QuestionAnswer.cases.Choice.make({ option: "Just me" })
      }
      yield* cloud.phone.AnswerQuestion(answer)
      yield* cloud.phone.AnswerQuestion(answer)
      yield* cloud.alarm(project.id)
      assert.deepStrictEqual(
        cloud.world.delivered.at(-1)!.events.map((e: any) => e._tag),
        ["QuestionAnswered"]
      )
      const delivered = cloud.world.delivered.length
      yield* cloud.phone.AnswerQuestion(answer)
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, delivered)

      // Declining twice: the second returns the declined request instead of failing.
      const request = yield* dreamd.RequestAccess({
        request: {
          _tag: "Key",
          service: "Stripe",
          host: "api.stripe.com",
          header: "Authorization",
          format: "Bearer {key}"
        },
        why: "Take payments."
      })
      const declined = yield* cloud.phone.DeclineAccess({ projectId: project.id, messageId: request.id })
      const redeclined = yield* cloud.phone.DeclineAccess({ projectId: project.id, messageId: request.id })
      assert.strictEqual(redeclined.state._tag, "Declined")
      assert.deepStrictEqual(redeclined.state, declined.state)
      yield* cloud.close
    })
  )

  it.live("access requests: a key for a host no request goes to is refused, not shown", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const error = yield* dreamd
        .RequestAccess({
          request: {
            _tag: "Key",
            service: "Spotify",
            host: "spotify-oauth",
            header: "Authorization",
            format: "Bearer {key}"
          },
          why: "Keep your client id and secret."
        })
        .pipe(Effect.flip)
      assert.strictEqual(error._tag, "InvalidRequest")
      assert.include(error.message, '--host "spotify-oauth"')
      const history = yield* cloud.phone.ListMessages({ projectId: project.id })
      assert.isFalse(history.messages.some((message) => message._tag === "Access"))
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

  it.live("access requests: a file key goes into its project's sandbox only, and nowhere it could be shown", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const fakeKey = "123456:FAKE-telegram-token-for-tests"
      const path = "/home/user/.dream/keys/telegram-bot-token"

      const badName = yield* dreamd
        .RequestAccess({ request: { _tag: "File", service: "Telegram", name: "../env" }, why: "Run the bot." })
        .pipe(Effect.flip)
      assert.strictEqual(badName._tag, "InvalidRequest")

      const request = yield* dreamd.RequestAccess({
        request: { _tag: "File", service: "Telegram", name: "telegram-bot-token" },
        why: "Your bot token, so the brief arrives in Telegram."
      })
      const connected = yield* cloud.phone.SubmitKeyAccess({
        projectId: project.id,
        messageId: request.id,
        key: Redacted.make(` ${fakeKey}\n`)
      })
      assert.strictEqual(connected.state._tag, "Connected")
      const { sandbox } = envFileOf(cloud, project.id)
      assert.notInclude(JSON.stringify(sandbox.rules), fakeKey)

      // Written before the agent hears about it: mode 0600 in a 0700 folder, and never in a command line.
      yield* cloud.alarm(project.id)
      assert.strictEqual(sandbox.files.get(path), fakeKey)
      const commands = cloud.world.processes.filter((p) => p.sandboxId === sandbox.access.sandboxId)
      assert.isTrue(commands.some((p) => p.command.includes("install -d -m 700 /home/user/.dream/keys")))
      assert.isTrue(
        commands.some((p) => p.command.includes(`chmod 600 /home/user/.dream/keys/.telegram-bot-token.partial`))
      )
      assert.isFalse(cloud.world.processes.some((p) => p.command.includes(fakeKey)))
      const event: any = cloud.world.delivered.at(-1)!.events[0]
      assert.strictEqual(event._tag, "AccessConnected")
      assert.deepStrictEqual(event.access, {
        _tag: "File",
        service: "Telegram",
        name: "telegram-bot-token",
        path,
        projectId: project.id
      })

      // Nothing that reaches the person may carry it.
      const leak = yield* dreamd
        .SendMessage({ text: `Token is ${fakeKey}`, media: [], notify: false })
        .pipe(Effect.flip)
      assert.strictEqual(leak._tag, "InvalidRequest")
      const asked = yield* dreamd.AskQuestion({ question: `Is ${fakeKey} right?`, options: [] }).pipe(Effect.flip)
      assert.strictEqual(asked._tag, "InvalidRequest")
      const status = yield* dreamd.UpdateStatus({ now: `Using ${fakeKey}` }).pipe(Effect.flip)
      assert.strictEqual(status._tag, "InvalidRequest")
      yield* dreamd.SendMessage({ text: "The bot is live.", media: [], notify: false })
      const history = yield* cloud.phone.ListMessages({ projectId: project.id })
      assert.notInclude(JSON.stringify(history), fakeKey)

      // It's this project's alone: listed here, not in another project of theirs, and kept out of its sandbox.
      assert.deepStrictEqual(
        (yield* dreamd.ListAccess()).map((i) => i.access._tag),
        ["File"]
      )
      const other = yield* cloud.phone.CreateProject({ idea: "A second idea." })
      yield* cloud.alarm(other.id)
      const otherEnv = envFileOf(cloud, other.id)
      const otherDreamd = yield* cloud.sandbox(otherEnv.env.DREAM_PROJECT_TOKEN)
      assert.deepStrictEqual(yield* otherDreamd.ListAccess(), [])
      assert.isUndefined(otherEnv.sandbox.files.get(path))
      yield* otherDreamd.SendMessage({ text: `Unrelated ${fakeKey}`, media: [], notify: false })

      // Entering it again replaces the file.
      const again = yield* dreamd.RequestAccess({
        request: { _tag: "File", service: "Telegram", name: "telegram-bot-token" },
        why: "The old token stopped working."
      })
      yield* cloud.phone.SubmitKeyAccess({
        projectId: project.id,
        messageId: again.id,
        key: Redacted.make("654321:FAKE-rotated")
      })
      yield* cloud.alarm(project.id)
      assert.strictEqual(sandbox.files.get(path), "654321:FAKE-rotated")
      assert.strictEqual((yield* cloud.phone.ListIntegrations()).filter((i) => i.access._tag === "File").length, 1)

      // A new sandbox gets it too.
      sandbox.state = "killed"
      cloud.world.deliverFails = true
      yield* cloud.phone.SendMessage({ projectId: project.id, text: "Still there?" })
      yield* cloud.alarm(project.id)
      cloud.world.deliverFails = false
      const { storage } = yield* Effect.promise(() => cloud.project(project.id))
      storage.db.exec("UPDATE timers SET due_ms = 0 WHERE name = 'deliver'")
      yield* cloud.alarm(project.id)
      const recreated = [...cloud.world.sandboxes.values()].filter((s) => s.metadata.projectId === project.id).at(-1)!
      assert.notStrictEqual(recreated.access.sandboxId, sandbox.access.sandboxId)
      assert.strictEqual(recreated.files.get(path), "654321:FAKE-rotated")

      // Removing it in Settings deletes the file and tells the agent.
      const integration = (yield* cloud.phone.ListIntegrations()).find((i) => i.access._tag === "File")!
      yield* cloud.phone.DisconnectIntegration({ integrationId: integration.id })
      yield* cloud.alarm(project.id)
      assert.isUndefined(recreated.files.get(path))
      const removed: any = cloud.world.delivered.at(-1)!.events.at(-1)
      assert.strictEqual(removed._tag, "AccessRemoved")
      assert.strictEqual(removed.access.path, path)
      assert.deepStrictEqual(yield* dreamd.ListAccess(), [])
      yield* cloud.close
    })
  )

  it.live("archiving a project deletes its file keys", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const request = yield* dreamd.RequestAccess({
        request: { _tag: "File", service: "SMTP", name: "smtp-password" },
        why: "Send the digest by email."
      })
      yield* cloud.phone.SubmitKeyAccess({
        projectId: project.id,
        messageId: request.id,
        key: Redacted.make("FAKE-smtp-pass")
      })
      assert.strictEqual((yield* cloud.phone.ListIntegrations()).length, 1)
      const clients = Context.get(cloud.workerContext, ProjectClients)
      yield* clients.use(project.id, (client) => client.Archive())
      assert.deepStrictEqual(yield* cloud.phone.ListIntegrations(), [])
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

  it.live("the first turn moves the phase on from new, and never overrides the agent's phase", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const live = yield* cloud.live(project.id)
      const snapshot = Effect.map(live.Subscribe().pipe(Stream.take(1), Stream.runCollect), ([first]) =>
        first?._tag === "Snapshot" ? first : assert.fail("expected a Snapshot")
      )
      assert.strictEqual((yield* snapshot).status.phase, "new")

      yield* dreamd.ReportTurn({ state: "started", eventIds: [] })
      const [row] = yield* cloud.phone.ListProjects()
      assert.strictEqual(row?.project.phase, "exploring")
      assert.strictEqual(row?.project.title, "Strength log")
      const started = yield* snapshot
      assert.strictEqual(started.project.phase, "exploring")
      assert.strictEqual(started.status.phase, "exploring")
      assert.strictEqual((yield* dreamd.GetStatus()).phase, "exploring")
      yield* dreamd.ReportTurn({ state: "finished", eventIds: [] })

      // Once the agent has set a phase, later turns leave it alone, even "new".
      yield* dreamd.UpdateStatus({ title: "Lift Log", phase: "new" })
      yield* dreamd.ReportTurn({ state: "started", eventIds: [] })
      assert.strictEqual((yield* cloud.phone.ListProjects())[0]?.project.phase, "new")
      assert.strictEqual((yield* cloud.phone.ListProjects())[0]?.project.title, "Lift Log")
      assert.strictEqual((yield* snapshot).status.phase, "new")
      yield* cloud.close
    })
  )

  it.live("the gateway says plainly when nothing is published yet", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      const host = new URL(project.publicUrl).host
      const response = yield* gateway(host, new Request(project.publicUrl)).pipe(
        Effect.provideContext(cloud.workerContext)
      )
      assert.strictEqual(response.status, 404)
      const body = response.body._tag === "Uint8Array" ? new TextDecoder().decode(response.body.body) : ""
      assert.include(body, "Not published yet")
      assert.include(body, "still being built")
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

describe("sandbox refresh", () => {
  /** The newest build is cached for a while; pretend that while has passed. */
  const forgetLatest = (core: Context.Service.Shape<typeof Core>) =>
    Effect.flatMap(core.sandbox, ({ latestBuild: _, ...rest }) => core.saveSandbox(rest))

  /** A project whose sandbox was created from build "b1" of the template, and has had its first delivery. */
  const started = (cloud: Cloud) =>
    Effect.gen(function* () {
      cloud.world.templateBuilds.set("dream-sandbox", { build: "b1", release: "r1" })
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const { sandbox, env } = envFileOf(cloud, project.id)
      const instance = yield* Effect.promise(() => cloud.project(project.id))
      const core = Context.get(instance.context, Core)
      const store = Context.get(instance.context, Store)
      const dreamd = yield* cloud.sandbox(env.DREAM_PROJECT_TOKEN)
      /** A new message, delivered by the next alarm. */
      const say = (text: string) =>
        Effect.andThen(cloud.phone.SendMessage({ projectId: project.id, text }), cloud.alarm(project.id))
      /** The commands run in the project's sandbox, from the n-th on. */
      const commands = (from = 0) =>
        cloud.world.processes
          .filter((p) => p.sandboxId === sandbox.access.sandboxId)
          .slice(from)
          .map((p) => p.command)
      const donors = () => [...cloud.world.sandboxes.values()].filter((s) => s.metadata.purpose === "refresh-donor")
      return { project, sandbox, core, store, dreamd, say, commands, donors }
    })

  it.live("records the build a sandbox is created from, and leaves it alone while that's the newest", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { core, say, donors } = yield* started(cloud)
      assert.strictEqual((yield* core.sandbox).templateBuild, "b1")
      assert.strictEqual((yield* core.sandbox).release, "r1")
      yield* say("Track sets too")
      assert.strictEqual(cloud.world.delivered.length, 2)
      assert.lengthOf(donors(), 0)

      // A rebuild of the same source is a new build with the same release tag: nothing to bring over, no donor.
      cloud.world.templateBuilds.set("dream-sandbox", { build: "b2", release: "r1" })
      yield* forgetLatest(core)
      yield* say("And rest times")
      assert.lengthOf(donors(), 0)
      assert.strictEqual((yield* core.sandbox).templateBuild, "b2")
      yield* cloud.close
    })
  )

  it.live(
    "a newer build is brought over from a donor before the next delivery, which then goes to the new dreamd",
    () =>
      Effect.gen(function* () {
        const cloud = yield* makeCloud()
        const { sandbox, core, say, commands, donors } = yield* started(cloud)
        cloud.world.templateBuilds.set("dream-sandbox", { build: "b2", release: "r2" })
        yield* forgetLatest(core)
        const before = commands().length
        yield* say("Track sets too")

        const [donor] = donors()
        assert.strictEqual(donor?.state, "killed")
        const run = commands(before)
        const stage = run.findIndex((c) => c.includes("curl"))
        const activate = run.findIndex((c) => c.includes("bash /opt/dream-refresh.sh activate"))
        const commit = run.findIndex((c) => c.includes("bash /opt/dream-refresh.sh commit"))
        assert.isTrue(stage >= 0 && stage < activate && activate < commit, run.join("\n"))
        assert.strictEqual(sandbox.release, "r2")
        const record = yield* core.sandbox
        assert.strictEqual(record.templateBuild, "b2")
        assert.strictEqual(record.release, "r2")
        assert.strictEqual(cloud.world.delivered.length, 2)

        // Done: the next delivery doesn't refresh again.
        yield* say("And rest times")
        assert.lengthOf(donors(), 1)
        assert.strictEqual(cloud.world.delivered.length, 3)
        yield* cloud.close
      })
  )

  it.live("never during a turn: it waits, and runs shortly after the turn ends", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { sandbox, core, store, dreamd, say, donors, project } = yield* started(cloud)
      cloud.world.templateBuilds.set("dream-sandbox", { build: "b2", release: "r2" })
      yield* forgetLatest(core)
      yield* dreamd.ReportTurn({ state: "started", eventIds: [] })
      yield* say("Track sets too")
      assert.lengthOf(donors(), 0)
      assert.strictEqual(cloud.world.delivered.length, 2)

      // dreamd says a turn is running even though the DO missed it: still nothing.
      yield* dreamd.ReportTurn({ state: "finished", eventIds: [] })
      cloud.world.turns.set(sandbox.access.sandboxId, "running")
      yield* Effect.andThen(store.setTimer("sandbox-refresh", 0), cloud.alarm(project.id))
      assert.lengthOf(donors(), 0)

      // Idle: the timer the end of the turn set does it.
      cloud.world.turns.delete(sandbox.access.sandboxId)
      yield* dreamd.ReportTurn({ state: "finished", eventIds: [] })
      const due = yield* store.dueTimers(Date.now() + 61_000)
      assert.include(due, "sandbox-refresh")
      yield* Effect.andThen(store.setTimer("sandbox-refresh", 0), cloud.alarm(project.id))
      assert.lengthOf(donors(), 1)
      assert.strictEqual(sandbox.release, "r2")
      assert.strictEqual((yield* core.sandbox).templateBuild, "b2")
      yield* cloud.close
    })
  )

  it.live("a failed refresh rolls back, is recorded, isn't retried for a while, and doesn't hold up delivery", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { sandbox, core, say, commands, donors } = yield* started(cloud)
      cloud.world.templateBuilds.set("dream-sandbox", { build: "b2", release: "r2" })
      yield* forgetLatest(core)
      cloud.world.runResults.set("refresh.sh activate", { exitCode: 1, output: "claude: not found" })
      const before = commands().length
      yield* say("Track sets too")

      assert.isTrue(commands(before).some((c) => c.includes("bash /opt/dream-refresh.sh rollback")))
      assert.strictEqual(sandbox.release, "r1")
      const record = yield* core.sandbox
      assert.strictEqual(record.templateBuild, "b1")
      assert.strictEqual(record.refreshFailure?.build, "b2")
      assert.strictEqual(record.refreshFailure?.failures, 1)
      assert.include(record.refreshFailure?.message ?? "", "claude: not found")
      assert.strictEqual(cloud.world.delivered.length, 2)

      // Not again for that build until the backoff passes.
      yield* say("And rest times")
      assert.lengthOf(donors(), 1)
      assert.strictEqual(cloud.world.delivered.length, 3)

      // A newer build is tried at once.
      cloud.world.runResults.clear()
      cloud.world.templateBuilds.set("dream-sandbox", { build: "b3", release: "r3" })
      yield* forgetLatest(core)
      yield* say("Thanks")
      assert.strictEqual(sandbox.release, "r3")
      const after = yield* core.sandbox
      assert.strictEqual(after.templateBuild, "b3")
      assert.isUndefined(after.refreshFailure)
      yield* cloud.close
    })
  )

  it.live("without a release tag on the build, a new build id is what makes it due, and the donor says the rest", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { sandbox, core, say, donors } = yield* started(cloud)
      cloud.world.untaggedBuilds = true
      cloud.world.templateBuilds.set("dream-sandbox", { build: "b2", release: "r2" })
      yield* forgetLatest(core)
      yield* say("Track sets too")
      assert.lengthOf(donors(), 1)
      assert.strictEqual(sandbox.release, "r2")
      assert.strictEqual((yield* core.sandbox).templateBuild, "b2")
      yield* cloud.close
    })
  )

  it.live("a template built before refreshing existed is noted once and left alone", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { core, say, commands, donors } = yield* started(cloud)
      cloud.world.templateBuilds.set("dream-sandbox", { build: "b2", release: undefined })
      yield* forgetLatest(core)
      const before = commands().length
      yield* say("Track sets too")
      assert.lengthOf(donors(), 1)
      assert.isFalse(commands(before).some((c) => c.includes("refresh.sh")))
      assert.strictEqual((yield* core.sandbox).templateBuild, "b2")
      yield* cloud.close
    })
  )
})
