import * as Fx from "@dream/domain/fixtures"
import { assert, describe, it } from "@effect/vitest"
import { caretAt, insertAt } from "../src/data/draft.ts"
import {
  connectedNeeds,
  draftRuns,
  ideaGroups,
  ideas,
  nearProject,
  parseDraft,
  pickStarters,
  rankIdeas,
  shiftGuesses
} from "../src/data/ideas.ts"

const idea = (id: string) => {
  const found = ideas.find((i) => i.id === id)
  if (!found) throw new Error(`no idea ${id}`)
  return found
}
const guessTexts = (text: string, guesses: ReadonlyArray<{ start: number; end: number }>) =>
  guesses.map((g) => text.slice(g.start, g.end))
const sampleTitles = [Fx.liftLog, Fx.morningBrief, Fx.cabin, Fx.recipeScaler].map((p) => p.title)

describe("ideas", () => {
  it("are about twenty, each with a short starter and a draft with guesses", () => {
    assert.isAtLeast(ideas.length, 18)
    assert.strictEqual(new Set(ideas.map((i) => i.id)).size, ideas.length)
    for (const i of ideas) {
      assert.isAtMost(i.line.length, 100, i.id)
      assert.isTrue(
        ideaGroups.some((g) => g.id === i.group),
        i.id
      )
      const draft = parseDraft(i.draft)
      assert.isAtLeast(draft.guesses.length, 1, i.id)
      assert.notInclude(draft.text, "⟦", i.id)
      assert.notInclude(draft.text, "⟧", i.id)
    }
  })

  it("marks the guesses in a draft", () => {
    const draft = parseDraft(idea("fare-watch").draft)
    assert.deepStrictEqual(guessTexts(draft.text, draft.guesses), ["London", "Lisbon", "May", "£120"])
    assert.isTrue(draft.text.startsWith("Check return flights from London to Lisbon"))
    assert.deepStrictEqual(parseDraft("no guesses"), { text: "no guesses", guesses: [] })
    // An unclosed bracket is left as written rather than eating the rest.
    assert.deepStrictEqual(parseDraft("a ⟦b"), { text: "a ⟦b", guesses: [] })
  })

  it("cuts a draft into plain runs and guesses for drawing", () => {
    const draft = parseDraft("Fly to ⟦Lisbon⟧ under ⟦£120⟧.")
    assert.deepStrictEqual(draftRuns(draft.text, draft.guesses), [
      { text: "Fly to ", guess: false },
      { text: "Lisbon", guess: true },
      { text: " under ", guess: false },
      { text: "£120", guess: true },
      { text: ".", guess: false }
    ])
  })
})

describe("guesses through edits", () => {
  const draft = parseDraft("Fly to ⟦Lisbon⟧ under ⟦£120⟧.")
  const lisbon = draft.guesses[0]!

  it("stop being guesses once typed over, and the rest move with the text", () => {
    // Lisbon is selected; the first keystroke replaces it.
    const typed = `${draft.text.slice(0, lisbon.start)}P${draft.text.slice(lisbon.end)}`
    const after = shiftGuesses(draft.guesses, draft.text, typed)
    assert.deepStrictEqual(guessTexts(typed, after), ["£120"])
    // A replacement that starts with the guess's own first letter is still an edit of it.
    const same = `${draft.text.slice(0, lisbon.start)}L${draft.text.slice(lisbon.end)}`
    assert.deepStrictEqual(guessTexts(same, shiftGuesses(draft.guesses, draft.text, same)), ["£120"])
  })

  it("stop being guesses when typed into", () => {
    const typed = `${draft.text.slice(0, lisbon.start + 3)}x${draft.text.slice(lisbon.start + 3)}`
    assert.deepStrictEqual(guessTexts(typed, shiftGuesses(draft.guesses, draft.text, typed)), ["£120"])
  })

  it("stay when the edit is elsewhere", () => {
    const front = `Please f${draft.text.slice(1)}`
    assert.deepStrictEqual(guessTexts(front, shiftGuesses(draft.guesses, draft.text, front)), ["Lisbon", "£120"])
    const end = `${draft.text} Soon.`
    assert.deepStrictEqual(guessTexts(end, shiftGuesses(draft.guesses, draft.text, end)), ["Lisbon", "£120"])
    // Typing right before or right after a guess leaves it a guess.
    const touching = `${draft.text.slice(0, lisbon.end)},${draft.text.slice(lisbon.end)}`
    assert.deepStrictEqual(guessTexts(touching, shiftGuesses(draft.guesses, draft.text, touching)), ["Lisbon", "£120"])
  })

  it("follow a dictation take placed over the selected guess", () => {
    const placed = insertAt(draft.text, lisbon, "Porto")
    assert.strictEqual(placed.text, "Fly to Porto under £120.")
    assert.deepStrictEqual(guessTexts(placed.text, shiftGuesses(draft.guesses, draft.text, placed.text)), ["£120"])
    const atEnd = insertAt(draft.text, caretAt(draft.text.length), "In May.")
    assert.deepStrictEqual(guessTexts(atEnd.text, shiftGuesses(draft.guesses, draft.text, atEnd.text)), [
      "Lisbon",
      "£120"
    ])
  })

  it("all go when the page is cleared", () => {
    assert.deepStrictEqual(shiftGuesses(draft.guesses, draft.text, ""), [])
  })
})

describe("which starters", () => {
  it("knows what Gmail, Calendar and OAuth connections make available", () => {
    assert.deepStrictEqual([...connectedNeeds([Fx.google])], ["gmail"])
    const calendar = {
      ...Fx.google,
      access: { ...Fx.google.access, scopes: ["gmail.readonly", "calendar.readonly"] }
    } as typeof Fx.google
    assert.deepStrictEqual([...connectedNeeds([calendar])].sort(), ["calendar", "gmail"])
    assert.deepStrictEqual([...connectedNeeds([{ ...Fx.google, status: "revoked" }])], [])
  })

  it("drops ideas their projects already are", () => {
    assert.isTrue(nearProject(idea("newsletter-digest"), ["Morning Brief"]))
    assert.isTrue(nearProject(idea("lift-log"), ["Lift Log"]))
    assert.isTrue(nearProject(idea("receipts"), ["Receipts"]))
    assert.isFalse(nearProject(idea("fare-watch"), sampleTitles))
    const ranked = rankIdeas(ideas, { connected: new Set(), projectTitles: sampleTitles })
    assert.notInclude(
      ranked.map((i) => i.id),
      "newsletter-digest"
    )
    assert.notInclude(
      ranked.map((i) => i.id),
      "lift-log"
    )
  })

  it("puts ideas using what's connected first: all of it, then some, then the rest in curated order", () => {
    const ranked = rankIdeas(ideas, { connected: new Set(["gmail"]), projectTitles: [] })
    const ids = ranked.map((i) => i.id)
    assert.deepStrictEqual(ids.slice(0, 3), ["evening-inbox", "newsletter-digest", "parcels"])
    assert.deepStrictEqual(ids.slice(3, 5), ["before-meetings", "receipts"])
    assert.strictEqual(ids[5], "anki-walk")
    assert.strictEqual(ranked.length, ideas.length)
  })

  it("picks four: up to two using what's connected, then a mix from other groups, the same for the same seed", () => {
    const connected = new Set(["gmail"] as const)
    const ranked = rankIdeas(ideas, { connected, projectTitles: sampleTitles })
    const four = pickStarters(ranked, connected, 0.42)
    assert.strictEqual(four.length, 4)
    assert.strictEqual(new Set(four).size, 4)
    assert.isTrue(four.slice(0, 2).every((i) => i.needs.includes("gmail")))
    assert.isAtLeast(new Set(four.map((i) => i.group)).size, 3)
    assert.deepStrictEqual(pickStarters(ranked, connected, 0.42), four)
    const seen = new Set(
      [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].flatMap((s) => pickStarters(ranked, connected, s).map((i) => i.id))
    )
    assert.isAtLeast(seen.size, 8)
  })

  it("picks from the rest when nothing is connected", () => {
    const four = pickStarters(ideas, new Set(), 0.7)
    assert.strictEqual(four.length, 4)
    assert.strictEqual(new Set(four.map((i) => i.group)).size, 4)
  })
})
