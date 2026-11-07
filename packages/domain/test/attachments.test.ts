/**
 * Photos and files they attach (November 2026): the shapes on the wire, what older apps and dreamd builds make of
 * them, the names Dream uses for paths, and how the turn prompt names the files.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import {
  AgentEvent,
  type Attachment,
  AttachmentName,
  AuthedAppRpcs,
  attachmentPath,
  type EventId,
  formatBytes,
  type MediaId,
  MediaRef,
  type MessageId,
  type ProjectId,
  renderAgentEvent,
  safeAttachmentName,
  TextMessage,
  uniqueAttachmentNames
} from "../src/index.ts"

const roundTrip = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: S["Type"]) => {
  const codec = Schema.toCodecJson(schema)
  const wire = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(value)))
  return { wire, decoded: Schema.decodeUnknownSync(codec)(wire) }
}

const photo: Attachment = {
  id: "med_photo" as MediaId,
  name: "IMG_0042.jpg",
  contentType: "image/jpeg",
  sizeBytes: 412_000,
  width: 2048,
  height: 1536
}
const sheet: Attachment = {
  id: "med_sheet" as MediaId,
  name: "lifts-2024.xlsx",
  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sizeBytes: 86_016
}
const at = DateTime.makeUnsafe("2026-11-04T22:02:00Z")
const fields = { id: "evt_1" as EventId, at, messageId: "msg_q" as MessageId }

describe("attachments on the wire", () => {
  it("round-trips a message and an event with attachments", () => {
    const message = TextMessage.make({
      id: "msg_q" as MessageId,
      projectId: "prj_1" as ProjectId,
      createdAt: at,
      from: "user",
      text: "",
      media: [],
      attachments: [photo, sheet]
    })
    assert.deepStrictEqual(roundTrip(TextMessage, message).decoded, message)
    const event = AgentEvent.cases.UserMessage.make({ ...fields, text: "Here", attachments: [photo] })
    assert.deepStrictEqual(roundTrip(AgentEvent, event).decoded, event)
  })

  it("leaves older apps and dreamd builds reading the message without them", () => {
    // The shapes as they were before attachments.
    const OldTextMessage = Schema.TaggedStruct("Text", {
      id: Schema.String,
      projectId: Schema.String,
      createdAt: Schema.DateTimeUtc,
      from: Schema.Literals(["agent", "user"]),
      text: Schema.String,
      media: Schema.Array(MediaRef)
    })
    const OldUserMessage = Schema.TaggedStruct("UserMessage", {
      id: Schema.String,
      at: Schema.DateTimeUtc,
      messageId: Schema.String,
      text: Schema.String
    })
    const message = roundTrip(
      TextMessage,
      TextMessage.make({
        id: "msg_q" as MessageId,
        projectId: "prj_1" as ProjectId,
        createdAt: at,
        from: "user",
        text: "Here",
        media: [],
        attachments: [photo]
      })
    ).wire
    const old = Schema.decodeUnknownSync(Schema.toCodecJson(OldTextMessage))(message)
    assert.strictEqual(old.text, "Here")
    const event = roundTrip(
      AgentEvent,
      AgentEvent.cases.UserMessage.make({ ...fields, text: "Hi", attachments: [sheet] })
    )
    assert.strictEqual(Schema.decodeUnknownSync(Schema.toCodecJson(OldUserMessage))(event.wire).text, "Hi")
  })

  it("takes SendMessage as older phones send it, and with attachments", () => {
    const send = AuthedAppRpcs.requests.get("SendMessage")!
    const before = { projectId: "prj_1" as ProjectId, text: "Track sets too" }
    assert.deepStrictEqual(roundTrip(send.payloadSchema, before).decoded, before)
    const now = { projectId: "prj_1" as ProjectId, text: "", attachments: [photo.id, sheet.id] }
    assert.deepStrictEqual(roundTrip(send.payloadSchema, now).decoded, now)
    assert.throws(() =>
      Schema.decodeUnknownSync(Schema.toCodecJson(send.payloadSchema))({
        ...now,
        attachments: Array.from({ length: 11 }, (_, i) => `med_${i}`)
      })
    )
  })

  it("refuses attachments past the size limit and odd content types", () => {
    const upload = AuthedAppRpcs.requests.get("CreateAttachmentUpload")!
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(upload.payloadSchema))
    assert.deepStrictEqual(decode({ name: "menu.pdf", contentType: "application/pdf", sizeBytes: 9 }), {
      name: "menu.pdf",
      contentType: "application/pdf",
      sizeBytes: 9
    })
    assert.throws(() => decode({ name: "menu.pdf", contentType: "pdf", sizeBytes: 9 }))
    assert.throws(() => roundTrip(TextMessage.fields.attachments, [{ ...photo, sizeBytes: 26 * 1024 * 1024 }]))
  })
})

describe("attachment names", () => {
  it("makes any name safe for a path", () => {
    assert.strictEqual(safeAttachmentName("../../etc/passwd"), "-..-etc-passwd")
    assert.strictEqual(safeAttachmentName(".env"), "env")
    assert.strictEqual(safeAttachmentName("  "), "attachment")
    assert.strictEqual(safeAttachmentName("a/b\\c\nd.txt"), "a-b-c-d.txt")
    const long = safeAttachmentName(`${"x".repeat(200)}.pdf`)
    assert.strictEqual(long.length, 120)
    assert.isTrue(long.endsWith(".pdf"))
    for (const name of ["../../etc/passwd", ".env", `${"y".repeat(300)}.jpeg`, "\u0000"]) {
      assert.doesNotThrow(() => Schema.decodeUnknownSync(AttachmentName)(safeAttachmentName(name)))
    }
    assert.throws(() => Schema.decodeUnknownSync(AttachmentName)("a/b"))
    assert.throws(() => Schema.decodeUnknownSync(AttachmentName)(".."))
  })

  it("numbers repeated names within a message", () => {
    const names = uniqueAttachmentNames([photo, photo, { ...photo, name: "img_0042.JPG" }, sheet]).map((a) => a.name)
    assert.deepStrictEqual(names, ["IMG_0042.jpg", "IMG_0042 2.jpg", "img_0042 3.JPG", "lifts-2024.xlsx"])
  })

  it("formats sizes", () => {
    assert.strictEqual(formatBytes(900), "900 bytes")
    assert.strictEqual(formatBytes(86_016), "84 KB")
    assert.strictEqual(formatBytes(3_250_000), "3.1 MB")
    assert.strictEqual(formatBytes(2 * 1024 * 1024), "2 MB")
  })
})

describe("the turn prompt", () => {
  it("names where each file is", () => {
    const one = AgentEvent.cases.UserMessage.make({ ...fields, text: "This is the whiteboard", attachments: [photo] })
    assert.strictEqual(
      renderAgentEvent(one),
      "[Wed, Nov 4, 10:02 PM] They wrote (msg_q):\n> This is the whiteboard\n" +
        "They attached a photo: /home/user/.dream/attachments/msg_q/IMG_0042.jpg (photo, 2048×1536, 402 KB)"
    )
    const two = AgentEvent.cases.UserMessage.make({ ...fields, text: "", attachments: [photo, sheet] })
    assert.strictEqual(
      renderAgentEvent(two),
      "[Wed, Nov 4, 10:02 PM] They sent (msg_q) 2 files:\n" +
        "- /home/user/.dream/attachments/msg_q/IMG_0042.jpg (photo, 2048×1536, 402 KB)\n" +
        "- /home/user/.dream/attachments/msg_q/lifts-2024.xlsx " +
        "(application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, 84 KB)"
    )
    assert.strictEqual(attachmentPath("msg_q", sheet), "/home/user/.dream/attachments/msg_q/lifts-2024.xlsx")
  })

  it("says when a file couldn't be copied in", () => {
    const event = AgentEvent.cases.UserMessage.make({ ...fields, text: "Menu", attachments: [sheet] })
    assert.include(
      renderAgentEvent(event, { missingAttachments: new Set([sheet.id]) }),
      "They attached a file: lifts-2024.xlsx (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, " +
        "84 KB), which Dream couldn't copy into the sandbox"
    )
  })

  it("renders a message without attachments as before", () => {
    const plain = AgentEvent.cases.UserMessage.make({ ...fields, text: "And Android?" })
    assert.strictEqual(renderAgentEvent(plain), "[Wed, Nov 4, 10:02 PM] They wrote (msg_q):\n> And Android?")
  })
})
