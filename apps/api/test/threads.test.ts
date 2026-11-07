/**
 * Threads in the control plane: their reply in a message's thread and the agent's (`--reply-to`), which go in the
 * thread's workstream and reach the agent with the message they answer; and a question the agent changes in place.
 */
import { assert, describe, it } from "@effect/vitest"
import { type AgentEvent, DaemonEnvFile, type MessageId, type ProjectId, type WorkstreamId } from "@dream/domain"
import { Effect, Fiber, Redacted, Stream } from "effect"
import { makeCloud } from "./support/Cloud.ts"

const claudeUrl =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"
const claudeToken = `sk-ant-oat01-${"x".repeat(60)}`

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const setup = (cloud: Cloud) =>
  Effect.gen(function* () {
    const signedIn = yield* cloud.phone.DevSignIn({ email: "ada@example.com", secret: Redacted.make("dev-secret") })
    cloud.session.token = Redacted.value(signedIn.sessionToken)
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
    const project = yield* cloud.phone.CreateProject({ idea: "A shared kitty for group trips." })
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

const userMessages = (cloud: Cloud) =>
  cloud.world.delivered
    .flatMap((d) => d.events as ReadonlyArray<AgentEvent>)
    .filter((e): e is Extract<AgentEvent, { _tag: "UserMessage" }> => e._tag === "UserMessage")

describe("threads", () => {
  it.live("their reply goes in the thread and its workstream, and reaches the agent with what it answers", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const timer = (yield* dreamd.StartWorkstream({ title: "Rest timer" })).workstreams[0]!
      const update = yield* dreamd.SendMessage({
        text: "The rest timer now counts down on your lock screen.",
        media: [],
        notify: false,
        workstream: timer.id
      })
      const reply = yield* cloud.phone.SendMessage({
        projectId: project.id,
        text: "Can it buzz my watch too?",
        replyTo: update.id
      })
      assert.strictEqual(reply.replyTo, update.id)
      assert.strictEqual(reply.workstream, timer.id)
      // A reply to a reply goes into the same thread; a workstream they name is the thread's, whatever it says.
      const again = yield* cloud.phone.SendMessage({
        projectId: project.id,
        text: "And skip it when I'm on a call?",
        replyTo: reply.id,
        workstream: "ws_other" as WorkstreamId
      })
      assert.strictEqual(again.replyTo, update.id)
      assert.strictEqual(again.workstream, timer.id)

      yield* cloud.alarm(project.id)
      const [, first] = userMessages(cloud)
      assert.deepStrictEqual(first?.thread, {
        messageId: update.id,
        from: "agent",
        kind: "text",
        excerpt: "The rest timer now counts down on your lock screen."
      })
      assert.deepStrictEqual(first?.workstream, { id: timer.id, title: "Rest timer" })

      const thread = yield* cloud.phone.ListThread({ projectId: project.id, messageId: again.id })
      assert.strictEqual(thread.root.id, update.id)
      assert.deepStrictEqual(
        thread.replies.map((m) => m.id),
        [reply.id, again.id]
      )
      const missing = yield* cloud.phone
        .SendMessage({ projectId: project.id, text: "Hm", replyTo: "msg_nope" as MessageId })
        .pipe(Effect.flip)
      assert.strictEqual(missing._tag, "NotFound")
      yield* cloud.close
    })
  )

  it.live("the agent replies in a thread with --reply-to, on their message or its own", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const android = (yield* dreamd.StartWorkstream({ title: "Android?" })).workstreams[0]!
      const theirs = yield* cloud.phone.SendMessage({ projectId: project.id, text: "Should we do Android?" })
      const answer = yield* dreamd.SendMessage({
        text: "Most of it carries over; Health Connect is the work.",
        media: [],
        notify: false,
        replyTo: theirs.id
      })
      assert.strictEqual(answer.replyTo, theirs.id)
      assert.notProperty(answer, "workstream")
      // A thread on a labeled message keeps its label, and a different --work is refused.
      const labeled = yield* dreamd.SendMessage({
        text: "I'll find out what it costs.",
        media: [],
        notify: false,
        workstream: android.id
      })
      const asked = yield* dreamd.AskQuestion({
        question: "Play Store under your name or a company's?",
        options: ["Mine", "A company's"],
        replyTo: labeled.id
      })
      assert.strictEqual(asked.replyTo, labeled.id)
      assert.strictEqual(asked.workstream, android.id)
      const timer = (yield* dreamd.StartWorkstream({ title: "Rest timer" })).workstreams.find(
        (w) => w.title === "Rest timer"
      )!
      const clash = yield* dreamd
        .SendMessage({ text: "x", media: [], notify: false, workstream: timer.id, replyTo: labeled.id })
        .pipe(Effect.flip)
      assert.strictEqual(clash._tag, "InvalidRequest")
      const access = yield* dreamd.RequestAccess({
        request: { _tag: "Apple" },
        why: "Add your Apple Developer key to put it on your phone.",
        replyTo: asked.id
      })
      assert.strictEqual(access.replyTo, labeled.id)
      const nowhere = yield* dreamd
        .SendMessage({ text: "x", media: [], notify: false, replyTo: "msg_nope" as MessageId })
        .pipe(Effect.flip)
      assert.strictEqual(nowhere._tag, "NotFound")
      yield* cloud.close
    })
  )

  it.live("an open question changes in place, and an answer to what it was is turned away", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      const { project, dreamd } = yield* setup(cloud)
      const asked = yield* dreamd.AskQuestion({
        question: "Which sound should the rest timer end with?",
        options: ["Soft chime", "Three short buzzes", "Rising tone"],
        why: "You'll hear it mid-set.",
        meanwhile: "Wiring the timer itself."
      })
      const live = yield* cloud.live(project.id)
      const changed = yield* live.Subscribe().pipe(
        Stream.filter((e) => e._tag === "MessageChanged"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Effect.sleep("50 millis")
      const revised = yield* dreamd.ReviseQuestion({
        messageId: asked.id,
        options: ["A chime that gets louder", "Soft chime", "Three short buzzes"],
        why: null
      })
      assert.deepStrictEqual(revised.options, ["A chime that gets louder", "Soft chime", "Three short buzzes"])
      assert.notProperty(revised, "why")
      assert.strictEqual(revised.meanwhile, "Wiring the timer itself.")
      assert.strictEqual(revised.question, asked.question)
      assert.strictEqual(revised.id, asked.id)
      assert.strictEqual(revised.notificationId, asked.notificationId)
      assert.isDefined(revised.revisedAt)
      assert.strictEqual(revised.state._tag, "Open")
      const [event] = yield* Fiber.join(changed)
      assert.deepStrictEqual(event?._tag === "MessageChanged" && event.message, revised)

      const same = yield* dreamd
        .ReviseQuestion({ messageId: asked.id, options: [...revised.options] })
        .pipe(Effect.flip)
      assert.strictEqual(same._tag, "InvalidRequest")

      // Their pick from before the change no longer exists.
      const stale = yield* cloud.phone
        .AnswerQuestion({
          projectId: project.id,
          messageId: asked.id,
          answer: { _tag: "Choice", option: "Rising tone" }
        })
        .pipe(Effect.flip)
      assert.strictEqual(stale._tag, "InvalidRequest")
      assert.include(stale._tag === "InvalidRequest" ? stale.message : "", "changed this question")
      yield* cloud.phone.AnswerQuestion({
        projectId: project.id,
        messageId: asked.id,
        answer: { _tag: "Choice", option: "A chime that gets louder" }
      })
      const late = yield* dreamd.ReviseQuestion({ messageId: asked.id, question: "Which sound?" }).pipe(Effect.flip)
      assert.strictEqual(late._tag, "InvalidRequest")
      const text = yield* dreamd.SendMessage({ text: "Hi", media: [], notify: false })
      const notQuestion = yield* dreamd.ReviseQuestion({ messageId: text.id, question: "?" }).pipe(Effect.flip)
      assert.strictEqual(notQuestion._tag, "NotFound")
      yield* cloud.close
    })
  )
})
