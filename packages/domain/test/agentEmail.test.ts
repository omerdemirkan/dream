/**
 * The agent's email (November 2026): `SendEmail`, Chat's copy (a `Text` with `email`), what older apps make of it,
 * and what `agentEmailProblem` refuses before anything is sent.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import {
  AgentEmailLimits,
  agentEmailProblem,
  EmailLimitReached,
  Message,
  SandboxRpcs,
  TextMessage
} from "../src/index.ts"

const at = DateTime.makeUnsafe("2026-11-08T15:00:00Z")
const codec = Schema.toCodecJson(Message)
const wire = (message: Message) => JSON.parse(JSON.stringify(Schema.encodeSync(codec)(message)))

const copy = TextMessage.make({
  id: "msg_email" as never,
  projectId: "prj_1" as never,
  createdAt: at,
  from: "agent",
  text: "## Register the identifier\n\n1. Open [Identifiers](https://developer.apple.com)",
  media: [],
  email: { subject: "Set up Apple Developer", to: "ada@example.com", sentAt: at }
})

describe("the agent's email", () => {
  it("round-trips Chat's copy, with the email's subject, address and time", () => {
    const encoded = wire(copy)
    assert.deepStrictEqual(encoded.email, {
      subject: "Set up Apple Developer",
      to: "ada@example.com",
      sentAt: "2026-11-08T15:00:00.000Z"
    })
    assert.deepStrictEqual(Schema.decodeUnknownSync(codec)(encoded), copy)
  })

  it("leaves older apps showing the copy as a message of the agent's", () => {
    const { email: _, ...fields } = TextMessage.fields
    const OldMessage = Schema.Union([Schema.TaggedStruct("Text", fields)])
    const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(OldMessage))(wire(copy))
    assert.strictEqual(decoded.text, copy.text)
    assert.strictEqual("email" in decoded, false)
  })

  it("names its errors so the CLI can explain them", () => {
    const rpc = SandboxRpcs.requests.get("SendEmail")!
    const error = Schema.toCodecJson(rpc.errorSchema as Schema.Codec<unknown, unknown, never, never>)
    const limit = new EmailLimitReached({ message: "That's ten today.", limit: 10 })
    const decoded = Schema.decodeUnknownSync(error)(JSON.parse(JSON.stringify(Schema.encodeSync(error)(limit))))
    assert.instanceOf(decoded, EmailLimitReached)
  })

  it("refuses a subject or body that can't go as written", () => {
    assert.isUndefined(agentEmailProblem("Set up Apple Developer", "1. Open it"))
    assert.include(agentEmailProblem("  ", "x") ?? "", "subject is empty")
    assert.include(agentEmailProblem("one\ntwo", "x") ?? "", "one line")
    assert.include(agentEmailProblem("s".repeat(AgentEmailLimits.subject + 1), "x") ?? "", "under")
    assert.include(agentEmailProblem("Steps", " \n ") ?? "", "empty")
    assert.include(agentEmailProblem("Steps", "x".repeat(AgentEmailLimits.markdown + 1)) ?? "", "at most")
  })
})
