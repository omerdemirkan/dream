/**
 * Attaching photos and files: what a composer stages and the limits it keeps, the upload (`CreateAttachmentUpload`,
 * then the bytes), and sending with them, against the fixtures backend.
 */
import { AttachmentLimits, type MediaId, type MediaUploadTarget, type ProjectId, RequestId } from "@dream/domain"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { AppClient } from "../src/data/AppClient.ts"
import { AppConfig } from "../src/data/AppConfig.ts"
import { AttachmentError, AttachmentUploads, FileTransfer } from "../src/data/AttachmentUploads.ts"
import {
  admit,
  contentTypeFor,
  fileDetail,
  isUploading,
  type PickedFile,
  readyIds,
  remove,
  scaledTo,
  settle
} from "../src/data/attachments.ts"
import { SecureStorage } from "../src/data/SecureStorage.ts"
import { Session } from "../src/data/Session.ts"
import { FakeBackend } from "../src/fake/FakeBackend.ts"
import { AppClientFake } from "../src/fake/layers.ts"

const photo: PickedFile = {
  uri: "file:///tmp/IMG_2041.jpg",
  name: "IMG_2041.jpg",
  contentType: "image/jpeg",
  sizeBytes: 412_000,
  width: 2048,
  height: 1536,
  photo: true
}
const pdf: PickedFile = {
  uri: "file:///tmp/menu.pdf",
  name: "menu.pdf",
  contentType: "application/pdf",
  sizeBytes: 9_000,
  photo: false
}
let n = 0
const key = () => `k${++n}`

describe("staging", () => {
  it("adds what fits and says what didn't", () => {
    const huge = { ...pdf, name: "scan.tiff", sizeBytes: AttachmentLimits.maxBytes + 1 }
    const first = admit([], [photo, huge], key)
    assert.deepStrictEqual(
      first.staged.map((s) => s.file.name),
      ["IMG_2041.jpg"]
    )
    assert.strictEqual(first.refused, "One file is over 25 MB, so it was left out.")
    assert.strictEqual(admit([], [huge], key).refused, "That file is over 25 MB, the most Dream can take.")

    const many = admit(
      first.staged,
      Array.from({ length: 12 }, () => pdf),
      key
    )
    assert.lengthOf(many.staged, AttachmentLimits.perMessage)
    assert.lengthOf(many.added, AttachmentLimits.perMessage - 1)
    assert.strictEqual(many.refused, "A message can carry 10 attachments.")
  })

  it("sends only what has uploaded, in the order picked", () => {
    const { staged } = admit([], [photo, pdf, photo], key)
    const [a, b, c] = staged.map((s) => s.key)
    let next = settle(staged, b!, {
      _tag: "Ready",
      attachment: { id: "med_b" as MediaId, name: "menu.pdf", contentType: "application/pdf", sizeBytes: 9_000 }
    })
    next = settle(next, a!, {
      _tag: "Ready",
      attachment: { id: "med_a" as MediaId, name: "IMG_2041.jpg", contentType: "image/jpeg", sizeBytes: 1 }
    })
    assert.isTrue(isUploading(next))
    assert.deepStrictEqual(readyIds(next), ["med_a" as MediaId, "med_b" as MediaId])
    next = remove(next, c!)
    assert.isFalse(isUploading(next))
  })

  it("downscales big photos to the limit on the long edge, and leaves small ones", () => {
    assert.deepStrictEqual(scaledTo(4032, 3024), { width: 2048, height: 1536 })
    assert.deepStrictEqual(scaledTo(3024, 4032), { width: 1536, height: 2048 })
    assert.deepStrictEqual(scaledTo(1200, 900), { width: 1200, height: 900 })
  })

  it("names content types and file details", () => {
    assert.strictEqual(
      contentTypeFor("Budget.XLSX", undefined),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert.strictEqual(contentTypeFor("notes", null), "application/octet-stream")
    assert.strictEqual(contentTypeFor("a.pdf", "Application/PDF"), "application/pdf")
    assert.strictEqual(contentTypeFor("a.pdf", "not a type"), "application/pdf")
    assert.strictEqual(fileDetail("groceries.pdf", 217_088), "PDF · 212 KB")
    assert.strictEqual(fileDetail("README", 900), "900 bytes")
  })
})

/** Just the client, the fixtures backend and a session, with uploads over `transfer`. */
const uploadsOver = (transfer: Layer.Layer<FileTransfer>) =>
  AttachmentUploads.layer.pipe(
    Layer.provide(transfer),
    Layer.provideMerge(AppClientFake),
    Layer.provideMerge(FakeBackend.layer),
    Layer.provideMerge(Session.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        AppConfig.layer({ apiUrl: "https://dream.test", backend: "fixtures" }),
        SecureStorage.layerMemory()
      )
    )
  )

const signIn = Effect.gen(function* () {
  const app = yield* AppClient
  const session = yield* Session
  const result = yield* app.DevSignIn({ email: "ada@example.com", secret: Redacted.make("fixtures") })
  yield* session.signIn({ token: result.sessionToken, user: result.user })
})

describe("uploading and sending", () => {
  it.live("uploads where the API says, then sends the ids with a message", () => {
    const puts: Array<{ readonly uri: string; readonly target: MediaUploadTarget }> = []
    const recording = Layer.succeed(
      FileTransfer,
      FileTransfer.of({ put: (uri, target) => Effect.sync(() => void puts.push({ uri, target })) })
    )
    const layer = uploadsOver(recording)
    return Effect.gen(function* () {
      yield* FakeBackend.use((backend) => backend.setPace(0))
      yield* signIn
      const uploads = yield* AttachmentUploads
      const app = yield* AppClient
      const sheet = yield* uploads.upload({ ...pdf, name: "../menu.pdf" })
      const board = yield* uploads.upload(photo)
      assert.strictEqual(sheet.name, "-menu.pdf")
      assert.deepStrictEqual(
        puts.map((p) => [p.uri, p.target.method, p.target.headers["content-type"]]),
        [
          [pdf.uri, "PUT", "application/pdf"],
          [photo.uri, "PUT", "image/jpeg"]
        ]
      )
      assert.deepStrictEqual({ width: board.width, height: board.height }, { width: 2048, height: 1536 })

      const sent = yield* app.SendMessage({
        projectId: "prj_liftlog" as ProjectId,
        text: "",
        requestId: RequestId.make("0f8b2c4e-6a1d-4e3f-9b7a-5c2d8e1f3a4b"),
        attachments: [board.id, sheet.id]
      })
      assert.strictEqual(sent.text, "")
      assert.deepStrictEqual(sent.attachments, [board, sheet])
    }).pipe(Effect.provide(layer))
  })

  it.live("goes with a new idea", () =>
    Effect.gen(function* () {
      yield* FakeBackend.use((backend) => backend.setPace(0))
      yield* signIn
      const uploads = yield* AttachmentUploads
      const app = yield* AppClient
      const board = yield* uploads.upload(photo)
      const project = yield* app.CreateProject({
        idea: "A meal planner like our whiteboard",
        requestId: RequestId.make("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
        attachments: [board.id]
      })
      const { messages } = yield* app.ListMessages({ projectId: project.id })
      const idea = messages.find((m) => m._tag === "Text" && m.from === "user")
      assert.deepStrictEqual(idea?._tag === "Text" ? idea.attachments : undefined, [board])
    }).pipe(Effect.provide(uploadsOver(FileTransfer.layerFake)))
  )

  it.effect("refuses what's too large before asking the API, and fails on a build that can't upload", () =>
    Effect.gen(function* () {
      yield* signIn
      const uploads = yield* AttachmentUploads
      const tooBig = yield* Effect.flip(uploads.upload({ ...pdf, sizeBytes: AttachmentLimits.maxBytes + 1 }))
      assert.instanceOf(tooBig, AttachmentError)
      const unavailable = yield* Effect.flip(uploads.upload(pdf))
      assert.strictEqual(unavailable.message, "This version of Dream can't send files yet.")
    }).pipe(Effect.provide(uploadsOver(FileTransfer.layerUnavailable)))
  )

  it.effect("shows a sent message with attachments in the fixtures", () =>
    Effect.gen(function* () {
      yield* signIn
      yield* FakeBackend.use((backend) => backend.scenario("attachments-sent"))
      const app = yield* AppClient
      const { messages } = yield* app.ListMessages({ projectId: "prj_liftlog" as ProjectId, limit: 200 })
      const sent = messages.find((m) => m.id === "msg_attsent")
      assert.deepStrictEqual(sent?._tag === "Text" ? sent.attachments?.map((a) => a.name) : undefined, [
        "IMG_2041.png",
        "IMG_2042.png",
        "lifts-2024.pdf"
      ])
    }).pipe(Effect.provide(uploadsOver(FileTransfer.layerFake)))
  )
})
