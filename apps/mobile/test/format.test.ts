import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { DateTime } from "effect"
import { dayLabel, dayOfPhase, milestoneDate, shortDuration, timeLabel, usageLine } from "../src/data/format.ts"
import { parseBlocks, parseInline, plainText } from "../src/ui/markdownParse.ts"

const la = "America/Los_Angeles"
const at = (iso: string) => DateTime.makeUnsafe(iso)
// Wednesday, November 4, 2:12 PM in Los Angeles.
const now = at("2026-11-04T22:12:00Z")

describe("format", () => {
  it("labels Chat days like the mock", () => {
    assert.strictEqual(dayLabel(at("2026-11-04T16:00:00Z"), now, la), "Today")
    assert.strictEqual(dayLabel(at("2026-11-03T18:00:00Z"), now, la), "Yesterday")
    assert.strictEqual(dayLabel(at("2026-10-13T16:00:00Z"), now, la), "Tue, Oct 13")
  })

  it("formats times and milestone dates", () => {
    assert.strictEqual(timeLabel(at("2026-11-04T22:09:00Z"), la), "2:09 PM")
    assert.strictEqual(milestoneDate(at("2026-10-14T20:00:00Z"), now, la), "Oct 14")
    assert.strictEqual(milestoneDate(at("2026-11-04T21:40:00Z"), now, la), "Today")
    assert.strictEqual(milestoneDate(at("2026-11-05T15:00:00Z"), now, la), "Tomorrow, 7:00")
  })

  it("counts days in a phase from 1", () => {
    assert.strictEqual(dayOfPhase(at("2026-11-02T17:00:00Z"), now, la), "day 3")
    assert.strictEqual(dayOfPhase(now, now, la), "day 1")
  })

  it("describes usage the way Home shows it", () => {
    assert.strictEqual(usageLine(Fx.usage, la), "ChatGPT Pro · 62% of this week left")
    const limited = { ...Fx.usage, limitedUntil: { window: "fiveHour" as const, until: at("2026-11-04T23:40:00Z") } }
    assert.strictEqual(usageLine(limited, la), "ChatGPT Pro · paused until 3:40 PM")
  })

  it("shortens countdowns", () => {
    assert.strictEqual(shortDuration(now, at("2026-11-04T23:40:00Z")), "1h")
    assert.strictEqual(shortDuration(now, at("2026-11-04T22:37:00Z")), "25m")
  })
})

describe("markdown", () => {
  it("parses emphasis, code and links", () => {
    const nodes = parseInline("I’ll plot **estimated 1RM**, see `chart.ts` and [the app](https://cabin-x.omer.build).")
    assert.deepStrictEqual(
      nodes.map((n) => n.kind),
      ["text", "bold", "text", "code", "text", "link", "text"]
    )
  })

  it("links bare URLs without trailing punctuation", () => {
    const nodes = parseInline("Open https://cabin-k3x9q2.omer.build.")
    const link = nodes.find((n) => n.kind === "link")
    assert.strictEqual(link?.kind === "link" ? link.url : "", "https://cabin-k3x9q2.omer.build")
  })

  it("splits paragraphs and lists", () => {
    const blocks = parseBlocks("Done:\n\n- charts\n- timer\n\n1. one\n2. two")
    assert.deepStrictEqual(
      blocks.map((b) => b.kind),
      ["paragraph", "list", "list"]
    )
    assert.isTrue(blocks[2]?.kind === "list" && blocks[2].ordered)
  })
  it("reads agent-style messages: headings, labels over lists, rules and code", () => {
    const source = [
      "## ✅ **Done**",
      "**Core features:**",
      "- ✅ Magic links",
      "- ✅ Booking",
      "  with approval",
      "",
      "---",
      "1. First",
      "",
      "2. Second",
      "",
      "```sh",
      "npm start",
      "```",
      "Ship it."
    ].join("\n")
    const blocks = parseBlocks(source)
    assert.deepStrictEqual(
      blocks.map((b) => b.kind),
      ["heading", "paragraph", "list", "rule", "list", "code", "paragraph"]
    )
    assert.deepStrictEqual(blocks[2]?.kind === "list" ? blocks[2].items : [], [
      "✅ Magic links",
      "✅ Booking\nwith approval"
    ])
    const numbered = blocks[4]
    assert.isTrue(numbered?.kind === "list" && numbered.ordered && numbered.start === 1 && numbered.items.length === 2)
    assert.strictEqual(blocks[5]?.kind === "code" ? blocks[5].text : "", "npm start")
  })

  it("nests indented items under the item above", () => {
    const blocks = parseBlocks("1. **Set up**: run it\n   - It asks for the token\n2. **Start**")
    assert.strictEqual(blocks.length, 1)
    assert.deepStrictEqual(blocks[0]?.kind === "list" ? blocks[0].items : [], [
      "**Set up**: run it\n• It asks for the token",
      "**Start**"
    ])
  })

  it("flattens a message to plain lines for a preview", () => {
    assert.strictEqual(
      plainText("## **Live!** 🌱\n\nOpen [it](https://x.omer.build).\n\n```\nnpm start\n```\n- one\n- `two`"),
      "Live! 🌱\nOpen it.\none\ntwo"
    )
  })

  it("keeps a list's first number", () => {
    const blocks = parseBlocks("3. three\n4. four")
    assert.isTrue(blocks[0]?.kind === "list" && blocks[0].start === 3)
  })
})
