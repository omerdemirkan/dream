/**
 * Moves Dream to the newest Claude Code and Codex its harness adapters can run, and checks the move end to end.
 *
 *   bun run harness:update                  update, check, and run a turn on each harness in a test template
 *   bun run harness:update status           what's pinned, what the adapters pin, what npm has; changes nothing
 *   bun run harness:update --ship           all of the above, then commit to main, push it, build the production
 *                                           template, deploy the Worker, and push the GitHub mirror
 *
 *   --claude-code <version>   pin this Agent SDK (`@anthropic-ai/claude-agent-sdk`) instead of the newest safe one
 *   --codex <version>         pin this Codex instead of the newest safe one
 *   --keep-adapters           leave the AI SDK harness adapters where they are
 *   --no-template             skip the test template (the unit tests still read the new CLIs' model lists)
 *
 * What it does, in order, stopping (and putting every file back) at the first failure:
 *
 * 1. The adapters (`@ai-sdk/harness`, `-claude-code`, `-codex`) move to npm's newest, together, with the `ai` and
 *    `@ai-sdk/provider-utils` versions `@ai-sdk/harness` is built on, wherever a workspace package declares them.
 * 2. Each CLI moves to the newest release in the line its adapter pins (Codex 0.167.x when the adapter pins 0.167.0;
 *    a new minor of Codex has broken the adapter before, and the adapter moves to it when it's ready) that's at least
 *    a day old, since the template's pnpm installs nothing newer. Claude Code is
 *    pinned by its Agent SDK, which says which Claude Code it carries. The bridge manifests and lockfiles in
 *    `src/harness/bridges/<harness>/` are rewritten from the adapter's own, with only the CLIs changed.
 * 3. Both the old and the new CLIs are installed in a scratch directory, and each one's own model list is read the way
 *    dreamd reads it (`src/harness/Models.ts`): what each family Dream offers ran on before and runs on now, and a
 *    stop if a family no longer has a model that orchestrates and takes every effort Dream offers.
 * 4. `bun run check`, with `test/models.test.ts` reading the new CLIs themselves.
 * 5. `DREAM_TEMPLATE=dream-sandbox-update bun run template:build`, whose harness check runs a turn on each harness
 *    against the fake model servers and checks each asked for the concrete model dreamd resolved; then the test
 *    templates are deleted. E2B's proxy sometimes answers 407, so a failed build is tried once more.
 *
 * Model choices are families (`AgentModels` in the domain), so nothing else changes: each project's next turn after
 * the refresh runs on its family's newest model in the new CLI, and the agent is told when that's a different model.
 * The order `--ship` uses is the order to ship by hand: main first, then the template (existing sandboxes pick it up
 * between turns), then the Worker, then the mirror. Needs npm, git, curl and E2B credentials (E2B_API_KEY, or a proxy
 * that adds it); `--ship` also needs what `bun run infra:deploy` does.
 */
import { execFileSync, type ExecFileSyncOptions } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AgentModels, type Harness, ReasoningEfforts } from "@dream/domain"
import { Option } from "effect"
import { adapterBridgeDir, bridgesDir, cliPackages, type PinnedHarness } from "../src/harness/Bridges.ts"
import {
  type CatalogModel,
  catalogCommand,
  catalogProblems,
  newestOf,
  parseClaudeModels,
  parseCodexCatalog
} from "../src/harness/Models.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const harnesses = ["claude-code", "codex"] as const
/** The template's pnpm (`versions.pnpm` in packages/sandbox-template), so the lockfile is one it accepts. */
const pnpmVersion = "12.14.0"
const testTemplate = "dream-sandbox-update"
const adapters = ["@ai-sdk/harness", "@ai-sdk/harness-claude-code", "@ai-sdk/harness-codex"] as const
/** What `@ai-sdk/harness` is built on, which the packages that use its types must match. */
const sdkPackages = ["ai", "@ai-sdk/provider-utils", "@ai-sdk/provider"] as const
/** Every workspace package, in the order HANDOFF.md typechecks them one at a time. */
const typechecked = [
  "packages/domain",
  "packages/agent-context",
  "packages/sandbox-template",
  "packages/dreamd",
  "apps/api",
  "infra",
  "apps/mobile"
]
const workspaces = [
  "packages/dreamd",
  "packages/domain",
  "packages/sandbox-template",
  "apps/api",
  "apps/mobile",
  "infra"
]

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } & Record<
  string,
  unknown
>
const readJson = (file: string): Manifest => JSON.parse(readFileSync(file, "utf8")) as Manifest
const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

const run = (command: string, args: ReadonlyArray<string>, options: ExecFileSyncOptions = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options })
const output = (command: string, args: ReadonlyArray<string>, options: ExecFileSyncOptions = {}) =>
  String(
    execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options })
  ).trim()
const npmView = (spec: string, field: string): string => output("npm", ["view", spec, field])
const npmJson = <A>(spec: string, field: string): A => JSON.parse(output("npm", ["view", spec, field, "--json"])) as A

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

const parts = (version: string) => version.split(".").map(Number)
const compare = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * The stable releases in `pinned`'s line (same major and minor) that `released` allows, newest first, never older
 * than `pinned`, which comes last.
 */
export const inLine = (
  versions: ReadonlyArray<string>,
  pinned: string,
  released: (version: string) => boolean = () => true
): ReadonlyArray<string> => {
  const [major, minor] = parts(pinned)
  const line = versions.filter((version) => {
    if (!/^\d+\.\d+\.\d+$/.test(version) || version === pinned || !released(version)) return false
    const [a, b] = parts(version)
    return a === major && b === minor && compare(version, pinned) > 0
  })
  return [...line.sort((a, b) => compare(b, a)), pinned]
}

/**
 * pnpm 12 installs nothing published less than a day ago (its default `minimumReleaseAge`, which the template's
 * bootstrap enforces), so a release isn't pinned before then either.
 */
const minimumReleaseAgeMs = 24 * 60 * 60_000
const releasedADayAgo = (name: string) => {
  const times = npmJson<Record<string, string>>(name, "time")
  const cutoff = Date.now() - minimumReleaseAgeMs
  return (version: string) => times[version] !== undefined && Date.parse(times[version]) <= cutoff
}

const dependencies = (manifest: Manifest) => ({ ...manifest.devDependencies, ...manifest.dependencies })

/** The CLI versions a bridge manifest pins. */
const pinsOf = (dir: string, harness: PinnedHarness): Record<string, string> => {
  const deps = dependencies(readJson(join(dir, "package.json")))
  return Object.fromEntries(cliPackages[harness].map((name) => [name, deps[name] ?? "?"]))
}

/** The CLI versions to pin for a harness, given the Agent SDK or Codex version wanted. */
const cliVersions = (harness: PinnedHarness, wanted: string): Record<string, string> => {
  if (harness === "codex") return { "@openai/codex": wanted }
  const cli = npmView(`@anthropic-ai/claude-agent-sdk@${wanted}`, "claudeCodeVersion")
  if (cli === "") throw new Error(`@anthropic-ai/claude-agent-sdk@${wanted} doesn't say which Claude Code it carries`)
  return { "@anthropic-ai/claude-agent-sdk": wanted, "@anthropic-ai/claude-code": cli }
}

/** The package that picks a harness's pin: the Agent SDK for Claude Code, Codex itself. */
const leadPackage: Record<PinnedHarness, string> = {
  "claude-code": "@anthropic-ai/claude-agent-sdk",
  codex: "@openai/codex"
}

/** The newest CLI the installed adapter can run: the newest release in the line of the CLI it pins itself. */
const safeVersion = (harness: PinnedHarness): string => {
  const adapterPin = pinsOf(adapterBridgeDir(harness), harness)[leadPackage[harness]]!
  const candidates = inLine(
    npmJson<ReadonlyArray<string>>(leadPackage[harness], "versions"),
    adapterPin,
    releasedADayAgo(leadPackage[harness])
  )
  if (harness === "codex") return candidates[0]!
  // The Agent SDK's Claude Code has to be a day old too.
  const cliReleased = releasedADayAgo("@anthropic-ai/claude-code")
  return candidates.find((sdk) => cliReleased(cliVersions(harness, sdk)["@anthropic-ai/claude-code"]!)) ?? adapterPin
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Every file the update may change, so a failure can put them back. */
const touched = () => [
  "bun.lock",
  ...workspaces.map((dir) => join(dir, "package.json")),
  ...harnesses.flatMap((harness) =>
    ["package.json", "pnpm-lock.yaml"].map((file) => join("packages/dreamd/src/harness/bridges", harness, file))
  )
]

const backup = (dir: string) => {
  for (const file of touched()) {
    if (!existsSync(join(root, file))) continue
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    copyFileSync(join(root, file), join(dir, file))
  }
}
const restore = (dir: string) => {
  for (const file of touched()) {
    if (existsSync(join(dir, file))) copyFileSync(join(dir, file), join(root, file))
  }
  run("bun", ["install"])
}

/** Step 1: the adapters to npm's newest, with the AI SDK they're built on. Returns what moved. */
const moveAdapters = (): ReadonlyArray<string> => {
  const latest = {
    "@ai-sdk/harness-claude-code": npmView("@ai-sdk/harness-claude-code", "version"),
    "@ai-sdk/harness-codex": npmView("@ai-sdk/harness-codex", "version")
  }
  const cores = Object.entries(latest).map(
    ([name, version]) => npmJson<Record<string, string>>(`${name}@${version}`, "dependencies")["@ai-sdk/harness"]
  )
  if (cores[0] === undefined || cores[0] !== cores[1]) {
    throw new Error(
      `The newest adapters are built on different @ai-sdk/harness versions (${cores.join(", ")}); wait for them to line up`
    )
  }
  const core = npmJson<Record<string, string>>(`@ai-sdk/harness@${cores[0]}`, "dependencies")
  const wanted: Record<string, string> = { ...latest, "@ai-sdk/harness": cores[0] }
  for (const name of sdkPackages) if (core[name] !== undefined) wanted[name] = core[name]
  const moved: Array<string> = []
  for (const dir of workspaces) {
    const file = join(root, dir, "package.json")
    const manifest = readJson(file)
    let changed = false
    for (const field of ["dependencies", "devDependencies"] as const) {
      const deps = manifest[field]
      if (deps === undefined) continue
      for (const [name, version] of Object.entries(wanted)) {
        if (deps[name] === undefined || deps[name] === version) continue
        moved.push(`${name} ${deps[name]} → ${version} (${dir})`)
        deps[name] = version
        changed = true
      }
    }
    if (changed) writeJson(file, manifest)
  }
  if (moved.length > 0) run("bun", ["install"])
  return moved
}

/**
 * Step 2, in a process of its own (so the adapters just installed are the ones resolved): writes each bridge
 * manifest from the installed adapter's, with `versions` for the CLIs, and a lockfile from the template's pnpm.
 */
const pin = (harness: PinnedHarness, versions: Record<string, string>) => {
  const adapter = adapterBridgeDir(harness)
  const manifest = readJson(join(adapter, "package.json"))
  const pinned: Manifest = { ...manifest, dependencies: { ...manifest.dependencies, ...versions } }
  const work = mkdtempSync(join(tmpdir(), `dream-${harness}-pins-`))
  try {
    writeJson(join(work, "package.json"), pinned)
    if (existsSync(join(adapter, "pnpm-workspace.yaml"))) {
      copyFileSync(join(adapter, "pnpm-workspace.yaml"), join(work, "pnpm-workspace.yaml"))
    }
    run("npx", ["--yes", `pnpm@${pnpmVersion}`, "install", "--lockfile-only", "--ignore-scripts"], { cwd: work })
    const out = join(bridgesDir, harness)
    mkdirSync(out, { recursive: true })
    copyFileSync(join(work, "package.json"), join(out, "package.json"))
    copyFileSync(join(work, "pnpm-lock.yaml"), join(out, "pnpm-lock.yaml"))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Installs a bridge manifest (from `from`) into `bins/<harness>`, as `dreamd bootstrap` lays it out, with the
 * adapter's `pnpm-workspace.yaml` (which lets Claude Code's install script run).
 */
const install = (from: string, bins: string, harness: PinnedHarness) => {
  const dir = join(bins, harness)
  mkdirSync(dir, { recursive: true })
  for (const file of ["package.json", "pnpm-lock.yaml"]) copyFileSync(join(from, file), join(dir, file))
  const workspace = join(adapterBridgeDir(harness), "pnpm-workspace.yaml")
  if (existsSync(workspace)) copyFileSync(workspace, join(dir, "pnpm-workspace.yaml"))
  run("npx", ["--yes", `pnpm@${pnpmVersion}`, "install", "--frozen-lockfile", "--silent"], { cwd: dir })
}

/** A CLI's own model list, read as dreamd reads it. */
const catalogIn = (bins: string, harness: Harness): ReadonlyArray<CatalogModel> => {
  const scratch = mkdtempSync(join(tmpdir(), "dream-models-"))
  try {
    const { command, args, stdin, env } = catalogCommand(harness, bins, scratch)
    const stdout = output(command, args, { input: stdin, env: { PATH: process.env.PATH, ...env }, stdio: "pipe" })
    const catalog = harness === "claude-code" ? parseClaudeModels(stdout) : parseCodexCatalog(stdout)
    if (Option.isNone(catalog)) throw new Error(`${harness} gave no model list`)
    return catalog.value
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Each family Dream offers, and the model it runs as in `catalog`. */
const families = (harness: Harness, catalog: ReadonlyArray<CatalogModel>) =>
  Object.fromEntries(
    AgentModels[harness].map((option) => [
      option.id,
      Option.match(newestOf(harness, catalog, option.id), { onNone: () => "(none)", onSome: (model) => model.id })
    ])
  )

/** The test template's ids (standard and large), for deleting it. */
const deleteTestTemplates = () => {
  const key = process.env.E2B_API_KEY === undefined ? [] : ["-H", `X-API-KEY: ${process.env.E2B_API_KEY}`]
  const list = JSON.parse(output("curl", ["-fsS", ...key, "https://api.e2b.app/templates"])) as ReadonlyArray<{
    readonly templateID: string
    readonly aliases?: ReadonlyArray<string>
  }>
  for (const template of list) {
    if (!template.aliases?.some((alias) => alias === testTemplate || alias === `${testTemplate}-large`)) continue
    output("curl", ["-fsS", "-X", "DELETE", ...key, `https://api.e2b.app/templates/${template.templateID}`])
    console.log(`Deleted the test template ${template.aliases.join(", ")}`)
  }
}

/** Runs `bun run template:build` (with `env`), once more if it fails, as E2B's proxy sometimes makes it. */
const buildTemplate = (env: Record<string, string>) => {
  try {
    run("bun", ["run", "template:build"], { env: { ...process.env, ...env } })
  } catch {
    console.log("The template build failed; trying once more")
    run("bun", ["run", "template:build"], { env: { ...process.env, ...env } })
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const status = () => {
  for (const name of adapters) {
    const ours = dependencies(readJson(join(root, "packages/dreamd/package.json")))[name]
    console.log(`${name}: ${ours}, npm newest ${npmView(name, "version")}`)
  }
  for (const harness of harnesses) {
    const adapter = pinsOf(adapterBridgeDir(harness), harness)
    const ours = pinsOf(join(bridgesDir, harness), harness)
    for (const name of cliPackages[harness]) {
      console.log(
        `${name}: pinned ${ours[name]}, the adapter pins ${adapter[name]}, npm newest ${npmView(name, "version")}`
      )
    }
    console.log(`  newest the adapter can run: ${leadPackage[harness]} ${safeVersion(harness)}`)
  }
}

const update = (flags: ReadonlySet<string>, option: (name: string) => string | undefined) => {
  const ship = flags.has("--ship")
  if (output("git", ["status", "--porcelain"]) !== "") throw new Error("Commit or stash your changes first")
  if (ship) {
    run("git", ["fetch", "origin"])
    if (output("git", ["branch", "--show-current"]) !== "main") throw new Error("--ship runs on main")
    if (output("git", ["rev-parse", "HEAD"]) !== output("git", ["rev-parse", "origin/main"])) {
      throw new Error("--ship needs main to be origin/main: deploying anything else rolls other fixes back")
    }
  }
  const saved = mkdtempSync(join(tmpdir(), "dream-update-backup-"))
  const bins = {
    before: mkdtempSync(join(tmpdir(), "dream-bins-before-")),
    after: mkdtempSync(join(tmpdir(), "dream-bins-"))
  }
  backup(saved)
  let committed = false
  const before = Object.fromEntries(harnesses.map((harness) => [harness, pinsOf(join(bridgesDir, harness), harness)]))
  try {
    const adaptersMoved = flags.has("--keep-adapters") ? [] : moveAdapters()
    // A process of its own, so the adapters just installed are the ones whose manifests it reads.
    const wanted = { "claude-code": option("--claude-code"), codex: option("--codex") }
    run("node", [
      fileURLToPath(import.meta.url),
      "pin",
      ...harnesses.flatMap((harness) => (wanted[harness] === undefined ? [] : [`--${harness}`, wanted[harness]!]))
    ])
    const after = Object.fromEntries(harnesses.map((harness) => [harness, pinsOf(join(bridgesDir, harness), harness)]))
    const moved = [
      ...adaptersMoved,
      ...harnesses.flatMap((harness) =>
        cliPackages[harness].flatMap((name) =>
          before[harness]![name] === after[harness]![name]
            ? []
            : [`${name} ${before[harness]![name]} → ${after[harness]![name]}`]
        )
      )
    ]
    if (moved.length === 0) {
      console.log("Everything is already on the newest versions the adapters can run.")
      return
    }
    console.log(`\nMoving:\n${moved.map((line) => `  ${line}`).join("\n")}\n`)

    const changes: Array<string> = []
    for (const harness of harnesses) {
      install(join(saved, "packages/dreamd/src/harness/bridges", harness), bins.before, harness)
      install(join(bridgesDir, harness), bins.after, harness)
      const now = catalogIn(bins.after, harness)
      const problems = catalogProblems(harness, now, ReasoningEfforts)
      if (problems.length > 0)
        throw new Error(`The new ${harness} can't run every family Dream offers:\n${problems.join("\n")}`)
      const [was, is] = [families(harness, catalogIn(bins.before, harness)), families(harness, now)]
      for (const family of Object.keys(is)) {
        changes.push(`  ${family}: ${was[family] === is[family] ? is[family] : `${was[family]} → ${is[family]}`}`)
      }
    }
    console.log(`What each family runs as:\n${changes.join("\n")}\n`)

    // `bun run check`, one package's typecheck at a time (all at once runs small machines out of memory).
    run("bun", ["run", "format:check"])
    for (const dir of typechecked) run("bun", ["run", "typecheck"], { cwd: join(root, dir) })
    run("bun", ["run", "test"], { env: { ...process.env, DREAM_HARNESS_BINS: bins.after } })
    if (!flags.has("--no-template")) {
      try {
        buildTemplate({ DREAM_TEMPLATE: testTemplate })
      } finally {
        deleteTestTemplates()
      }
    }
    console.log(`\nUpdated and checked:\n${moved.map((line) => `  ${line}`).join("\n")}\n${changes.join("\n")}`)

    if (!ship) {
      console.log("\nNothing is committed or deployed. Commit it, or run again with --ship.")
      return
    }
    run("git", ["commit", "-am", `Harnesses: ${moved.join(", ")}\n\n${changes.join("\n")}`])
    committed = true
    run("git", ["push", "origin", "HEAD:main"])
    buildTemplate({})
    run("bun", ["run", "infra:deploy"])
    const origin = output("git", ["remote", "get-url", "origin"])
    if (!origin.includes("github.com/omerdemirkan/dream")) {
      run("git", ["push", "https://github.com/omerdemirkan/dream.git", "origin/main:refs/heads/main"])
    }
    console.log("\nShipped: every sandbox picks the new CLIs up between turns.")
  } catch (error) {
    if (committed) {
      console.error("\nThe update is committed on main; finish shipping it by hand from the step that failed.")
    } else {
      console.error("\nPutting the files back as they were")
      restore(saved)
    }
    throw error
  } finally {
    for (const dir of [saved, bins.before, bins.after]) rmSync(dir, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const flags = new Set(args.filter((arg) => arg.startsWith("--")))
const known = new Set(["--claude-code", "--codex", "--keep-adapters", "--no-template", "--ship", "--help"])
const unknown = [...flags].filter((flag) => !known.has(flag))

if (import.meta.url === `file://${process.argv[1]}`) {
  if (flags.has("--help") || unknown.length > 0) {
    if (unknown.length > 0) console.error(`Unknown: ${unknown.join(", ")}\n`)
    console.log(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("*/")[0]!
        .replace(/^\/\*\*\n|^ \* ?/gm, "")
    )
    process.exitCode = unknown.length > 0 ? 2 : 0
  } else if (args[0] === "status") {
    status()
  } else if (args[0] === "pin") {
    for (const harness of harnesses) {
      const versions = cliVersions(harness, option(`--${harness}`) ?? safeVersion(harness))
      pin(harness, versions)
      console.log(
        `${harness}: ${Object.entries(versions)
          .map(([name, version]) => `${name}@${version}`)
          .join(", ")}`
      )
    }
  } else {
    update(flags, option)
  }
}
