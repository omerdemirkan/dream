import { assert, describe, it } from "@effect/vitest"
import { DateTime, Schema } from "effect"
import {
  AgentEvent,
  AppLink,
  describeLinkTile,
  isSingleEmoji,
  LinkIcon,
  linkHost,
  linkLabel,
  linkMenuHeader,
  linkPath,
  LinkTitle,
  LinkUrl,
  linkUrlProblem,
  renderAgentEvent
} from "../src/index.ts"
import * as Fixtures from "../src/fixtures.ts"

const roundTrip = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: S["Type"]) => {
  const codec = Schema.toCodecJson(schema)
  const wire = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(value)))
  return { wire, decoded: Schema.decodeUnknownSync(codec)(wire) }
}

const valid = <S extends Schema.Codec<unknown, unknown, never, never>>(schema: S, value: unknown) =>
  Schema.decodeUnknownExit(schema)(value)._tag === "Success"

describe("app links", () => {
  it("round-trips the sample links, leaving absent fields out", () => {
    for (const link of Fixtures.links) {
      const { wire, decoded } = roundTrip(AppLink, link)
      assert.deepStrictEqual(decoded, link)
      if (link.icon === undefined) assert.isFalse("icon" in wire)
    }
  })

  it("estimates what the label under the tile shows", () => {
    assert.deepStrictEqual(linkLabel("Lift Log"), { shown: "Lift Log", whole: true })
    assert.deepStrictEqual(linkLabel("Train times"), { shown: "Train times", whole: true })
    const long = linkLabel("Morning Brief")
    assert.isFalse(long.whole)
    assert.isTrue(long.shown.endsWith("…"))
    assert.isTrue(long.shown.startsWith("Morning"))
    assert.isFalse(linkLabel("Workout Planner Pro").whole)
  })

  it("takes one-line titles of up to 24 characters", () => {
    assert.isTrue(valid(LinkTitle, "Lift Log"))
    assert.isFalse(valid(LinkTitle, ""))
    assert.isFalse(valid(LinkTitle, " Lift Log"))
    assert.isFalse(valid(LinkTitle, "Lift\nLog"))
    assert.isFalse(valid(LinkTitle, "x".repeat(25)))
  })

  it("takes https URLs only", () => {
    assert.isUndefined(linkUrlProblem("https://cabin-7fq2.omer.build/admin?tab=2#top"))
    assert.isUndefined(linkUrlProblem("https://example.com"))
    assert.strictEqual(linkUrlProblem("http://example.com"), "must start with https://")
    assert.strictEqual(linkUrlProblem("https://localhost:3000"), "needs a public host name")
    assert.isDefined(linkUrlProblem("https://user:pw@example.com"))
    assert.isFalse(valid(LinkUrl, "https://exa mple.com"))
    assert.strictEqual(linkHost("https://Cabin-7fq2.omer.build/admin"), "cabin-7fq2.omer.build")
    assert.strictEqual(linkPath("https://cabin-7fq2.omer.build"), "/")
    assert.strictEqual(linkPath("https://cabin-7fq2.omer.build/admin?x=1"), "/admin?x=1")
  })

  it("takes a single emoji or an SF Symbol name as the glyph", () => {
    for (const emoji of ["🏋️", "🏠", "👍🏽", "👩‍🍳", "🇬🇧", "☀️"]) assert.isTrue(isSingleEmoji(emoji), emoji)
    for (const text of ["", "ab", "🏠🏠", "🏠 ", "L"]) assert.isFalse(isSingleEmoji(text), text)
    assert.isTrue(valid(LinkIcon, { _tag: "Symbol", name: "sun.horizon.fill" }))
    assert.isFalse(valid(LinkIcon, { _tag: "Symbol", name: "Sun Horizon" }))
  })

  it("says who made a link when it's held", () => {
    const [lift, , , train] = Fixtures.links
    assert.deepStrictEqual(linkMenuHeader(lift!, "Lift Log"), {
      title: "Made by Lift Log",
      host: "lift-log-k3x9q2.dream.example"
    })
    assert.deepStrictEqual(linkMenuHeader(train!, undefined), {
      title: "Added by you",
      host: "www.realtimetrains.co.uk"
    })
  })

  it("describes the tile in words", () => {
    const [lift, , , train] = Fixtures.links
    assert.strictEqual(describeLinkTile(lift!), "the SF Symbol dumbbell on a purple tile")
    assert.strictEqual(describeLinkTile(train!), "the letter T on an off-white tile")
    assert.strictEqual(
      describeLinkTile({ ...train!, icon: { _tag: "Emoji", emoji: "🚆" }, color: "orange" }),
      "🚆 on an orange tile"
    )
  })

  it("renders their changes for the agent", () => {
    const fields = {
      id: "evt_l" as AgentEvent["id"],
      at: DateTime.makeUnsafe("2026-11-06T15:00:00Z"),
      linkId: Fixtures.links[0]!.id,
      url: Fixtures.links[0]!.url
    }
    const renamed = renderAgentEvent(
      AgentEvent.cases.LinkEdited.make({ ...fields, title: "Lifts", change: "renamed", previousTitle: "Lift Log" })
    )
    assert.include(renamed, 'from "Lift Log" to "Lifts"')
    const removed = renderAgentEvent(
      AgentEvent.cases.LinkEdited.make({ ...fields, title: "Lift Log", change: "removed" })
    )
    assert.include(removed, "They removed your app link")
    const { decoded } = roundTrip(
      AgentEvent,
      AgentEvent.cases.LinkEdited.make({ ...fields, title: "Lift Log", change: "icon", tile: "🏋️ on a red tile" })
    )
    assert.strictEqual(decoded._tag, "LinkEdited")
  })
})
