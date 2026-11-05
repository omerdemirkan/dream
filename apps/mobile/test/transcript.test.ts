import { assert, describe, it } from "@effect/vitest"
import { addResult, emptyTranscript, type Transcript, transcriptText } from "../src/data/transcript.ts"

const feed = (results: ReadonlyArray<readonly [string, boolean]>) =>
  results.reduce<Transcript>((t, [text, isFinal]) => addResult(t, { text, isFinal }), emptyTranscript)

describe("transcript", () => {
  it("keeps every sentence when iOS starts each segment over after a pause", () => {
    const t = feed([
      ["I want", false],
      ["I want an app for my running club.", true],
      ["It should", false],
      ["It should track who shows up.", true],
      ["And send", false]
    ])
    assert.strictEqual(transcriptText(t), "I want an app for my running club. It should track who shows up. And send")
  })

  it("doesn't repeat what's kept when a recognizer reports the whole take each time", () => {
    const t = feed([
      ["Hello there.", true],
      ["Hello there. How are", false],
      ["Hello there. How are you?", true]
    ])
    assert.strictEqual(transcriptText(t), "Hello there. How are you?")
  })

  it("shows the segment being heard after the kept ones", () => {
    const t = feed([
      ["One.", true],
      ["Two", false]
    ])
    assert.strictEqual(t.kept, "One.")
    assert.strictEqual(t.current, "Two")
    assert.strictEqual(transcriptText(t), "One. Two")
  })
})
