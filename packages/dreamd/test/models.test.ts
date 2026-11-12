/**
 * The models each pinned CLI knows, read from the CLI itself (`harness/Models.ts`), and what a project's family runs
 * as. The fixtures are the real output of Claude Code 2.1.322 and Codex 0.167.2; with `DREAM_HARNESS_BINS` set to a
 * directory laid out as `dreamd bootstrap` leaves it (the update script sets it to the CLIs it just pinned), the
 * last test reads the installed CLIs themselves.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { AgentModels, type Harness, ReasoningEfforts } from "@dream/domain"
import { Effect, Option } from "effect"
import {
  catalogCommand,
  catalogProblems,
  claudeName,
  newestOf,
  parseClaudeModels,
  parseCodexCatalog,
  resolveIn
} from "../src/harness/Models.ts"
import * as Session from "../src/harness/Session.ts"
import { claudeCatalog, codexCatalog } from "./models.ts"

const resolved = (harness: Harness, catalog: Option.Option<typeof codexCatalog>, model: string) =>
  resolveIn(harness, catalog, model).pipe(
    Effect.map(({ model, concrete }) => ({ model, concrete: Option.getOrUndefined(concrete)?.id }))
  )

describe("Codex's catalog", () => {
  it("runs each family on its newest listed slug with the multi-agent tools", () => {
    const newest = (family: string) => Option.getOrUndefined(newestOf("codex", codexCatalog, family))?.id
    assert.strictEqual(newest("astra"), "gpt-6-astra")
    assert.strictEqual(newest("sol"), "gpt-6.1-sol")
    assert.strictEqual(newest("terra"), "gpt-6.1-terra")
    // gpt-5.6-luna is older, and has only multi-agent v1.
    assert.strictEqual(newest("luna"), "gpt-6-luna")
  })

  it("passes over hidden models, and models without the multi-agent tools", () => {
    const sol = codexCatalog.find((model) => model.id === "gpt-6.1-sol")
    assert.isTrue(sol?.listed && sol.orchestrates)
    assert.isFalse(codexCatalog.find((model) => model.id === "gpt-5.5")?.orchestrates)
    assert.isFalse(codexCatalog.find((model) => model.id === "gpt-daybreak-blue-latest")?.listed)
    const newer = [{ ...sol!, id: "gpt-6.2-sol", orchestrates: false }, ...codexCatalog]
    assert.strictEqual(Option.getOrUndefined(newestOf("codex", newer, "sol"))?.id, "gpt-6.1-sol")
    const listed = [
      { ...sol!, id: "gpt-6.10-sol" },
      { ...sol!, id: "gpt-6.9-sol" }
    ]
    assert.strictEqual(Option.getOrUndefined(newestOf("codex", listed, "sol"))?.id, "gpt-6.10-sol")
  })

  it("isn't read from output that isn't a catalog", () => {
    assert.isTrue(Option.isNone(parseCodexCatalog("WARNING: something\n")))
    assert.isTrue(Option.isNone(parseCodexCatalog('{"models": 3}')))
  })
})

describe("Claude Code's model list", () => {
  it("maps each alias to the model it stands for, without the account's default", () => {
    const alias = (name: string) => claudeCatalog.find((model) => model.alias === name)?.id
    assert.strictEqual(alias("fable"), "claude-fable-5-2")
    assert.strictEqual(alias("opus"), "claude-opus-5-5")
    assert.strictEqual(alias("sonnet"), "claude-sonnet-5-5")
    assert.strictEqual(alias("haiku"), "claude-haiku-5-5")
    assert.isUndefined(alias("default"))
    assert.strictEqual(claudeCatalog.find((model) => model.alias === "fable")?.name, "Fable 5.2")
  })

  it("names models the way people do", () => {
    assert.strictEqual(claudeName("claude-fable-5-2"), "Fable 5.2")
    assert.strictEqual(claudeName("claude-haiku-4-5-20251001"), "Haiku 4.5.20251001")
    assert.strictEqual(claudeName("something-else"), "something-else")
  })

  it("is found among other output lines", () => {
    assert.isTrue(Option.isNone(parseClaudeModels('{"type":"system","subtype":"init"}\n')))
  })
})

describe("every family Dream offers", () => {
  it("has a model that orchestrates and takes every effort, in both pinned CLIs", () => {
    assert.deepStrictEqual(catalogProblems("claude-code", claudeCatalog, ReasoningEfforts), [])
    assert.deepStrictEqual(catalogProblems("codex", codexCatalog, ReasoningEfforts), [])
  })

  it("is reported when a CLI drops one, or one stops taking an effort", () => {
    const withoutTerra = codexCatalog.filter((model) => !model.id.endsWith("-terra"))
    assert.deepStrictEqual(catalogProblems("codex", withoutTerra, ReasoningEfforts), [
      "codex has no model of the terra family that orchestrates"
    ])
    const lowOnly = claudeCatalog.map((model) => (model.alias === "haiku" ? { ...model, efforts: ["low"] } : model))
    assert.deepStrictEqual(catalogProblems("claude-code", lowOnly, ReasoningEfforts), [
      "claude-haiku-5-5 (haiku) doesn't take effort medium, high, xhigh, max"
    ])
  })
})

describe("a model choice", () => {
  it.effect("on Claude Code goes as the family's alias, which the CLI resolves", () =>
    Effect.gen(function* () {
      const some = Option.some(claudeCatalog)
      assert.deepStrictEqual(yield* resolved("claude-code", some, "fable"), {
        model: "fable",
        concrete: "claude-fable-5-2"
      })
      // A project on Fable 5.1 had saved `fable`, so it runs on 5.2; an id pins its model.
      assert.deepStrictEqual(yield* resolved("claude-code", some, "claude-fable-5-1"), {
        model: "claude-fable-5-1",
        concrete: undefined
      })
      // Without the list the turn still runs; only the concrete model is unknown.
      assert.deepStrictEqual(yield* resolved("claude-code", Option.none(), "opus"), {
        model: "opus",
        concrete: undefined
      })
      // An operator's QA override that isn't a family goes as it is.
      assert.deepStrictEqual(yield* resolved("claude-code", some, "claude-haiku-4-5-20251001"), {
        model: "claude-haiku-4-5-20251001",
        concrete: undefined
      })
    })
  )

  it.effect("on Codex runs as the family's newest slug, also when it was saved as an older one", () =>
    Effect.gen(function* () {
      const some = Option.some(codexCatalog)
      for (const [model, slug] of [
        ["sol", "gpt-6.1-sol"],
        ["gpt-6-sol", "gpt-6.1-sol"],
        ["gpt-6-luna", "gpt-6-luna"],
        ["gpt-5.6-terra", "gpt-6.1-terra"],
        ["astra", "gpt-6-astra"]
      ] as const) {
        assert.deepStrictEqual(yield* resolved("codex", some, model), { model: slug, concrete: slug })
      }
      assert.deepStrictEqual(yield* resolved("codex", some, "gpt-5.5"), { model: "gpt-5.5", concrete: "gpt-5.5" })
      const unread = yield* Effect.flip(resolveIn("codex", Option.none(), "sol"))
      assert.include(unread.message, "catalog couldn't be read")
      const missing = yield* Effect.flip(resolveIn("codex", Option.some([]), "terra"))
      assert.include(missing.message, "no model of the terra family")
    })
  )
})

describe("the agent's note when its model changes", () => {
  const session: Session.SavedSession = { harness: "claude-code", sessionId: "dream-prj_test" }

  it("says so once the family moved to a newer model, and records the model", () => {
    const next = Option.getOrThrow(
      Session.onModel({ ...session, model: "claude-fable-5-1" }, "claude-code", "claude-fable-5-2", undefined)
    )
    assert.strictEqual(next.model, "claude-fable-5-2")
    assert.strictEqual(
      next.preamble,
      "Since your last turn you run on the newest Fable, claude-fable-5-2; your last turn ran on claude-fable-5-1.\n"
    )
    assert.isTrue(Option.isNone(Session.onModel(next, "claude-code", "claude-fable-5-2", undefined)))
  })

  it("reads a session saved before dreamd kept its model from what the last turn ran on", () => {
    const next = Option.getOrThrow(Session.onModel(session, "claude-code", "claude-fable-5-2", "claude-fable-5-1"))
    assert.include(next.preamble ?? "", "newest Fable")
    const first = Option.getOrThrow(Session.onModel(session, "codex", "gpt-6.1-sol", undefined))
    assert.deepStrictEqual(first, { ...session, model: "gpt-6.1-sol" })
  })

  it("names another family plainly, after any note already waiting", () => {
    const next = Option.getOrThrow(
      Session.onModel(
        { ...session, model: "claude-fable-5-2", preamble: "Dream updated its guidance.\n" },
        "claude-code",
        "claude-sonnet-5-5",
        undefined
      )
    )
    assert.strictEqual(
      next.preamble,
      "Dream updated its guidance.\n\nSince your last turn you run on another model, claude-sonnet-5-5; your last turn ran on claude-fable-5-2.\n"
    )
  })

  it("survives a new conversation, and starts over on another harness", () => {
    assert.strictEqual(
      Session.restart({ ...session, model: "claude-opus-5-5" }, "dream-prj_test-2").model,
      "claude-opus-5-5"
    )
  })
})

const bins = process.env.DREAM_HARNESS_BINS

describe.skipIf(bins === undefined)("the pinned CLIs themselves", () => {
  for (const harness of Object.keys(AgentModels) as ReadonlyArray<Harness>) {
    it(`${harness}'s own list has every family, orchestrating and taking every effort`, () => {
      const scratch = mkdtempSync(join(tmpdir(), "dream-models-"))
      const { command, args, stdin, env } = catalogCommand(harness, bins!, scratch)
      const stdout = execFileSync(command, args, {
        input: stdin,
        env: { PATH: process.env.PATH, ...env },
        encoding: "utf8",
        timeout: 30_000
      })
      const catalog = harness === "claude-code" ? parseClaudeModels(stdout) : parseCodexCatalog(stdout)
      assert.isTrue(Option.isSome(catalog), `${harness} gave no model list`)
      assert.deepStrictEqual(catalogProblems(harness, Option.getOrThrow(catalog), ReasoningEfforts), [])
    })
  }
})
