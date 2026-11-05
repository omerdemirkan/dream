/**
 * Pin the Claude Code and Codex CLIs the harness bridges install, independently of the versions
 * `@ai-sdk/harness-claude-code` and `@ai-sdk/harness-codex` ship with (they lag upstream by weeks).
 *
 *   node packages/dreamd/scripts/harness-pins.ts                 show the pins, the adapters' own, and npm's latest
 *   node packages/dreamd/scripts/harness-pins.ts latest          pin both to npm's latest
 *   node packages/dreamd/scripts/harness-pins.ts --claude-code 0.3.318 --codex 0.166.0
 *
 * Claude Code is pinned by its Agent SDK version (`@anthropic-ai/claude-agent-sdk`, which carries the binary the
 * bridge runs); the matching `@anthropic-ai/claude-code` comes from the SDK's `claudeCodeVersion`.
 *
 * It starts from the installed adapter's bridge manifest, so everything else the bridge needs stays as the adapter
 * pins it, and writes `src/harness/bridges/<harness>/package.json` with a `pnpm-lock.yaml` resolved by the
 * template's pnpm. Run it again after bumping an adapter (a test fails until you do). Needs npm on PATH.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { adapterBridgeDir, bridgesDir, cliPackages, type PinnedHarness } from "../src/harness/Bridges.ts"

/** The template's pnpm (`versions.pnpm` in packages/sandbox-template), so the lockfile is one it accepts. */
const pnpmVersion = "12.14.0"

const npmView = (spec: string, field: string): string =>
  execFileSync("npm", ["view", spec, field], { encoding: "utf8" }).trim()

type Manifest = { dependencies: Record<string, string> } & Record<string, unknown>
const readJson = (file: string): Manifest => JSON.parse(readFileSync(file, "utf8")) as Manifest

/** The CLI versions to pin for a harness, given what was asked for ("latest" or a version). */
const resolve = (harness: PinnedHarness, wanted: string): Record<string, string> => {
  if (harness === "codex") {
    return { "@openai/codex": wanted === "latest" ? npmView("@openai/codex", "version") : wanted }
  }
  const sdk = wanted === "latest" ? npmView("@anthropic-ai/claude-agent-sdk", "version") : wanted
  const cli = npmView(`@anthropic-ai/claude-agent-sdk@${sdk}`, "claudeCodeVersion")
  if (cli === "") throw new Error(`@anthropic-ai/claude-agent-sdk@${sdk} doesn't say which Claude Code it carries`)
  return { "@anthropic-ai/claude-agent-sdk": sdk, "@anthropic-ai/claude-code": cli }
}

const pin = (harness: PinnedHarness, wanted: string) => {
  const adapter = adapterBridgeDir(harness)
  const manifest = readJson(join(adapter, "package.json"))
  const versions = resolve(harness, wanted)
  const pinned: Manifest = { ...manifest, dependencies: { ...manifest.dependencies, ...versions } }
  const work = mkdtempSync(join(tmpdir(), `dream-${harness}-pins-`))
  try {
    writeFileSync(join(work, "package.json"), `${JSON.stringify(pinned, null, 2)}\n`)
    try {
      writeFileSync(join(work, "pnpm-workspace.yaml"), readFileSync(join(adapter, "pnpm-workspace.yaml")))
    } catch {
      // Only some bridges have one.
    }
    execFileSync("npx", ["--yes", `pnpm@${pnpmVersion}`, "install", "--lockfile-only", "--ignore-scripts"], {
      cwd: work,
      stdio: "inherit"
    })
    const out = join(bridgesDir, harness)
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, "package.json"), readFileSync(join(work, "package.json")))
    writeFileSync(join(out, "pnpm-lock.yaml"), readFileSync(join(work, "pnpm-lock.yaml")))
    console.log(
      `${harness}: pinned ${Object.entries(versions)
        .map(([name, version]) => `${name}@${version}`)
        .join(", ")}`
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const show = () => {
  for (const harness of ["claude-code", "codex"] as const) {
    const adapter = readJson(join(adapterBridgeDir(harness), "package.json")).dependencies
    const ours = readJson(join(bridgesDir, harness, "package.json")).dependencies
    for (const name of cliPackages[harness]) {
      console.log(
        `${name}: pinned ${ours[name]}, adapter ships ${adapter[name]}, npm latest ${npmView(name, "version")}`
      )
    }
  }
}

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const all = args[0] === "latest" ? "latest" : undefined
const claudeCode = option("--claude-code") ?? all
const codex = option("--codex") ?? all
if (claudeCode === undefined && codex === undefined) show()
if (claudeCode !== undefined) pin("claude-code", claudeCode)
if (codex !== undefined) pin("codex", codex)
