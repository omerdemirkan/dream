import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { caretAt, insertAt } from "../src/data/draft.ts"
import { draftRuns, ideas, nearProject, parseDraft, shiftGuesses, startersFor } from "../src/data/ideas.ts"

const idea = (id: string) => {
  const found = ideas.find((i) => i.id === id)
  if (!found) throw new Error(`no idea ${id}`)
  return found
}
const guessTexts = (text: string, guesses: ReadonlyArray<{ start: number; end: number }>) =>
  guesses.map((g) => text.slice(g.start, g.end))
const sampleTitles = [Fx.liftLog, Fx.morningBrief, Fx.cabin, Fx.recipeScaler].map((p) => p.title)

describe("ideas", () => {
  it("are the founder's five, in their order, each a short starter and a draft with guesses", () => {
    assert.deepStrictEqual(
      ideas.map((i) => i.id),
      ["my-podcast", "memory-tutor", "points-trips", "run-club-bot", "dinner-plan"]
    )
    for (const i of ideas) {
      assert.isAtMost(i.line.length, 110, i.id)
      const draft = parseDraft(i.draft)
      assert.isAtLeast(draft.guesses.length, 2, i.id)
      assert.notInclude(draft.text, "⟦", i.id)
      assert.notInclude(draft.text, "⟧", i.id)
      // Dollars or no currency.
      assert.notMatch(i.line + i.draft, /[£€]/, i.id)
    }
  })

  it("marks the guesses in a draft", () => {
    const draft = parseDraft(idea("run-club-bot").draft)
    assert.deepStrictEqual(guessTexts(draft.text, draft.guesses), [
      "Wednesday",
      "three",
      "our usual meeting spot",
      "Saturday",
      "WhatsApp"
    ])
    assert.isTrue(draft.text.startsWith("A bot for our running club’s group chat. Every Wednesday"))
    assert.deepStrictEqual(parseDraft("no guesses"), { text: "no guesses", guesses: [] })
    // An unclosed bracket is left as written rather than eating the rest.
    assert.deepStrictEqual(parseDraft("a ⟦b"), { text: "a ⟦b", guesses: [] })
  })

  it("cuts a draft into plain runs and guesses for drawing", () => {
    const draft = parseDraft("Fly to ⟦Denver⟧ under ⟦$120⟧.")
    assert.deepStrictEqual(draftRuns(draft.text, draft.guesses), [
      { text: "Fly to ", guess: false },
      { text: "Denver", guess: true },
      { text: " under ", guess: false },
      { text: "$120", guess: true },
      { text: ".", guess: false }
    ])
  })
})

describe("guesses through edits", () => {
  const draft = parseDraft("Fly to ⟦Denver⟧ under ⟦$120⟧.")
  const lisbon = draft.guesses[0]!

  it("stop being guesses once typed over, and the rest move with the text", () => {
    // Denver is selected; the first keystroke replaces it.
    const typed = `${draft.text.slice(0, lisbon.start)}P${draft.text.slice(lisbon.end)}`
    const after = shiftGuesses(draft.guesses, draft.text, typed)
    assert.deepStrictEqual(guessTexts(typed, after), ["$120"])
    // A replacement that starts with the guess's own first letter is still an edit of it.
    const same = `${draft.text.slice(0, lisbon.start)}L${draft.text.slice(lisbon.end)}`
    assert.deepStrictEqual(guessTexts(same, shiftGuesses(draft.guesses, draft.text, same)), ["$120"])
  })

  it("stop being guesses when typed into", () => {
    const typed = `${draft.text.slice(0, lisbon.start + 3)}x${draft.text.slice(lisbon.start + 3)}`
    assert.deepStrictEqual(guessTexts(typed, shiftGuesses(draft.guesses, draft.text, typed)), ["$120"])
  })

  it("stay when the edit is elsewhere", () => {
    const front = `Please f${draft.text.slice(1)}`
    assert.deepStrictEqual(guessTexts(front, shiftGuesses(draft.guesses, draft.text, front)), ["Denver", "$120"])
    const end = `${draft.text} Soon.`
    assert.deepStrictEqual(guessTexts(end, shiftGuesses(draft.guesses, draft.text, end)), ["Denver", "$120"])
    // Typing right before or right after a guess leaves it a guess.
    const touching = `${draft.text.slice(0, lisbon.end)},${draft.text.slice(lisbon.end)}`
    assert.deepStrictEqual(guessTexts(touching, shiftGuesses(draft.guesses, draft.text, touching)), ["Denver", "$120"])
  })

  it("follow a dictation take placed over the selected guess", () => {
    const placed = insertAt(draft.text, lisbon, "Porto")
    assert.strictEqual(placed.text, "Fly to Porto under $120.")
    assert.deepStrictEqual(guessTexts(placed.text, shiftGuesses(draft.guesses, draft.text, placed.text)), ["$120"])
    const atEnd = insertAt(draft.text, caretAt(draft.text.length), "In May.")
    assert.deepStrictEqual(guessTexts(atEnd.text, shiftGuesses(draft.guesses, draft.text, atEnd.text)), [
      "Denver",
      "$120"
    ])
  })

  it("all go when the page is cleared", () => {
    assert.deepStrictEqual(shiftGuesses(draft.guesses, draft.text, ""), [])
  })
})

describe("which starters", () => {
  it("drops ideas one of their projects already is, and keeps the order", () => {
    assert.isTrue(nearProject(idea("dinner-plan"), ["Meal planner"]))
    assert.isTrue(nearProject(idea("run-club-bot"), ["Running club"]))
    assert.isFalse(nearProject(idea("memory-tutor"), sampleTitles))
    assert.deepStrictEqual(startersFor(ideas, sampleTitles), ideas)
    assert.deepStrictEqual(
      startersFor(ideas, ["Meal planner"]).map((i) => i.id),
      ["my-podcast", "memory-tutor", "points-trips", "run-club-bot"]
    )
  })
})
