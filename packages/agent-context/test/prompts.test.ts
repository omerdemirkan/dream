import { assert, describe, it } from "@effect/vitest"
import type { AgentEvent, EventId, MessageId, WakeId } from "@dream/domain"
import * as Fixtures from "@dream/domain/fixtures"
import { DateTime } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildPrompts, withMap } from "../src/extract.ts"
import {
  dreamSkill,
  renderSteerPrompt,
  renderTaskPrompt,
  renderTurnPrompt,
  systemPrompt,
  taskPrompt
} from "../src/index.ts"
import { layout } from "../src/sections.ts"

const docs = (path: string) => fileURLToPath(new URL(`../../../docs/prompts/${path}`, import.meta.url))
const built = buildPrompts((path) => readFileSync(docs(path), "utf8"))

describe("prompts", () => {
  it("match the sections in docs/prompts (run `bun run sync-prompts` if this fails)", () => {
    const text = Object.fromEntries(built.map((prompt) => [prompt.name, prompt.text]))
    assert.strictEqual(systemPrompt, text.systemPrompt)
    assert.strictEqual(dreamSkill, text.dreamSkill)
    assert.strictEqual(taskPrompt, text.taskPrompt)
  })

  it("have a current map in docs/prompts/README.md (run `bun run sync-prompts` if this fails)", () => {
    const readme = readFileSync(docs("README.md"), "utf8")
    assert.strictEqual(readme, withMap(readme, built))
  })

  it("use every section file, each once", () => {
    for (const prompt of Object.values(layout)) {
      const files = readdirSync(docs(prompt.dir)).filter((file) => file.endsWith(".md"))
      const listed = prompt.sections.map((section) => `${section}.md`)
      assert.deepStrictEqual([...files].sort(), [...listed].sort(), `docs/prompts/${prompt.dir} and src/sections.ts`)
    }
  })

  it("give every section but an opening one a heading", () => {
    for (const prompt of built) {
      prompt.sections.forEach((section, i) => {
        if (i > 0 || prompt.name === "dreamSkill") assert.notStrictEqual(section.heading, "(opening)", section.file)
      })
    }
  })

  it("keep the system prompt body only, and the skill's frontmatter", () => {
    assert.isTrue(systemPrompt.startsWith("You're the agent behind one project in Dream."))
    assert.isFalse(systemPrompt.includes("covers:"))
    assert.isTrue(dreamSkill.startsWith("---\nname: dream\ndescription: "))
    assert.isTrue(dreamSkill.includes("\n---\n\n# `dream`\n"))
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
