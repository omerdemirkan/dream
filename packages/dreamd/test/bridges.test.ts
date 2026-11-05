import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClaudeCode } from "@ai-sdk/harness-claude-code"
import { createCodex } from "@ai-sdk/harness-codex"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { adapterBridgeDir, bridgesDir, cliPackages, withPinnedCli } from "../src/harness/Bridges.ts"

const dependencies = (file: string): Record<string, string> =>
  (JSON.parse(readFileSync(file, "utf8")) as { dependencies: Record<string, string> }).dependencies

describe("Dream's bridge manifests", () => {
  for (const harness of ["claude-code", "codex"] as const) {
    it(`${harness}: match the installed adapter's but for the CLI (else run scripts/harness-pins.ts)`, () => {
      const adapter = dependencies(join(adapterBridgeDir(harness), "package.json"))
      const ours = dependencies(join(bridgesDir, harness, "package.json"))
      const others = (deps: Record<string, string>) =>
        Object.fromEntries(Object.entries(deps).filter(([name]) => !cliPackages[harness].includes(name)))
      assert.deepStrictEqual(others(ours), others(adapter))
      const lock = readFileSync(join(bridgesDir, harness, "pnpm-lock.yaml"), "utf8")
      for (const name of cliPackages[harness]) {
        assert.isDefined(ours[name], name)
        assert.include(lock, `'${name}@${ours[name]}'`)
      }
    })
  }

  it.effect("replace the adapter's manifest and lockfile in its recipe, and nothing else", () =>
    Effect.gen(function* () {
      for (const [harness, adapter] of [
        ["claude-code", createClaudeCode()],
        ["codex", createCodex()]
      ] as const) {
        const original = yield* Effect.promise(async () => (await adapter.getBootstrap?.()) ?? undefined)
        const pinned = yield* Effect.promise(
          async () => (await withPinnedCli(harness, adapter).getBootstrap?.()) ?? undefined
        )
        assert.isDefined(original)
        assert.isDefined(pinned)
        if (original === undefined || pinned === undefined) return
        assert.deepStrictEqual(pinned.commands, original.commands)
        assert.deepStrictEqual(
          pinned.files.map((file) => file.path),
          original.files.map((file) => file.path)
        )
        for (const [index, file] of pinned.files.entries()) {
          const name = file.path.slice(`${pinned.bootstrapDir}/`.length)
          const expected =
            name === "package.json" || name === "pnpm-lock.yaml"
              ? readFileSync(join(bridgesDir, harness, name), "utf8")
              : original.files[index]?.content
          assert.strictEqual(file.content, expected, file.path)
        }
      }
    })
  )
})
