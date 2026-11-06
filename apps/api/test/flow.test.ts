/**
 * The control plane end to end, in memory: the phone and dreamd talk to the
 * Worker over real RPC; ProjectDOs run on their own SQLite; providers are
 * fakes that record what they were asked.
 */
import { assert, describe, it } from "@effect/vitest"
import {
  type AgentEvent,
  DaemonEnvFile,
  type NotificationId,
  type ProjectId,
  QuestionAnswer,
  RequestId,
  renderAgentEvent
} from "@dream/domain"
import { Context, DateTime, Effect, Exit, Fiber, Option, Redacted, Stream } from "effect"
import { gateway } from "../src/http/Gateway.ts"
import { ProjectClients } from "../src/project/Client.ts"
import { Core } from "../src/project/Core.ts"
import { Store } from "../src/project/Store.ts"
import { makeCloud } from "./support/Cloud.ts"
import { makeR2 } from "./support/R2.ts"

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
        why: "It decides whether accounts matter.",
        context: "With friends, everyone **signs in** and sees only their own lifts."
      })
      const alert = cloud.world.pushes.find((p) => p.kind === "alert")!
      assert.strictEqual(alert.token, "apns-token-1")
      assert.strictEqual((alert.payload as any).category, "question")
      assert.strictEqual((alert.payload as any).id, question.notificationId)
      assert.strictEqual((alert.payload as any).body, "Who'll use this besides you?")

      const asks = yield* cloud.phone.ListOpenAsks()
      assert.deepStrictEqual(
        asks.map((a) => a.message.id),
        [question.id]
      )
      const shown = asks[0]?.message
      assert.strictEqual(shown?._tag === "Question" ? shown.context : undefined, question.context)
      assert.include(question.context, "signs in")
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

      // Access for later is listed for older builds' deck, but doesn't make the project need them yet.
      const later = yield* dreamd.RequestAccess({
        request: {
          _tag: "Key",
          service: "Stripe",
          host: "api.stripe.com",
          header: "Authorization",
          format: "Bearer {key}"
        },
        why: "Take payments.",
        when: "around Thursday"
      })
      assert.deepStrictEqual(
        (yield* cloud.phone.ListOpenAsks()).map((a) => a.message.id),
        [later.id]
      )
      assert.strictEqual((yield* cloud.phone.ListProjects())[0]?.openAsks, 0)
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

  it.live("access requests: declining with a reason shows it on the card and tells the agent why", () =>
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
        why: "Take payments."
      })
      const declined = yield* cloud.phone.DeclineAccess({
        projectId: project.id,
        messageId: request.id,
        reason: "  Use a free option instead "
      })
      assert.deepStrictEqual(
        declined.state._tag === "Declined" ? declined.state.reason : undefined,
        "Use a free option instead"
      )
      yield* cloud.alarm(project.id)
      const last = cloud.world.delivered.at(-1)!
      assert.deepStrictEqual(
        last.events.map((e: any) => [e._tag, e.reason]),
        [["AccessDeclined", "Use a free option instead"]]
      )
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

  it.live("access requests: a retried key is no error, and a removed key's card says so and connects again", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      // This project's sandbox runs a dreamd from before releases were reported; the others' report one.
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const stripe = {
        _tag: "Key" as const,
        service: "Stripe",
        host: "api.stripe.com",
        header: "Authorization",
        format: "Bearer {key}"
      }
      const request = yield* dreamd.RequestAccess({
        request: stripe,
        why: "Take payments for cabin weekends.",
        context: "Make one at [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys)."
      })
      assert.include(request.context, "dashboard.stripe.com/apikeys")
      // The heading doesn't name Stripe, so the notification says what's asked first.
      assert.strictEqual(
        (cloud.world.pushes.findLast((p) => p.kind === "alert")?.payload as any)?.body,
        "Add your Stripe key: Take payments for cabin weekends."
      )
      const submit = { projectId: project.id, messageId: request.id, key: Redacted.make("sk_live_123") }
      const connected = yield* cloud.phone.SubmitKeyAccess(submit)
      // The response was lost and the phone sends it again: the card as it is, and the agent hears once.
      const retried = yield* cloud.phone.SubmitKeyAccess(submit)
      assert.deepStrictEqual(retried.state, connected.state)
      yield* cloud.alarm(project.id)
      assert.deepStrictEqual(
        cloud.world.delivered.at(-1)!.events.map((e: any) => e._tag),
        ["AccessConnected"]
      )
      cloud.world.templateBuilds.set("dream-sandbox", { build: "b1", release: "r1" })
      const other = yield* cloud.phone.CreateProject({ idea: "A shop for the cabin's firewood." })
      yield* cloud.alarm(other.id)
      const otherEnv = envFileOf(cloud, other.id)
      const otherDreamd = yield* cloud.sandbox(otherEnv.env.DREAM_PROJECT_TOKEN)
      const bystander = yield* cloud.phone.CreateProject({ idea: "Something that never needs Stripe." })
      yield* cloud.alarm(bystander.id)
      const bystanderSandbox = envFileOf(cloud, bystander.id).sandbox.access.sandboxId
      const otherRequest = yield* otherDreamd.RequestAccess({ request: stripe, why: "Sell firewood." })
      yield* cloud.phone.SubmitKeyAccess({ projectId: other.id, messageId: otherRequest.id, key: Redacted.make("k2") })
      yield* cloud.alarm(other.id)

      // Removed in Settings: both cards say so, every sandbox loses the rule, and the agents that asked hear,
      // except one whose dreamd is too old to know the event.
      const before = cloud.world.delivered.length
      if (connected.state._tag !== "Connected") return yield* Effect.die("not connected")
      yield* cloud.phone.DisconnectIntegration({ integrationId: connected.state.integrationId })
      const card = (yield* cloud.phone.ListMessages({ projectId: project.id })).messages.find(
        (m) => m.id === request.id
      )!
      assert.strictEqual(card._tag === "Access" && card.state._tag === "Disconnected" && card.state.reason, "removed")
      const otherCard = (yield* cloud.phone.ListMessages({ projectId: other.id })).messages.find(
        (m) => m.id === otherRequest.id
      )!
      assert.strictEqual(otherCard._tag === "Access" && otherCard.state._tag, "Disconnected")
      assert.isUndefined(envFileOf(cloud, project.id).sandbox.rules["api.stripe.com"])
      assert.isUndefined(otherEnv.sandbox.rules["api.stripe.com"])
      yield* cloud.alarm(project.id)
      yield* cloud.alarm(other.id)
      yield* cloud.alarm(bystander.id)
      const since = cloud.world.delivered.slice(before)
      assert.deepStrictEqual(
        since.map((d) => [d.sandboxId, d.events.map((e: any) => e._tag)]),
        [[otherEnv.sandbox.access.sandboxId, ["AccessRemoved"]]]
      )
      assert.isFalse(since.some((d) => d.sandboxId === bystanderSandbox))
      assert.include(
        renderAgentEvent(since[0]!.events[0] as AgentEvent),
        "They disconnected Stripe in Settings. HTTPS requests to api.stripe.com no longer carry their credential."
      )

      // The card still connects: a new key from it is a new connection, and the agent hears.
      const again = yield* cloud.phone.SubmitKeyAccess({ ...submit, key: Redacted.make("sk_live_456") })
      assert.strictEqual(again.state._tag, "Connected")
      assert.deepStrictEqual(envFileOf(cloud, project.id).sandbox.rules["api.stripe.com"], [
        { transform: { headers: { Authorization: "Bearer sk_live_456" } } }
      ])
      yield* cloud.alarm(project.id)
      assert.strictEqual((cloud.world.delivered.at(-1)!.events[0] as any)._tag, "AccessConnected")

      // So does one they declined.
      const later = yield* dreamd.RequestAccess({
        request: { ...stripe, service: "Resend", host: "api.resend.com" },
        why: "Email the booking confirmations."
      })
      yield* cloud.phone.DeclineAccess({ projectId: project.id, messageId: later.id })
      const anyway = yield* cloud.phone.SubmitKeyAccess({
        projectId: project.id,
        messageId: later.id,
        key: Redacted.make("re_123")
      })
      assert.strictEqual(anyway.state._tag, "Connected")

      // A new key from Settings goes into every sandbox's rules, quietly.
      const integration = (yield* cloud.phone.ListIntegrations()).find((i) => i.label === "Resend")!
      const delivered = cloud.world.delivered.length
      yield* cloud.phone.ReplaceKey({ integrationId: integration.id, key: Redacted.make("re_rotated") })
      assert.deepStrictEqual(otherEnv.sandbox.rules["api.resend.com"], [
        { transform: { headers: { Authorization: "Bearer re_rotated" } } }
      ])
      yield* cloud.alarm(other.id)
      assert.strictEqual(cloud.world.delivered.length, delivered)
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

      // A new key from Settings rewrites the file before the agent hears, naming the card it came through.
      const integration = (yield* cloud.phone.ListIntegrations()).find((i) => i.access._tag === "File")!
      const fresh = { integrationId: integration.id, key: Redacted.make("777:FAKE-from-settings") }
      yield* cloud.phone.ReplaceKey(fresh)
      yield* cloud.phone.ReplaceKey(fresh)
      const deliveries = cloud.world.delivered.length
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, deliveries + 1)
      assert.strictEqual(cloud.world.delivered.at(-1)!.events.length, 1)
      assert.strictEqual(recreated.files.get(path), "777:FAKE-from-settings")
      const replaced: any = cloud.world.delivered.at(-1)!.events.at(-1)
      assert.strictEqual(replaced._tag, "AccessConnected")
      assert.strictEqual(replaced.change, "replaced")
      assert.strictEqual(replaced.messageId, again.id)
      assert.include(renderAgentEvent(replaced), "restart it so it reads the file again")
      assert.isFalse(cloud.world.processes.some((p) => p.command.includes("777:FAKE-from-settings")))

      // Removing it in Settings deletes the file, tells the agent, and both its cards say so.
      yield* cloud.phone.DisconnectIntegration({ integrationId: integration.id })
      yield* cloud.alarm(project.id)
      assert.isUndefined(recreated.files.get(path))
      const removed: any = cloud.world.delivered.at(-1)!.events.at(-1)
      assert.strictEqual(removed._tag, "AccessRemoved")
      assert.strictEqual(removed.access.path, path)
      assert.deepStrictEqual(yield* dreamd.ListAccess(), [])
      const cards = (yield* cloud.phone.ListMessages({ projectId: project.id })).messages.filter(
        (m) => m._tag === "Access"
      )
      assert.deepStrictEqual(
        cards.map((m) => m._tag === "Access" && m.state._tag),
        ["Disconnected", "Disconnected"]
      )
      const gone = yield* cloud.phone
        .ReplaceKey({ integrationId: integration.id, key: Redacted.make("x") })
        .pipe(Effect.flip)
      assert.strictEqual(gone._tag, "NotFound")
      yield* cloud.close
    })
  )

  it.live("retiring a project deletes its file keys", () =>
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
      yield* clients.use(project.id, (client) => client.Delete())
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

  it.live("records each turn's tokens and the windows around it, and tells the phone its share of the week", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      const now = yield* DateTime.now
      const fiveResets = DateTime.add(now, { hours: 3 })
      const weekResets = DateTime.add(now, { days: 4 })
      const report = (five: number, week: number) =>
        Effect.flatMap(DateTime.now, (observedAt) =>
          dreamd.ReportUsage({
            usage: {
              provider: "claude",
              plan: "Claude Max",
              fiveHour: { usedPercent: five, resetsAt: fiveResets },
              weekly: { usedPercent: week, resetsAt: weekResets },
              observedAt
            }
          })
        )
      yield* report(10, 20)

      const live = yield* cloud.live(project.id)
      const pushed = yield* live.Subscribe().pipe(
        Stream.filter((event) => event._tag === "Usage"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Effect.sleep("50 millis")
      yield* dreamd.ReportTurn({ state: "started", eventIds: [] })
      yield* report(14, 22)
      yield* dreamd.ReportTurn({
        state: "finished",
        eventIds: [],
        usage: {
          tokens: { input: 1_200, cacheRead: 40_000, cacheWrite: 3_000, output: 2_500 },
          costUsd: 0.42,
          subagents: "included"
        }
      })

      const rows = cloud.db.prepare("SELECT * FROM turn_usage ORDER BY started_at").all() as Array<any>
      assert.strictEqual(rows.length, 1)
      assert.strictEqual(rows[0].project_id, project.id)
      assert.strictEqual(rows[0].provider, "claude")
      assert.strictEqual(rows[0].output_tokens, 2_500)
      assert.strictEqual(rows[0].cost_usd, 0.42)
      assert.strictEqual(rows[0].subagents, "included")
      assert.deepStrictEqual([rows[0].five_hour_before_percent, rows[0].weekly_before_percent], [10, 20])
      assert.deepStrictEqual([rows[0].five_hour_after_percent, rows[0].weekly_after_percent], [14, 22])
      assert.strictEqual(rows[0].weekly_after_resets_at, DateTime.formatIso(weekResets))

      const [event] = yield* Fiber.join(pushed)
      assert.strictEqual(event?._tag, "Usage")
      const glance = event?._tag === "Usage" ? event.usage : assert.fail("expected Usage")
      assert.strictEqual(glance.billing, "subscription")
      assert.deepStrictEqual(glance.weekly, { usedPercent: 22, projectPercent: 2, resetsAt: weekResets })

      const sheet = yield* cloud.phone.GetProjectUsage({ projectId: project.id })
      assert.strictEqual(sheet.plan, "Claude Max")
      assert.strictEqual(sheet.week.tokens, 6_700)
      assert.strictEqual(sheet.week.cacheReadTokens, 40_000)
      assert.strictEqual(sheet.today.tokens, 6_700)
      assert.strictEqual(sheet.fiveHour.sharePercent, 4)
      assert.deepStrictEqual(sheet.fiveHourWindow, { usedPercent: 14, projectPercent: 4, resetsAt: fiveResets })
      assert.deepStrictEqual(
        sheet.projects.map((p) => [p.projectId, p.title, p.sharePercent]),
        [[project.id, project.title, 2]]
      )
      assert.strictEqual(sheet.outsideDreamPercent, 20)
      assert.strictEqual(sheet.subagents, "included")

      // An older dreamd reports no tokens: the turn is still recorded, and still credited with the rise.
      yield* dreamd.ReportTurn({ state: "started", eventIds: [] })
      yield* report(16, 23)
      yield* dreamd.ReportTurn({ state: "finished", eventIds: [] })
      const old = cloud.db.prepare("SELECT * FROM turn_usage ORDER BY started_at").all() as Array<any>
      assert.strictEqual(old.length, 2)
      assert.isNull(old[1].output_tokens)
      assert.strictEqual(old[1].weekly_before_percent, 22)
      const after = yield* cloud.phone.GetProjectUsage({ projectId: project.id })
      assert.strictEqual(after.week.tokens, 6_700)
      assert.strictEqual(after.week.sharePercent, 3)
      // The tokens shown are still only the first turn's, which counted its subagents.
      assert.strictEqual(after.subagents, "included")

      // Settings' plan card: the same windows and shares, seen from all their projects.
      const account = yield* cloud.phone.GetAccountUsage({ provider: "claude" })
      assert.strictEqual(account.plan, "Claude Max")
      assert.deepStrictEqual(account.weekly, { usedPercent: 23, dreamPercent: 3, resetsAt: weekResets })
      assert.deepStrictEqual(
        account.projects.map((p) => [p.projectId, p.sharePercent]),
        [[project.id, 3]]
      )
      assert.strictEqual(account.outsideDreamPercent, 20)
      // No ChatGPT subscription is connected.
      const none = yield* Effect.flip(cloud.phone.GetAccountUsage({ provider: "chatgpt" }))
      assert.strictEqual(none._tag, "NotFound")

      // Someone else's project is not found.
      const other = yield* cloud.phone.DevSignIn({ email: "other@example.com", secret: Redacted.make("dev-secret") })
      cloud.session.token = Redacted.value(other.sessionToken)
      const denied = yield* Effect.flip(cloud.phone.GetProjectUsage({ projectId: project.id }))
      assert.strictEqual(denied._tag, "NotFound")
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

  it.live("tells the phone and Home when the agent starts, works and is done, and when it saw their message", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      const live = yield* cloud.live(project.id)
      const snapshot = Effect.map(live.Subscribe().pipe(Stream.take(1), Stream.runCollect), ([first]) =>
        first?._tag === "Snapshot" ? first : assert.fail("expected a Snapshot")
      )
      const home = Effect.map(cloud.phone.ListProjects(), ([row]) => row ?? assert.fail("expected a project"))
      const idea = (yield* snapshot).messages[0]
      assert.strictEqual(idea?._tag === "Text" && idea.from, "user")
      assert.deepStrictEqual((yield* snapshot).activity, { state: "idle" })

      // Delivering the idea brings the sandbox up: "starting" until a turn takes it, and the idea reads "Seen".
      const changes = yield* live.Subscribe().pipe(
        Stream.filter((event) => event._tag === "ActivityChanged" || event._tag === "MessageChanged"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Effect.sleep("50 millis")
      yield* cloud.alarm(project.id)
      const pushed = yield* Fiber.join(changes)
      assert.deepStrictEqual(pushed.map((event) => event._tag).sort(), ["ActivityChanged", "MessageChanged"])
      const delivered = cloud.world.delivered.at(-1)!.events as ReadonlyArray<AgentEvent>
      const starting = yield* snapshot
      assert.strictEqual(starting.activity?.state, "starting")
      assert.isDefined(starting.activity?.since)
      assert.strictEqual((yield* home).activity?.state, "starting")
      const seen = starting.messages[0]
      assert.isTrue(seen?._tag === "Text" && seen.seenAt !== undefined)
      // Chat history from ListMessages carries it too.
      const history = yield* cloud.phone.ListMessages({ projectId: project.id })
      assert.isTrue(history.messages.some((m) => m._tag === "Text" && m.from === "user" && m.seenAt !== undefined))

      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      yield* dreamd.ReportTurn({ state: "started", eventIds: delivered.map((event) => event.id) })
      const working = yield* snapshot
      assert.strictEqual(working.activity?.state, "working")
      assert.isDefined(working.activity?.since)
      assert.isTrue(working.working)
      assert.strictEqual((yield* home).activity?.state, "working")

      yield* dreamd.ReportTurn({ state: "finished", eventIds: delivered.map((event) => event.id) })
      const done = (yield* snapshot).activity
      assert.strictEqual(done?.state, "idle")
      assert.isDefined(done?.since)
      assert.isTrue(done?.since !== undefined && done.awakeUntil !== undefined && done.awakeUntil > done.since)
      assert.strictEqual((yield* home).activity?.state, "idle")

      // A scheduled wake is the next thing Home can say about a sleeping project.
      const wake = yield* dreamd.ScheduleWake({ when: { _tag: "Cron", expression: "55 6 * * *" }, why: "Brief" })
      assert.deepStrictEqual((yield* snapshot).activity?.nextWakeAt, wake.nextAt)
      assert.deepStrictEqual((yield* home).activity?.nextWakeAt, wake.nextAt)
      yield* dreamd.CancelWake({ wakeId: wake.id })
      assert.isUndefined((yield* home).activity?.nextWakeAt)
      yield* cloud.close
    })
  )

  it.live("stops saying starting when delivery fails, or when only a scheduled command was delivered", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      const home = Effect.map(cloud.phone.ListProjects(), ([row]) => row ?? assert.fail("expected a project"))
      cloud.world.deliverFails = true
      yield* cloud.alarm(project.id)
      assert.strictEqual((yield* home).activity?.state, "idle")
      cloud.world.deliverFails = false
      const storage = (yield* Effect.promise(() => cloud.project(project.id))).storage
      storage.db.exec("UPDATE timers SET due_ms = 0 WHERE name IN ('deliver', 'sandbox-retry')")
      yield* cloud.alarm(project.id)
      assert.strictEqual((yield* home).activity?.state, "starting")
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      yield* dreamd.ReportTurn({ state: "started", eventIds: [] })
      yield* dreamd.ReportTurn({ state: "finished", eventIds: [] })

      yield* dreamd.ScheduleWake({
        when: { _tag: "At", at: DateTime.add(yield* DateTime.now, { milliseconds: 200 }) },
        why: "Check the digest",
        run: "node check.js"
      })
      yield* Effect.sleep("300 millis")
      yield* cloud.alarm(project.id)
      assert.strictEqual((cloud.world.delivered.at(-1)!.events[0] as AgentEvent)._tag, "WakeDue")
      assert.strictEqual((yield* home).activity?.state, "idle")
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

  it.live("retiring stops the project for good: no sandbox, no deliveries, gone from Home", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const clients = Context.get(cloud.workerContext, ProjectClients)
      yield* cloud.phone.SendMessage({ projectId: project.id, text: "One more thing" })
      yield* clients.use(project.id, (client) => client.Delete())
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

describe("archiving a project (theirs, reversible)", () => {
  const bodyOf = (response: { readonly body: any }) =>
    response.body._tag === "Uint8Array" ? new TextDecoder().decode(response.body.body) : ""

  it.live(
    "puts it away: off Home and the deck, nothing delivered, sandbox paused, link down; restore brings it all back",
    () =>
      Effect.gen(function* () {
        const cloud = yield* makeCloud()
        const { project } = yield* setup(cloud)
        yield* cloud.alarm(project.id)
        const { sandbox, env } = envFileOf(cloud, project.id)
        const dreamd = yield* cloud.sandbox(env.DREAM_PROJECT_TOKEN)
        yield* dreamd.AskQuestion({ question: "Kilograms or pounds?", options: ["kg", "lb"] })
        yield* dreamd.Publish({ port: 3000 })
        yield* dreamd.StartLiveActivity({ content: { title: "Building", step: { current: 1, total: 3 } } })
        yield* cloud.phone.RegisterLiveActivity({
          projectId: project.id,
          deviceId: "8f14e45f-ceea-4e7b-9a0c-6a3f1b2c3d4e" as any,
          activityId: "activity-1",
          pushToken: "live-token-1"
        })

        const archived = yield* cloud.phone.ArchiveProject({ projectId: project.id })
        assert.isDefined(cloud.world.pushes.find((p) => p.kind === "live:end"))
        assert.strictEqual(archived.project.id, project.id)
        assert.deepStrictEqual(yield* cloud.phone.ListProjects(), [])
        assert.deepStrictEqual(yield* cloud.phone.ListOpenAsks(), [])
        const listed = yield* cloud.phone.ListArchivedProjects()
        assert.deepStrictEqual(
          listed.map((row) => [row.project.id, row.archivedAt]),
          [[project.id, archived.archivedAt]]
        )
        assert.strictEqual(sandbox.state, "paused")
        // Archiving again changes nothing.
        const again = yield* cloud.phone.ArchiveProject({ projectId: project.id })
        assert.deepStrictEqual(again.archivedAt, archived.archivedAt)

        // A message sent meanwhile waits; the published link says it's put away rather than waking the sandbox.
        yield* cloud.phone.SendMessage({ projectId: project.id, text: "Pounds, actually" })
        yield* cloud.alarm(project.id)
        assert.strictEqual(cloud.world.delivered.length, 1)
        assert.strictEqual(sandbox.state, "paused")
        const host = new URL(project.publicUrl).host
        const page = yield* gateway(host, new Request(project.publicUrl)).pipe(
          Effect.provideContext(cloud.workerContext)
        )
        assert.strictEqual(page.status, 404)
        assert.include(bodyOf(page), "archived it")

        const restored = yield* cloud.phone.RestoreProject({ projectId: project.id })
        assert.strictEqual(restored.project.id, project.id)
        assert.strictEqual(restored.openAsks, 1)
        assert.deepStrictEqual(
          (yield* cloud.phone.ListProjects()).map((row) => row.project.id),
          [project.id]
        )
        assert.strictEqual((yield* cloud.phone.ListOpenAsks()).length, 1)
        assert.deepStrictEqual(yield* cloud.phone.ListArchivedProjects(), [])
        yield* cloud.alarm(project.id)
        assert.strictEqual(cloud.world.delivered.length, 2)
        assert.deepStrictEqual(
          cloud.world.delivered[1]?.events.map((e: any) => e.text),
          ["Pounds, actually"]
        )
        // The same sandbox, with everything in it.
        assert.strictEqual(envFileOf(cloud, project.id).sandbox, sandbox)
        yield* cloud.close
      })
  )

  it.live("pauses a running turn with the sandbox, and restarts it on restore", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const { sandbox, env } = envFileOf(cloud, project.id)
      const dreamd = yield* cloud.sandbox(env.DREAM_PROJECT_TOKEN)
      yield* dreamd.ReportTurn({ state: "started", eventIds: [] })
      const core = Context.get((yield* Effect.promise(() => cloud.project(project.id))).context, Core)
      const store = Context.get((yield* Effect.promise(() => cloud.project(project.id))).context, Store)

      yield* cloud.phone.ArchiveProject({ projectId: project.id })
      assert.strictEqual(sandbox.state, "paused")
      const held = yield* core.sandbox
      assert.isFalse(held.working)
      assert.isTrue(held.interruptedTurn)
      assert.strictEqual((yield* core.activity).state, "idle")
      // No keepalive wakes it while it's archived.
      assert.deepStrictEqual(yield* store.dueTimers(Number.MAX_SAFE_INTEGER), [])
      yield* cloud.alarm(project.id)
      assert.strictEqual(sandbox.state, "paused")

      const written = sandbox.files.get(DaemonEnvFile)!
      sandbox.files.set(DaemonEnvFile, "before the restore")
      yield* cloud.phone.RestoreProject({ projectId: project.id })
      yield* cloud.alarm(project.id)
      // dreamd was restarted (its env file rewritten), so the paused turn's events go to a fresh turn.
      assert.strictEqual(sandbox.state, "running")
      assert.strictEqual(sandbox.files.get(DaemonEnvFile)?.split("\n")[0], written.split("\n")[0])
      assert.isUndefined((yield* core.sandbox).interruptedTurn)
      yield* cloud.close
    })
  )

  it.live("holds its wakes while archived, and fires the ones that came due once it's restored", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      yield* dreamd.ScheduleWake({
        when: { _tag: "At", at: DateTime.add(yield* DateTime.now, { milliseconds: 200 }) },
        why: "Check the digest"
      })
      yield* cloud.phone.ArchiveProject({ projectId: project.id })
      yield* Effect.sleep("300 millis")
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 1)
      assert.strictEqual((yield* dreamd.ListWakes()).length, 1)

      yield* cloud.phone.RestoreProject({ projectId: project.id })
      yield* cloud.alarm(project.id)
      const [due] = cloud.world.delivered.at(-1)!.events as ReadonlyArray<AgentEvent>
      assert.strictEqual(due?._tag, "WakeDue")
      assert.strictEqual(cloud.world.delivered.length, 2)
      yield* cloud.close
    })
  )

  it.live("only their owner can archive, restore or list them", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.phone.ArchiveProject({ projectId: project.id })
      const other = yield* cloud.phone.DevSignIn({ email: "someone@else.com", secret: Redacted.make("dev-secret") })
      cloud.session.token = Redacted.value(other.sessionToken)
      assert.strictEqual((yield* Effect.flip(cloud.phone.RestoreProject({ projectId: project.id })))._tag, "NotFound")
      assert.strictEqual((yield* Effect.flip(cloud.phone.ArchiveProject({ projectId: project.id })))._tag, "NotFound")
      assert.deepStrictEqual(yield* cloud.phone.ListArchivedProjects(), [])
      yield* cloud.close
    })
  )
})

describe("deleting a project (theirs, for good)", () => {
  const bodyOf = (response: { readonly body: any }) =>
    response.body._tag === "Uint8Array" ? new TextDecoder().decode(response.body.body) : ""

  it.live(
    "deletes the sandbox, its rows, file keys and media, withdraws its notifications, and takes the link down",
    () =>
      Effect.gen(function* () {
        const r2 = makeR2()
        const cloud = yield* makeCloud({}, { media: r2.bucket })
        const { project } = yield* setup(cloud)
        yield* cloud.alarm(project.id)
        const { sandbox, env } = envFileOf(cloud, project.id)
        const dreamd = yield* cloud.sandbox(env.DREAM_PROJECT_TOKEN)
        const question = yield* dreamd.AskQuestion({ question: "Kilograms or pounds?", options: ["kg", "lb"] })
        const request = yield* dreamd.RequestAccess({
          request: { _tag: "File", service: "SMTP", name: "smtp-password" },
          why: "Send the digest by email."
        })
        yield* cloud.phone.SubmitKeyAccess({ projectId: project.id, messageId: request.id, key: Redacted.make("pass") })
        const upload = yield* dreamd.CreateMediaUpload({ filename: "shot.png", contentType: "image/png", sizeBytes: 3 })
        yield* Effect.promise(() =>
          r2.bucket.put(`projects/${project.id}/media/${upload.media.id}`, new Uint8Array([1, 2, 3]))
        )
        yield* dreamd.StartLiveActivity({ content: { title: "Building", step: { current: 1, total: 3 } } })
        yield* cloud.phone.RegisterLiveActivity({
          projectId: project.id,
          deviceId: "8f14e45f-ceea-4e7b-9a0c-6a3f1b2c3d4e" as any,
          activityId: "activity-1",
          pushToken: "live-token-1"
        })
        yield* dreamd.Publish({ port: 3000 })
        yield* dreamd.ScheduleWake({ when: { _tag: "Cron", expression: "55 6 * * *" }, why: "Brief" })

        yield* cloud.phone.DeleteProject({ projectId: project.id })

        assert.strictEqual(sandbox.state, "killed")
        assert.deepStrictEqual(yield* cloud.phone.ListProjects(), [])
        assert.deepStrictEqual(yield* cloud.phone.ListOpenAsks(), [])
        assert.deepStrictEqual(yield* cloud.phone.ListArchivedProjects(), [])
        assert.deepStrictEqual(yield* cloud.phone.ListIntegrations(), [])
        assert.strictEqual(r2.objects.size, 0)
        assert.deepStrictEqual(cloud.db.prepare("SELECT * FROM media").all(), [])
        // Its notifications stay, withdrawn, so the phone learns they're stale; the usage ledger keeps its minutes.
        assert.deepStrictEqual(
          (yield* cloud.phone.FilterStaleNotifications({ notificationIds: [question.notificationId!] })).stale,
          [question.notificationId!]
        )
        const withdrawn = cloud.world.pushes
          .filter((p) => p.kind === "silent" && (p.payload as any)._tag === "Withdraw")
          .flatMap((p) => (p.payload as any).notificationIds)
        assert.include(withdrawn, question.notificationId)
        assert.isDefined(cloud.world.pushes.find((p) => p.kind === "live:end"))

        // The DO keeps only its tombstone.
        const storage = (yield* Effect.promise(() => cloud.project(project.id))).storage
        for (const table of ["messages", "schedules", "events", "timers", "project", "status", "sandbox"]) {
          assert.deepStrictEqual(storage.db.prepare(`SELECT * FROM ${table}`).all(), [], table)
        }
        assert.strictEqual(storage.db.prepare("SELECT * FROM archived").all().length, 1)

        const host = new URL(project.publicUrl).host
        const page = yield* gateway(host, new Request(project.publicUrl)).pipe(
          Effect.provideContext(cloud.workerContext)
        )
        assert.strictEqual(page.status, 404)
        assert.include(bodyOf(page), "Nothing here")
        assert.strictEqual((yield* Effect.flip(cloud.phone.DeleteProject({ projectId: project.id })))._tag, "NotFound")
        assert.strictEqual(
          (yield* Effect.flip(cloud.phone.SendMessage({ projectId: project.id, text: "Still there?" })))._tag,
          "NotFound"
        )
        yield* cloud.close
      })
  )

  it.live("nothing late brings it back: no wake, delivery or agent message after a delete mid-turn", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project } = yield* setup(cloud)
      yield* cloud.alarm(project.id)
      const dreamd = yield* cloud.sandbox(envFileOf(cloud, project.id).env.DREAM_PROJECT_TOKEN)
      yield* dreamd.ReportTurn({ state: "started", eventIds: [] })
      yield* dreamd.ScheduleWake({
        when: { _tag: "At", at: DateTime.add(yield* DateTime.now, { milliseconds: 200 }) },
        why: "Check the digest"
      })
      yield* cloud.phone.SendMessage({ projectId: project.id, text: "One more thing" })
      const instance = yield* Effect.promise(() => cloud.project(project.id))
      const alarms = instance.storage.alarms.length

      yield* cloud.phone.DeleteProject({ projectId: project.id })
      yield* Effect.sleep("300 millis")
      yield* cloud.alarm(project.id)
      // A delivery that was due finds it deleted, even with an event put back in the inbox.
      const store = Context.get(instance.context, Store)
      const core = Context.get(instance.context, Core)
      yield* core.enqueue({ _tag: "Alert", id: "evt_late" as any, at: yield* DateTime.now, reason: "late" })
      yield* cloud.alarm(project.id)
      assert.strictEqual(cloud.world.delivered.length, 1)
      assert.strictEqual(
        [...cloud.world.sandboxes.values()].filter((s) => s.metadata.projectId === project.id && s.state !== "killed")
          .length,
        0
      )
      assert.deepStrictEqual(yield* store.dueTimers(Number.MAX_SAFE_INTEGER), [])
      // The last thing the native alarm was told is to clear.
      assert.isAbove(instance.storage.alarms.length, alarms)
      assert.isNull(instance.storage.alarms.at(-1))
      // The agent's sandbox can't post anything more.
      assert.isTrue(
        Exit.isFailure(yield* dreamd.SendMessage({ text: "Done!", media: [], notify: true }).pipe(Effect.exit))
      )
      assert.deepStrictEqual(yield* cloud.phone.ListProjects(), [])
      yield* cloud.close
    })
  )
})
