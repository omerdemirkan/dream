import { assert, describe, it } from "@effect/vitest"
import { caretAt, ideaToSend, insertAt } from "../src/data/draft.ts"
import { draftOf, ideas } from "../src/data/ideas.ts"

describe("starters", () => {
  it("are the founder's five, in their order", () => {
    assert.deepStrictEqual(
      ideas.map((i) => i.id),
      ["my-podcast", "memory-tutor", "points-trips", "run-club-bot", "dinner-plan"]
    )
  })

  it("are short enough for a card, and draft something sendable as it is", () => {
    for (const i of ideas) {
      // At most three lines on a card (see ideas.ts); the Simulator is the real check.
      assert.isAtMost(i.line.length, 40, i.id)
      assert.notInclude(i.line, "\n", i.id)
      // No placeholders to fill in, and no currency or place they didn't choose.
      assert.notMatch(i.draft, /[⟦⟧[\]{}<>_]|\.\.\.|…|[£€$]/, i.id)
      assert.isTrue(i.draft.endsWith("."), i.id)
    }
  })
})

describe("a starter's draft on the page", () => {
  const draft = draftOf(ideas[0]!)
  const end = caretAt(draft.length)

  it("ends in a space, so typing at the cursor after it carries straight on", () => {
    assert.isTrue(draft.endsWith(". "))
    assert.isTrue(`${draft}Mostly about cycling.`.endsWith("notes. Mostly about cycling."))
  })

  it("takes dictation at the cursor after it, with one space between", () => {
    const placed = insertAt(draft, end, "Mostly about cycling.")
    assert.strictEqual(placed.text, `${ideas[0]!.draft} Mostly about cycling.`)
    assert.strictEqual(placed.caret, placed.text.length)
  })

  it("sends without the trailing space", () => {
    assert.strictEqual(ideaToSend(draft, end, undefined), ideas[0]!.draft)
  })
})
