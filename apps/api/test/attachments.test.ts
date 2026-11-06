/**
 * Photos and files they attach: the phone starts an upload, PUTs the bytes, and sends the ids with a message or a new
 * idea; the message and the agent's event carry them, the phone loads them back, and dreamd fetches them with its
 * project token (and no other project's).
 */
import { assert, describe, it } from "@effect/vitest"
import { type AgentEvent, DaemonEnvFile, type MediaId, type ProjectId, RequestId } from "@dream/domain"
import { Effect, Exit, Layer, Redacted, Schema } from "effect"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { route } from "../src/http/Router.ts"
import { makeCloud } from "./support/Cloud.ts"
import { makeR2 } from "./support/R2.ts"

const claudeUrl =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&scope=user%3Ainference&state=abc"
const claudeToken = `sk-ant-oat01-${"x".repeat(60)}`

type Cloud = Effect.Success<ReturnType<typeof makeCloud>>

const signIn = (cloud: Cloud, email: string) =>
  Effect.gen(function* () {
    const signedIn = yield* cloud.phone.DevSignIn({ email, secret: Redacted.make("dev-secret") })
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
    yield* cloud.phone.CompleteModelConnection({ connectionId: started.connection.id, code: Redacted.make("c#s") })
    return Redacted.value(signedIn.sessionToken)
  })

const tokenOf = (cloud: Cloud, projectId: ProjectId): string => {
  const sandbox = [...cloud.world.sandboxes.values()].find((s) => s.metadata.projectId === projectId)!
  const line = sandbox.files
    .get(DaemonEnvFile)!
    .split("\n")
    .find((l) => l.startsWith("DREAM_PROJECT_TOKEN="))!
  return JSON.parse(line.slice("DREAM_PROJECT_TOKEN=".length))
}

const fetchRoute = (cloud: Cloud, url: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const raw = new Request(url, init)
    const response = yield* route(raw).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(raw)),
      Effect.provide(Layer.succeedContext(cloud.workerContext))
    )
    const web = HttpServerResponse.toWeb(response)
    return { status: web.status, bytes: new Uint8Array(yield* Effect.promise(() => web.arrayBuffer())) }
  })

/** Starts an upload and PUTs `bytes` where it says. */
const attach = (cloud: Cloud, name: string, contentType: string, bytes: Uint8Array, size = bytes.length) =>
  Effect.gen(function* () {
    const { attachment, upload } = yield* cloud.phone.CreateAttachmentUpload({ name, contentType, sizeBytes: size })
    const put = yield* fetchRoute(cloud, upload.url, { method: upload.method, headers: upload.headers, body: bytes })
    return { attachment, status: put.status }
  })

const userMessages = (cloud: Cloud) =>
  cloud.world.delivered
    .flatMap((d) => d.events as ReadonlyArray<AgentEvent>)
    .filter((e): e is Extract<AgentEvent, { _tag: "UserMessage" }> => e._tag === "UserMessage")

const photoBytes = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])
const pdfBytes = new TextEncoder().encode("%PDF-1.7 menu")

describe("attachments", () => {
  it.live("go with a message to Chat and to the agent, and dreamd fetches them", () =>
    Effect.gen(function* () {
      const r2 = makeR2()
      const cloud = yield* makeCloud({}, { media: r2.bucket })
      const session = yield* signIn(cloud, "ada@example.com")
      const project = yield* cloud.phone.CreateProject({ idea: "A shared kitty for group trips." })
      yield* cloud.alarm(project.id)

      const photo = yield* attach(cloud, "IMG_0042.JPG", "image/jpeg", photoBytes)
      const menu = yield* attach(cloud, "../menu.pdf", "application/pdf", pdfBytes)
      assert.strictEqual(photo.status, 204)
      assert.strictEqual(menu.attachment.name, "-menu.pdf")
      const sent = yield* cloud.phone.SendMessage({
        projectId: project.id,
        text: "",
        attachments: [photo.attachment.id, menu.attachment.id],
        requestId: RequestId.make("2d1f3f0a-4b8e-4c1d-9f3a-1a2b3c4d5e6f")
      })
      assert.strictEqual(sent.text, "")
      assert.deepStrictEqual(
        sent.attachments?.map((a) => a.name),
        ["IMG_0042.JPG", "-menu.pdf"]
      )
      // A retry hands back the same message.
      const again = yield* cloud.phone.SendMessage({
        projectId: project.id,
        text: "",
        attachments: [photo.attachment.id, menu.attachment.id],
        requestId: RequestId.make("2d1f3f0a-4b8e-4c1d-9f3a-1a2b3c4d5e6f")
      })
      assert.strictEqual(again.id, sent.id)

      yield* cloud.alarm(project.id)
      const event = userMessages(cloud).find((e) => e.messageId === sent.id)
      assert.deepStrictEqual(event?.attachments, sent.attachments)

      // The phone loads it back with its session.
      const shown = yield* fetchRoute(cloud, `https://api.dream.test/media/${photo.attachment.id}`, {
        headers: { authorization: `Bearer ${session}` }
      })
      assert.strictEqual(shown.status, 200)
      assert.deepStrictEqual(shown.bytes, photoBytes)

      // dreamd fetches it with the project token.
      const token = tokenOf(cloud, project.id)
      const fetched = yield* fetchRoute(cloud, `https://api.dream.test/sandbox/attachments/${menu.attachment.id}`, {
        headers: { authorization: `Bearer ${token}` }
      })
      assert.strictEqual(fetched.status, 200)
      assert.deepStrictEqual(fetched.bytes, pdfBytes)
      const anonymous = yield* fetchRoute(cloud, `https://api.dream.test/sandbox/attachments/${menu.attachment.id}`)
      assert.strictEqual(anonymous.status, 401)

      // Another of their projects can't take them, or fetch them.
      const other = yield* cloud.phone.CreateProject({ idea: "A packing list that learns." })
      yield* cloud.alarm(other.id)
      const taken = yield* cloud.phone
        .SendMessage({ projectId: other.id, text: "Same photo", attachments: [photo.attachment.id] })
        .pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(taken))
      const elsewhere = yield* fetchRoute(cloud, `https://api.dream.test/sandbox/attachments/${menu.attachment.id}`, {
        headers: { authorization: `Bearer ${tokenOf(cloud, other.id)}` }
      })
      assert.strictEqual(elsewhere.status, 404)

      // Deleting the project deletes them.
      yield* cloud.phone.DeleteProject({ projectId: project.id })
      assert.deepStrictEqual(cloud.db.prepare("SELECT * FROM attachments").all(), [])
      assert.isFalse([...r2.objects.keys()].some((key) => key.includes("attachments")))
      yield* cloud.close
    })
  )

  it.live("go with a new idea as its first message", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud({}, { media: makeR2().bucket })
      yield* signIn(cloud, "ada@example.com")
      const board = yield* attach(cloud, "whiteboard.jpg", "image/jpeg", photoBytes)
      const project = yield* cloud.phone.CreateProject({
        idea: "A meal planner for our week, like this whiteboard.",
        attachments: [board.attachment.id]
      })
      yield* cloud.alarm(project.id)
      const [first] = userMessages(cloud)
      assert.strictEqual(first?.text, project.idea)
      assert.deepStrictEqual(first?.attachments, [board.attachment])
      const listed = yield* cloud.phone.ListMessages({ projectId: project.id })
      const idea = listed.messages.find((m) => m._tag === "Text" && m.from === "user")
      assert.deepStrictEqual(idea?._tag === "Text" ? idea.attachments : undefined, [board.attachment])
      yield* cloud.close
    })
  )

  it.live("refuses what isn't uploaded, isn't theirs, is the wrong size, or is empty", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud({}, { media: makeR2().bucket })
      yield* signIn(cloud, "ada@example.com")
      const project = yield* cloud.phone.CreateProject({ idea: "A shared kitty for group trips." })
      const failure = (effect: Effect.Effect<unknown, unknown>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error as { readonly message: string }).message)
        )

      assert.include(yield* failure(cloud.phone.SendMessage({ projectId: project.id, text: "  " })), "Write something")

      const pending = yield* cloud.phone.CreateAttachmentUpload({
        name: "a.txt",
        contentType: "text/plain",
        sizeBytes: 5
      })
      assert.include(
        yield* failure(
          cloud.phone.SendMessage({ projectId: project.id, text: "hi", attachments: [pending.attachment.id] })
        ),
        "hasn't finished uploading"
      )

      const short = yield* attach(cloud, "b.txt", "text/plain", new Uint8Array([1, 2]), 5)
      assert.strictEqual(short.status, 400)

      assert.include(
        yield* failure(
          cloud.phone.CreateAttachmentUpload({ name: "huge.mov", contentType: "video/quicktime", sizeBytes: 26 << 20 })
        ),
        "25 MB"
      )

      const mine = yield* attach(cloud, "c.txt", "text/plain", new Uint8Array([1]))
      yield* signIn(cloud, "grace@example.com")
      const theirs = yield* cloud.phone.CreateProject({ idea: "A recipe scaler." })
      assert.include(
        yield* failure(cloud.phone.SendMessage({ projectId: theirs.id, text: "x", attachments: [mine.attachment.id] })),
        "There's no attachment"
      )
      assert.include(
        yield* failure(
          cloud.phone.SendMessage({
            projectId: theirs.id,
            text: "x",
            attachments: [Schema.decodeSync(Schema.String)("med_nope") as MediaId]
          })
        ),
        "There's no attachment"
      )
      yield* cloud.close
    })
  )

  it.live("aren't offered without storage", () =>
    Effect.gen(function* () {
      const cloud = yield* makeCloud()
      yield* signIn(cloud, "ada@example.com")
      const error = yield* cloud.phone
        .CreateAttachmentUpload({ name: "a.jpg", contentType: "image/jpeg", sizeBytes: 3 })
        .pipe(Effect.flip)
      assert.strictEqual(error._tag, "InvalidRequest")
      yield* cloud.close
    })
  )
})
