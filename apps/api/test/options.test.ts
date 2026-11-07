/**
 * Option previews on a question (`dream ask --show`): the agent uploads what each option looks or sounds like, the
 * phone shows them with the question, and a pick can carry a note that reaches the agent.
 */
import { assert, describe, it } from "@effect/vitest"
import { type AgentEvent, DaemonEnvFile, type MediaContentType, type ProjectId, QuestionAnswer } from "@dream/domain"
import { Effect, Redacted } from "effect"
import { makeCloud } from "./support/Cloud.ts"
import { makeR2 } from "./support/R2.ts"

const claudeUrl =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"
const claudeToken = `sk-ant-oat01-${"x".repeat(60)}`

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const tokenOf = (cloud: Cloud, projectId: ProjectId): string => {
  const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === projectId)!
  const line = sandbox.files
    .get(DaemonEnvFile)!
    .split("\n")
    .find((l) => l.startsWith("DREAM_PROJECT_TOKEN="))!
  return JSON.parse(line.slice("DREAM_PROJECT_TOKEN=".length))
}

const setup = Effect.gen(function* () {
  const r2 = makeR2()
  const cloud = yield* makeCloud({}, { media: r2.bucket })
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
  yield* cloud.phone.CompleteModelConnection({ connectionId: started.connection.id, code: Redacted.make("code123#state") })
  const project = yield* cloud.phone.CreateProject({ idea: "A booking site for our family cabin." })
  yield* cloud.alarm(project.id)
  const dreamd = yield* cloud.sandbox(tokenOf(cloud, project.id))
  /** An uploaded file, as `dream` leaves it: reserved, then its bytes PUT. */
  const upload = (filename: string, contentType: MediaContentType, size: { width?: number; height?: number; durationSeconds?: number } = {}) =>
    Effect.gen(function* () {
      const { media } = yield* dreamd.CreateMediaUpload({ filename, contentType, sizeBytes: 3, ...size })
      cloud.db.prepare("UPDATE media SET uploaded_at = ? WHERE id = ?").run(new Date().toISOString(), media.id)
      return media
    })
  return { cloud, project, dreamd, upload }
})

const answers = (cloud: Cloud) =>
  cloud.world.delivered
    .flatMap((d) => d.events as ReadonlyArray<AgentEvent>)
    .filter((e): e is Extract<AgentEvent, { _tag: "QuestionAnswered" }> => e._tag === "QuestionAnswered")

describe("option previews", () => {
  it.live("show with the question in the options' order, and a pick's note reaches the agent", () =>
    Effect.gen(function* () {
      const { cloud, project, dreamd, upload } = yield* setup
      const phone = yield* upload("a-home.png", "image/png", { width: 1170, height: 2532 })
      const desktop = yield* upload("a-desk.jpg", "image/jpeg", { width: 2880, height: 1800 })
      const flow = yield* upload("b-flow.mp4", "video/mp4", { width: 780, height: 1688, durationSeconds: 9 })
      assert.deepStrictEqual([desktop.kind, desktop.width, desktop.height], ["image", 2880, 1800])
      assert.deepStrictEqual([flow.kind, flow.durationSeconds], ["video", 9])

      const asked = yield* dreamd.AskQuestion({
        question: "How should a weekend get booked?",
        options: ["Calendar first", "Requests first", "Rotation"],
        previews: [
          { option: "Requests first", media: [flow.id] },
          { option: "Calendar first", media: [phone.id, desktop.id] }
        ]
      })
      assert.deepStrictEqual(
        asked.previews?.map((p) => [p.option, p.media.map((m) => m.id)]),
        [
          ["Calendar first", [phone.id, desktop.id]],
          ["Requests first", [flow.id]]
        ]
      )
      const listed = (yield* cloud.phone.ListMessages({ projectId: project.id })).messages.find((m) => m.id === asked.id)
      assert.deepStrictEqual(listed?._tag === "Question" ? listed.previews : undefined, asked.previews)

      const note = "Yes, but open on A’s calendar so people see what’s free."
      const answered = yield* cloud.phone.AnswerQuestion({
        projectId: project.id,
        messageId: asked.id,
        answer: QuestionAnswer.cases.Choice.make({ option: "Requests first", note })
      })
      assert.deepStrictEqual(answered.state._tag === "Answered" && answered.state.answer, {
        _tag: "Choice",
        option: "Requests first",
        note
      })
      // Changing only the note is a new answer the agent hears about.
      yield* cloud.phone.AnswerQuestion({
        projectId: project.id,
        messageId: asked.id,
        answer: QuestionAnswer.cases.Choice.make({ option: "Requests first" })
      })
      yield* cloud.alarm(project.id)
      const heard = answers(cloud)
      assert.deepStrictEqual(heard.map((e) => e.answer._tag === "Choice" && e.answer.note), [note, undefined])
      yield* cloud.close
    })
  )

  it.live("refuse previews for no option, and audio anywhere but a preview", () =>
    Effect.gen(function* () {
      const { cloud, dreamd, upload } = yield* setup
      const chime = yield* upload("chime.m4a", "audio/mp4", { durationSeconds: 1.6 })
      assert.strictEqual(chime.kind, "audio")
      assert.isUndefined(chime.width)

      const wrong = yield* dreamd
        .AskQuestion({ question: "Which chime?", options: ["Soft"], previews: [{ option: "Loud", media: [chime.id] }] })
        .pipe(Effect.flip)
      assert.include(wrong.message, `"Loud" isn't one of the options`)

      const sound = yield* dreamd.AskQuestion({
        question: "Which chime?",
        options: ["Soft", "Loud"],
        previews: [{ option: "Soft", media: [chime.id] }]
      })
      assert.strictEqual(sound.previews?.[0]?.media[0]?.kind, "audio")

      const inMessage = yield* dreamd.SendMessage({ text: "Listen", media: [chime.id], notify: false }).pipe(Effect.flip)
      assert.include(inMessage.message, "only as an option's preview")
      const onStatus = yield* dreamd.UpdateStatus({ media: [chime.id] }).pipe(Effect.flip)
      assert.include(onStatus.message, "only as an option's preview")
      yield* cloud.close
    })
  )
})
