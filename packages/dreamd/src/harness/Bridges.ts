/**
 * Which Claude Code and Codex the harness bridges install. Each adapter ships a bridge manifest (a package.json and
 * pnpm lockfile) pinning its CLI, and lags upstream releases by weeks; Dream keeps its own copy of each manifest in
 * `bridges/<harness>/`, the same but for the CLI versions, and gives the adapter's bootstrap recipe those files
 * instead. The recipe's identity is a hash of its files, so a new pin is a new recipe: `dreamd bootstrap` installs
 * it when the template is built, and a sandbox refreshed from that template gets the install and its marker.
 *
 * Dream also edits the bridge code where an adapter has no setting for what it needs (`bridgePatches`).
 *
 * `scripts/harness-pins.ts` writes the manifests; `test/bridges.test.ts` checks they still match the installed
 * adapters' apart from the CLIs, and that every patch still applies.
 */
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { HarnessV1 } from "@ai-sdk/harness"

export type PinnedHarness = "claude-code" | "codex"

/** The packages Dream pins in each bridge; everything else in it is the adapter's. */
export const cliPackages: Readonly<Record<PinnedHarness, ReadonlyArray<string>>> = {
  "claude-code": ["@anthropic-ai/claude-agent-sdk", "@anthropic-ai/claude-code"],
  codex: ["@openai/codex"]
}

export const bridgesDir = fileURLToPath(new URL("./bridges/", import.meta.url))

const adapterPackage: Readonly<Record<PinnedHarness, string>> = {
  "claude-code": "@ai-sdk/harness-claude-code",
  codex: "@ai-sdk/harness-codex"
}

/** Where the installed adapter keeps its own bridge manifest. */
export const adapterBridgeDir = (harness: PinnedHarness): string =>
  join(dirname(createRequire(import.meta.url).resolve(adapterPackage[harness])), "bridge")

/** The recipe files Dream replaces, by name within the bootstrap directory. */
const replaced = ["package.json", "pnpm-lock.yaml"] as const

/** The recipe file holding the bridge's code, by name within the bootstrap directory. */
export const bridgeFile = "bridge.mjs"

export interface BridgePatch {
  /** Text that occurs exactly once in the adapter's bridge code. */
  readonly find: string
  readonly replace: string
}

/**
 * Edits to each adapter's bridge code. A patch that no longer finds its text fails the bootstrap (and the test),
 * so an adapter upgrade can't drop it silently.
 *
 * Claude Code records a conversation's system prompt on its first request and sends that record on every later
 * request and resume until the conversation compacts, ignoring the text a later launch passes (`snapshot`, on by
 * default, in the Agent SDK's `systemPrompt`). The project's session lives for weeks, so a new prompt from a
 * template refresh would never reach it. `snapshot: false` renders the prompt on every request instead, from what
 * dreamd passes, which is the same text until the template changes it. The adapter has no setting for it.
 */
export const bridgePatches: Readonly<Record<PinnedHarness, ReadonlyArray<BridgePatch>>> = {
  "claude-code": [{ find: `preset: "claude_code",\n`, replace: `preset: "claude_code",\n\t\tsnapshot: false,\n` }],
  codex: []
}

/** The bridge code with `patches` applied; throws if one doesn't find its text exactly once. */
export const patchBridge = (code: string, patches: ReadonlyArray<BridgePatch>): string =>
  patches.reduce((patched, { find, replace }) => {
    const parts = patched.split(find)
    if (parts.length !== 2) {
      throw new Error(`A bridge patch found its text ${parts.length - 1} times, not once: ${JSON.stringify(find)}`)
    }
    return parts.join(replace)
  }, code)

/**
 * The adapter, with a bootstrap recipe that installs Dream's pinned CLI: the adapter's own recipe (its bridge code,
 * workspace settings and install commands) with Dream's manifest and lockfile, and its bridge code patched.
 */
export const withPinnedCli = <H extends Pick<HarnessV1, "getBootstrap">>(harness: PinnedHarness, adapter: H): H => {
  const getBootstrap = adapter.getBootstrap
  if (getBootstrap === undefined) return adapter
  return {
    ...adapter,
    getBootstrap: async (options?: { abortSignal?: AbortSignal }) => {
      const recipe = await getBootstrap(options)
      const pinned = Object.fromEntries(
        await Promise.all(
          replaced.map(async (name) => [name, await readFile(join(bridgesDir, harness, name), "utf8")] as const)
        )
      )
      const prefix = `${recipe.bootstrapDir}/`
      return {
        ...recipe,
        files: recipe.files.map((file) => {
          const name = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : undefined
          if (name === bridgeFile) return { ...file, content: patchBridge(file.content, bridgePatches[harness]) }
          const content = name === undefined ? undefined : pinned[name]
          return content === undefined ? file : { ...file, content }
        })
      }
    }
  }
}
