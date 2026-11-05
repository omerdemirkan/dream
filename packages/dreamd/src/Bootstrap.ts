/**
 * `dreamd bootstrap`, run once while the sandbox template is built: installs
 * what both harness adapters need under `~/.ai-sdk-harness` (each adapter's
 * bridge with the Claude Code or Codex CLI Dream pins, see `Bridges.ts`) and records the markers
 * `HarnessAgent` checks, so a project's first turn starts in seconds instead
 * of installing a quarter-gigabyte of CLI.
 */
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HarnessAgent } from "@ai-sdk/harness/agent"
import { createClaudeCode } from "@ai-sdk/harness-claude-code"
import { createCodex } from "@ai-sdk/harness-codex"
import { DefaultDaemonSocket } from "@dream/domain"
import { Config, Effect } from "effect"
import { withPinnedCli } from "./harness/Bridges.ts"
import { agentEnv, harnessAuth } from "./harness/HarnessEnv.ts"
import { makeLocalSandboxSession } from "./harness/LocalSandbox.ts"

export const bootstrap = Effect.gen(function* () {
  const home = yield* Config.NonEmptyString("HOME")
  const env = agentEnv(process.env, { home, socket: DefaultDaemonSocket })
  const session = yield* Effect.promise(() =>
    makeLocalSandboxSession({ id: "bootstrap", cwd: join(tmpdir(), "dreamd-bootstrap"), env })
  )
  const templates = yield* Effect.tryPromise(() =>
    Promise.all([
      new HarnessAgent({
        harness: withPinnedCli("claude-code", createClaudeCode({ auth: harnessAuth("claude-code") }))
      }).getSandboxTemplate(),
      new HarnessAgent({
        harness: withPinnedCli("codex", createCodex({ auth: harnessAuth("codex") }))
      }).getSandboxTemplate()
    ])
  )
  for (const template of templates) {
    if (template === undefined) return yield* Effect.die(new Error("A harness has nothing to install"))
    yield* Effect.logInfo("Installing a harness bridge and its CLI", { identity: template.identity })
    yield* Effect.tryPromise(() => template.prepare({ session: session.restricted() }))
  }
  const versions = yield* Effect.tryPromise(() =>
    session.run({
      command: [
        "cd ~/.ai-sdk-harness/.harness-bootstrap",
        'echo "claude $(claude-code/node_modules/.bin/claude --version)"',
        'echo "codex $(codex/node_modules/.bin/codex --version)"'
      ].join(" && ")
    })
  )
  if (versions.exitCode !== 0) {
    return yield* Effect.die(new Error(`The installed CLIs don't run: ${versions.stderr}`))
  }
  yield* Effect.logInfo(`Installed:\n${versions.stdout.trim()}`)
})
