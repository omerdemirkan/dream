import { assert, describe, it } from "@effect/vitest"
import type { AgentEvent, EventId, MessageId, WakeId } from "@dream/domain"
import * as Fixtures from "@dream/domain/fixtures"
import { DateTime } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildPrompts, descriptionOf, withMap } from "../src/extract.ts"
import {
  type LastTurn,
  renderLastTurn,
  renderSteerPrompt,
  renderTaskPrompt,
  renderTurnPrompt,
  skills,
  systemPrompt,
  taskPrompt
} from "../src/index.ts"
import { prompts, skillLayout, skillNames } from "../src/sections.ts"

const docs = (path: string) => fileURLToPath(new URL(`../../../docs/prompts/${path}`, import.meta.url))
const built = buildPrompts((path) => readFileSync(docs(path), "utf8"))
const builtSkills = built.filter((prompt) => prompt.frontmatter !== undefined)

describe("prompts", () => {
  it("match the sections in docs/prompts (run `bun run sync-prompts` if this fails)", () => {
    const text = (name: string) => built.find((prompt) => prompt.name === name)?.text ?? ""
    assert.strictEqual(systemPrompt, text("systemPrompt"))
    assert.strictEqual(taskPrompt, text("taskPrompt"))
    assert.deepStrictEqual(
      skills,
      skillNames.map((name) => text(name))
    )
  })

  it("have a current map in docs/prompts/README.md (run `bun run sync-prompts` if this fails)", () => {
    const readme = readFileSync(docs("README.md"), "utf8")
    assert.strictEqual(readme, withMap(readme, built))
  })

  it("use every section file, each once, and every skill directory", () => {
    for (const prompt of [...Object.values(prompts), ...skillNames.map(skillLayout)]) {
      const files = readdirSync(docs(prompt.dir)).filter((file) => file.endsWith(".md"))
      const listed = prompt.sections.map((section) => `${section}.md`)
      assert.deepStrictEqual([...files].sort(), [...listed].sort(), `docs/prompts/${prompt.dir} and src/sections.ts`)
    }
    assert.deepStrictEqual(readdirSync(docs("skills")).sort(), [...skillNames].sort())
  })

  it("give every section but a system prompt's opening one a heading", () => {
    for (const prompt of built) {
      prompt.sections.forEach((section, i) => {
        if (i > 0 || prompt.frontmatter !== undefined) {
          assert.notStrictEqual(section.heading, "(opening)", section.file)
        }
      })
    }
  })

  it("open each skill with its name and a description a harness can list, then a title", () => {
    for (const skill of builtSkills) {
      // Both harnesses write `description:` unquoted, so it has to stay a plain YAML scalar on one line.
      const description = descriptionOf(skill.frontmatter ?? "") ?? ""
      assert.isTrue(skill.text.startsWith(`---\nname: ${skill.name}\ndescription: `), skill.name)
      assert.isAtMost(description.length, 1024, skill.name)
      assert.notMatch(description, /: | #|^[`'"@|>%&*!?{[-]/, skill.name)
      assert.include(skill.text, "\n---\n\n# ", skill.name)
      // Anthropic's guidance for a SKILL.md body: under 500 lines, with more detail in files of its own.
      assert.isBelow(skill.text.split("\n").length, 500, skill.name)
    }
  })

  it("keep the system prompt body only", () => {
    assert.isTrue(systemPrompt.startsWith("You're the agent behind one project in Dream."))
    assert.isFalse(systemPrompt.includes("covers:"))
  })
})

describe("renderTurnPrompt", () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso)

  it("shows the time where they are, then events oldest first", () => {
    const [message, answer] = Fixtures.events
    const prompt = renderTurnPrompt({
      events: [answer!, message!],
      now: at("2026-11-04T22:12:00Z"),
      timeZone: "America/Los_Angeles"
    })
    assert.strictEqual(
      prompt,
      `It's Wednesday, November 4, 2026 at 2:12 PM where they are (America/Los_Angeles).

What woke you:

[Wed, Nov 4, 2:02 PM] They wrote (msg_1rm):
> Can the charts show estimated 1RM, not just the weight?

[Wed, Nov 4, 2:05 PM] They answered your question msg_cabinrule, "When two relatives want the same weekend, who gets it?", "First to ask"
`
    )
  })

  it("renders every event kind", () => {
    const base = { at: at("2026-11-04T14:00:00Z") }
    const events: Array<AgentEvent> = [
      {
        ...base,
        _tag: "AccessConnected",
        id: "evt_a" as EventId,
        messageId: "msg_gmail" as MessageId,
        label: Fixtures.google.label,
        access: Fixtures.google.access
      },
      { ...base, _tag: "AccessDeclined", id: "evt_b" as EventId, messageId: "msg_stripe" as MessageId },
      {
        ...base,
        _tag: "WakeDue",
        id: "evt_c" as EventId,
        wakeId: "wak_digest" as WakeId,
        why: "Send the 7:00 digest",
        run: { command: "node send-digest.js", result: { exitCode: 1, outputTail: "Error: parser failed" } }
      },
      { ...base, _tag: "Alert", id: "evt_d" as EventId, reason: "Substack parser threw on 3 issues" },
      { ...base, _tag: "UsageReset", id: "evt_e" as EventId, window: "fiveHour" },
      {
        ...base,
        _tag: "PublishedUrlBroken",
        id: "evt_f" as EventId,
        url: "https://lift-log-x7k2.omer.build",
        port: 5173,
        facts: 'Loaded it from this sandbox in Chromium: 403 text/plain, "Blocked request."'
      }
    ]
    const prompt = renderTurnPrompt({ events, now: base.at })
    assert.include(prompt, "They connected Gmail (gmail.readonly). HTTPS requests to gmail.googleapis.com")
    assert.include(prompt, `use the placeholder "dream-placeholder-google"`)
    assert.include(prompt, "They declined your access request msg_stripe.")
    assert.include(prompt, "It ran `node send-digest.js`, which exited with code 1.")
    assert.include(prompt, "Something in the sandbox called `dream wake`:\n> Substack parser threw on 3 issues")
    assert.include(prompt, "Their five-hour usage window has reset.")
    assert.include(
      prompt,
      'When your last turn ended, Dream loaded your published URL https://lift-log-x7k2.omer.build (port 5173):\n> Loaded it from this sandbox in Chromium: 403 text/plain, "Blocked request."'
    )
    assert.include(prompt, "where they are (UTC)")
  })
})

describe("renderSteerPrompt", () => {
  it("frames events that arrive during a turn", () => {
    const [message] = Fixtures.events
    const prompt = renderSteerPrompt({
      events: [message!],
      now: DateTime.makeUnsafe("2026-11-04T22:03:00Z"),
      timeZone: "America/Los_Angeles"
    })
    assert.strictEqual(
      prompt,
      `It's Wednesday, November 4, 2026 at 2:03 PM where they are (America/Los_Angeles).

This arrived while you were working:

[Wed, Nov 4, 2:02 PM] They wrote (msg_1rm):
> Can the charts show estimated 1RM, not just the weight?
`
    )
  })
})

describe("renderLastTurn", () => {
  const session = (cost: number, more: Partial<LastTurn["sessions"][number]> = {}) => ({
    own: false,
    steps: 20,
    peakContext: 60_000,
    cost,
    recached: 0,
    ...more
  })
  const turn = (sessions: LastTurn["sessions"], more: Partial<LastTurn> = {}): LastTurn => ({
    startedAt: DateTime.makeUnsafe("2026-11-07T20:54:00Z"),
    endedAt: DateTime.makeUnsafe("2026-11-08T00:01:00Z"),
    priced: true,
    sessions,
    ...more
  })

  it("says what each session cost, the largest subagents by name, and the rest together", () => {
    const note = renderLastTurn(
      turn(
        [
          session(2, { own: true, steps: 43, peakContext: 114_547 }),
          session(11, {
            description: "Three design directions",
            model: "opus",
            effort: "high",
            steps: 151,
            peakContext: 257_490,
            recached: 1.5
          }),
          session(7, {
            description: "Build the engine",
            model: "sonnet",
            effort: "high",
            steps: 119,
            peakContext: 234_695,
            recached: 2.5
          }),
          session(0.2, { description: "Research", model: "sonnet", steps: 5 }),
          session(0.3, { model: "sonnet" }),
          session(0.1)
        ],
        { weekly: { before: 49, after: 52 } }
      )
    )
    assert.strictEqual(
      note,
      'Your last turn ran 3 h 7 min and came to about $21 at API prices. Their weekly window went from 49% to 52% while it ran, which counts anything else on their plan meanwhile. Your own session was 10% of it: 43 steps, up to 115k tokens of context. Subagents: "Three design directions" (opus, high) 53%, 151 steps, up to 257k; "Build the engine" (sonnet, high) 34%, 119 steps, up to 235k; a subagent (sonnet) 1%, 20 steps, up to 60k; 2 more, 1% together. About 19% of it went to sending sessions afresh after a pause had let their cache lapse.'
    )
  })

  it("keeps a small turn to a sentence, and leaves out dollars it doesn't know", () => {
    assert.strictEqual(
      renderLastTurn(
        turn([session(0.24, { own: true, steps: 6, peakContext: 160_000 })], {
          endedAt: DateTime.makeUnsafe("2026-11-07T20:55:10Z"),
          weekly: { before: 55, after: 55 }
        })
      ),
      "Your last turn ran 1 min and came to about $0.24 at API prices. It was all your own session: 6 steps, up to 160k tokens of context."
    )
    assert.strictEqual(
      renderLastTurn(turn([session(40, { own: true }), session(10, { steps: 1 })], { priced: false })),
      "Your last turn ran 3 h 7 min. Your own session was 80% of it: 20 steps, up to 60k tokens of context. Subagents: a subagent 20%, 1 step, up to 60k."
    )
    assert.strictEqual(renderLastTurn(turn([])), "")
  })

  it("comes after the time in the turn prompt, and not in input given mid-turn", () => {
    const [message] = Fixtures.events
    const input = {
      events: [message!],
      now: DateTime.makeUnsafe("2026-11-04T22:03:00Z"),
      timeZone: "America/Los_Angeles",
      lastTurn: turn([session(0.5, { own: true })])
    }
    assert.include(
      renderTurnPrompt(input),
      "(America/Los_Angeles).\n\nYour last turn ran 3 h 7 min and came to about $0.50 at API prices. It was all your own session: 20 steps, up to 60k tokens of context.\n\nWhat woke you:"
    )
    assert.notInclude(renderSteerPrompt(input), "Your last turn")
  })
})

describe("renderTaskPrompt", () => {
  it("gives the time where they are, then the agent's brief", () => {
    const prompt = renderTaskPrompt({
      why: "Monday episode",
      brief: "Write and publish this week's episode.\n",
      now: DateTime.makeUnsafe("2026-11-09T13:15:00Z"),
      timeZone: "America/Los_Angeles"
    })
    assert.strictEqual(
      prompt,
      `It's Monday, November 9, 2026 at 5:15 AM where they are (America/Los_Angeles).

The agent scheduled this job ("Monday episode"). Its brief:

Write and publish this week's episode.
`
    )
    assert.isTrue(taskPrompt.startsWith("You're running one job for a project in Dream"))
  })
})
