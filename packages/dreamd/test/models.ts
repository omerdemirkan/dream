/** The model lists the pinned CLIs return, as captured from Claude Code 2.1.322 and Codex 0.167.2 (`fixtures/models`). */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Option } from "effect"
import { parseClaudeModels, parseCodexCatalog } from "../src/harness/Models.ts"

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "models", name), "utf8")

export const claudeOutput = fixture("claude-code-2.1.322-initialize.jsonl")
export const codexOutput = fixture("codex-0.167.2-bundled.json")
export const claudeCatalog = Option.getOrThrow(parseClaudeModels(claudeOutput))
export const codexCatalog = Option.getOrThrow(parseCodexCatalog(codexOutput))
