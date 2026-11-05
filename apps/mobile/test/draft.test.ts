import { assert, describe, it } from "@effect/vitest"
import { caretAt, ideaToSend, insertAt, placeTake, wordCountLabel } from "../src/data/draft.ts"
import { addResult, emptyTranscript, type Transcript } from "../src/data/transcript.ts"

const feed = (results: ReadonlyArray<readonly [string, boolean]>) =>
  results.reduce<Transcript>((t, [text, isFinal]) => addResult(t, { text, isFinal }), emptyTranscript)

describe("draft", () => {
  it("puts a take in at the cursor, not at the end, with the cursor after it", () => {
    const text = "An app for my club. It should send reminders."
    const placed = insertAt(text, caretAt(19), "It tracks who shows up.")
    assert.strictEqual(placed.text, "An app for my club. It tracks who shows up. It should send reminders.")
    assert.strictEqual(placed.text.slice(0, placed.caret), "An app for my club. It tracks who shows up.")
  })

  it("replaces a selection", () => {
    const text = "Remind people by email."
    const placed = insertAt(text, { start: 17, end: 22 }, "text message")
    assert.strictEqual(placed.text, "Remind people by text message.")
    assert.strictEqual(placed.caret, "Remind people by text message".length)
  })

  it("takes a selection made right to left", () => {
    assert.strictEqual(insertAt("one two three", { start: 7, end: 4 }, "2").text, "one 2 three")
  })

  it("adds a space only where the words would run together", () => {
    assert.strictEqual(insertAt("Hello", caretAt(5), "there").text, "Hello there")
    assert.strictEqual(insertAt("Hello ", caretAt(6), "there").text, "Hello there")
    assert.strictEqual(insertAt("first\n\n", caretAt(7), "Second.").text, "first\n\nSecond.")
    assert.strictEqual(insertAt("wordend", caretAt(4), "x").text, "word x end")
    assert.strictEqual(insertAt("Hi.", caretAt(2), "there").text, "Hi there.")
    assert.strictEqual(insertAt("", caretAt(0), "Hello.").text, "Hello.")
  })

  it("puts the take at the end of an empty page, and clamps a stale cursor", () => {
    assert.strictEqual(insertAt("short", caretAt(40), "and more").text, "short and more")
  })

  it("splits what's settled from what's still being recognized, in place", () => {
    const t = feed([
      ["It should track who shows up.", true],
      ["And send", false]
    ])
    const placed = placeTake("Club app. Done.", caretAt(9), t)
    assert.strictEqual(placed.before, "Club app. ")
    assert.strictEqual(placed.settled, "It should track who shows up.")
    assert.strictEqual(placed.interim, " And send")
    assert.strictEqual(placed.after, " Done.")
    assert.strictEqual(placed.text, "Club app. It should track who shows up. And send Done.")
  })

  it("keeps every sentence across iOS's segment restarts, at the cursor", () => {
    const t = feed([
      ["I want", false],
      ["I want an app.", true],
      ["It should", false],
      ["It should track runs.", true]
    ])
    assert.strictEqual(placeTake("Hi.\n\nBye.", caretAt(5), t).text, "Hi.\n\nI want an app. It should track runs. Bye.")
  })

  it("leaves the page as it was while nothing has been heard", () => {
    const placed = placeTake("Hello world", { start: 0, end: 5 }, emptyTranscript)
    assert.strictEqual(placed.text, "Hello world")
    assert.strictEqual(placed.caret, 0)
    assert.strictEqual(insertAt("Hello world", { start: 0, end: 5 }, "").text, "Hello world")
  })

  it("sends everything on the page, mid-dictation included, trimmed", () => {
    const t = feed([
      ["Track runs.", true],
      ["And streaks", false]
    ])
    assert.strictEqual(ideaToSend("  A club app.\n\n", caretAt(13), t), "A club app. Track runs. And streaks")
    assert.strictEqual(ideaToSend("  A club app.\n", caretAt(3), undefined), "A club app.")
    assert.strictEqual(ideaToSend("   ", caretAt(0), emptyTranscript), "")
  })

  it("counts words once it's long", () => {
    assert.strictEqual(wordCountLabel("a few words"), "")
    assert.strictEqual(wordCountLabel(Array.from({ length: 41 }, () => "w").join(" ")), "41 words")
  })
})
