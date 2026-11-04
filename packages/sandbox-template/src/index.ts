/**
 * The E2B template every project sandbox starts from: Node 24, pnpm,
 * Playwright's system dependencies, dreamd, and what the harnesses need
 * (@ai-sdk/harness-claude-code installs its own pinned `claude` with pnpm and
 * needs >= 2 GB RAM at peak; Codex runs `codex app-server`). E2B's base
 * template (512 MB) OOMs on those installs, so build with
 * `Template.build(template, templateName, { cpuCount, memoryMB })`.
 *
 * Skeleton only: the sandbox-runtime workstream fills in the steps and the
 * build script; infra wraps the build as a custom Alchemy resource.
 */
import { Template } from "e2b"

/** The template name sandboxes are created from. */
export const templateName = "dream-sandbox"

export const template = Template().fromNodeImage("24").runCmd("corepack enable pnpm", { user: "root" })
