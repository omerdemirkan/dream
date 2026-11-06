/**
 * Runs one harness turn on this machine against a fake model server and prints what the stream says about
 * tokens: every `finish-step` and `finish` part, and every `raw` part that carries usage. For checking what
 * `totalUsage` counts, with the fakes' distinctive per-role usage (see their headers).
 *
 *   node packages/dreamd/scripts/fake-anthropic.ts 18789 &
 *   node packages/dreamd/scripts/usage-probe.ts claude-code 'AGENT: {"description":"check","prompt":"SUBAGENT say hi"}'
 *
 *   node packages/dreamd/scripts/fake-responses.ts 18788 &
 *   node packages/dreamd/scripts/usage-probe.ts codex 'SPAWN: {"task_name":"check","message":"SUBAGENT say hi"}'
 *
 * Needs the bridges installed (`node packages/dreamd/src/bin/dreamd.ts bootstrap`, which needs pnpm). Works in
 * a scratch directory (WORKDIR, default a new one under /tmp). Set ALL=1 to print every part, RESUME=<file> to
 * keep the session in a file and resume it from there next time.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HarnessAgent } from "@ai-sdk/harness/agent"
import { createClaudeCode } from "@ai-sdk/harness-claude-code"
import { createCodex } from "@ai-sdk/harness-codex"
import { withPinnedCli } from "../src/harness/Bridges.ts"
import { makeLocalSandboxSession, makeSpawned, stopAll } from "../src/harness/LocalSandbox.ts"

const [harness = "claude-code", ...rest] = process.argv.slice(2)
const prompts = rest.length > 0 ? rest : ["hello"]
const cwd = process.env.WORKDIR ?? mkdtempSync(join(tmpdir(), "usage-probe-"))
const all = process.env.ALL === "1"

const env: Record<string, string> = {
  // Not this shell's own Claude Code session, if it runs in one.
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !/^(CLAUDE|AI_AGENT)/.test(entry[0])
    )
  ),
  DISABLE_AUTOUPDATER: "1",
  ...(harness === "claude-code"
    ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? "http://127.0.0.1:18789" }
    : {})
}
const spawned = makeSpawned()
const sandboxSession = await makeLocalSandboxSession({ id: "usage-probe", cwd, env, spawned })
const agent = new HarnessAgent({
  harness:
    harness === "claude-code"
      ? withPinnedCli("claude-code", createClaudeCode({ auth: { ANTHROPIC_API_KEY: "fake" } }))
      : withPinnedCli(
          "codex",
          createCodex({
            auth: {
              CODEX_API_KEY: "fake",
              OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:18788/backend-api/codex"
            }
          })
        ),
  instructions: "You are a probe.",
  sandboxConfig: { workDir: "." },
  permissionMode: "allow-all",
  model: process.env.MODEL ?? (harness === "claude-code" ? "opus" : "gpt-6.1-sol")
})
// RESUME=<file>: resume the session saved there by an earlier run, and save it there again.
const resumeFile = process.env.RESUME
const saved =
  resumeFile !== undefined && existsSync(resumeFile) ? JSON.parse(readFileSync(resumeFile, "utf8")) : undefined
const session = await agent.createSession({
  sessionId: saved?.sessionId ?? `usage-probe-${Date.now()}`,
  sandboxSession,
  ...(saved === undefined ? {} : { resumeFrom: saved.resumeFrom })
})

const usageOf = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const message = record.message as Record<string, unknown> | undefined
  return record.usage ?? message?.usage
}

try {
  for (const [i, prompt] of prompts.entries()) {
    console.log(`--- turn ${i + 1}: ${prompt}`)
    const result = await agent.stream({ session, prompt })
    for await (const part of result.fullStream) {
      if (all) {
        console.log(JSON.stringify(part))
        continue
      }
      if (part.type === "finish") {
        const { totalUsage, providerMetadata } = part as typeof part & { providerMetadata?: unknown }
        console.log(JSON.stringify({ type: "finish", totalUsage: { ...totalUsage, raw: undefined }, providerMetadata }))
      } else if (part.type === "finish-step") {
        console.log(JSON.stringify({ type: "finish-step", usage: { ...part.usage, raw: undefined } }))
      } else if (part.type === "raw") {
        const raw = part.rawValue as Record<string, unknown>
        const usage = usageOf(raw)
        if (usage !== undefined) {
          const message = raw.message as Record<string, unknown> | undefined
          console.log(
            JSON.stringify({
              type: "raw",
              rawType: raw.type,
              subtype: raw.subtype,
              parent: raw.parent_tool_use_id,
              messageId: message?.id,
              usage
            })
          )
        }
      } else if (part.type === "tool-result") {
        console.log(JSON.stringify({ type: "tool-result", tool: part.toolName, output: part.output }).slice(0, 1500))
      } else if (part.type === "error") {
        console.log(JSON.stringify({ type: "error", error: String(part.error) }))
      }
    }
  }
} finally {
  const resumeFrom = await session.detach().catch(() => undefined)
  if (resumeFile !== undefined) writeFileSync(resumeFile, JSON.stringify({ sessionId: session.sessionId, resumeFrom }))
  await stopAll(spawned)
}
