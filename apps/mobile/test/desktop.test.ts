/** Finishing an access request on a computer: what the card's row says about the emailed link. */
import { assert, describe, it } from "@effect/vitest"
import type { AccessMessage } from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { DateTime, Schema } from "effect"
import { TolerantMessage } from "../src/data/Tolerant.ts"
import { desktopStatus } from "../src/ui/desktopStatus.ts"

const sentAt = DateTime.makeUnsafe("2026-11-07T12:00:00Z")
const open: AccessMessage = { ...Fx.gmailAccess, state: { _tag: "Open" } }
const sent: AccessMessage = { ...open, desktop: { sentAt, to: "ada@example.com" } }
const minutes = (n: number) => DateTime.toEpochMillis(sentAt) + n * 60_000

describe("desktop status", () => {
  it("follows the link from not sent to sent, opened or expired", () => {
    assert.deepStrictEqual(desktopStatus(open, minutes(0)), { _tag: "NotSent" })
    assert.deepStrictEqual(desktopStatus(sent, minutes(29)), { _tag: "Sent", to: "ada@example.com" })
    assert.deepStrictEqual(desktopStatus(sent, minutes(30)), { _tag: "Expired", to: "ada@example.com" })
    const opened: AccessMessage = { ...open, desktop: { sentAt, to: "ada@example.com", openedAt: sentAt } }
    assert.deepStrictEqual(desktopStatus(opened, minutes(45)), { _tag: "Opened", to: "ada@example.com" })
  })

  it("reads the card's desktop field off the wire", () => {
    const codec = Schema.toCodecJson(TolerantMessage)
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(sent)))
    assert.strictEqual(wire.desktop.to, "ada@example.com")
    assert.deepStrictEqual(Schema.decodeUnknownSync(codec)(wire), sent)
  })
})
