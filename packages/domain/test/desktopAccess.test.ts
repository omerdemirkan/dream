/**
 * Finishing an access request on a computer (November 2026): the card's `desktop` field, what older apps make of
 * it, which requests can be emailed, and the `EmailAccessLink` RPC on the wire.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import {
  AccessMessage,
  AccessState,
  AuthedAppRpcs,
  canFinishOnDesktop,
  Message,
  type MessageId,
  type ProjectId,
  Routes
} from "../src/index.ts"

const at = DateTime.makeUnsafe("2026-11-07T12:00:00Z")
const codec = Schema.toCodecJson(Message)

const card = AccessMessage.make({
  id: "msg_k" as MessageId,
  projectId: "prj_1" as ProjectId,
  createdAt: at,
  request: {
    _tag: "Key",
    service: "Stripe",
    host: "api.stripe.com",
    header: "Authorization",
    format: "Bearer {key}"
  },
  why: "Take payments",
  state: AccessState.cases.Open.make({}),
  desktop: { sentAt: at, to: "ada@example.com", openedAt: DateTime.add(at, { minutes: 3 }) }
})

const wire = (message: Message) => JSON.parse(JSON.stringify(Schema.encodeSync(codec)(message)))

describe("desktop access", () => {
  it("round-trips the card with and without desktop", () => {
    assert.deepStrictEqual(Schema.decodeUnknownSync(codec)(wire(card)), card)
    const { desktop: _, ...plain } = card
    const before = AccessMessage.make(plain)
    assert.deepStrictEqual(Schema.decodeUnknownSync(codec)(wire(before)), before)
    assert.strictEqual("desktop" in wire(before), false)
  })

  it("leaves older apps reading the card without it", () => {
    // AccessMessage as TestFlight builds before this change have it: the same fields, no `desktop`.
    const { desktop: _, ...fields } = AccessMessage.fields
    const OldAccessMessage = Schema.Struct(fields)
    const OldMessage = Schema.Union([OldAccessMessage])
    const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(OldMessage))(wire(card))
    assert.strictEqual(decoded.why, "Take payments")
    assert.strictEqual(decoded.state._tag, "Open")
    assert.strictEqual("desktop" in decoded, false)
  })

  it("offers it only for requests still waiting, and never for app notifications", () => {
    assert.isTrue(canFinishOnDesktop(card))
    assert.isTrue(
      canFinishOnDesktop({
        ...card,
        state: AccessState.cases.Disconnected.make({
          integrationId: "int_1" as never,
          disconnectedAt: at,
          reason: "removed"
        })
      })
    )
    assert.isFalse(
      canFinishOnDesktop({
        ...card,
        state: AccessState.cases.Connected.make({ integrationId: "int_1" as never, connectedAt: at })
      })
    )
    assert.isFalse(canFinishOnDesktop({ ...card, state: AccessState.cases.Declined.make({ declinedAt: at }) }))
    assert.isFalse(
      canFinishOnDesktop({
        ...card,
        request: { _tag: "Notifications", app: "app_1" as never, name: "Shelf", often: "daily" }
      })
    )
  })

  it("defines EmailAccessLink with the project and message only", () => {
    const rpc = AuthedAppRpcs.requests.get("EmailAccessLink")!
    const payload = { projectId: "prj_1" as ProjectId, messageId: "msg_k" as MessageId }
    assert.deepStrictEqual(Schema.decodeUnknownSync(Schema.toCodecJson(rpc.payloadSchema))(payload), payload)
  })

  it("keeps the emailed token out of the path and query", () => {
    assert.strictEqual(Routes.desktop, "/desktop")
    assert.strictEqual(Routes.desktopAccess("dsk_1"), "/desktop/dsk_1")
  })
})
