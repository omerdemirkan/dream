/** Shared test values: a config pointing at a temp dir, and event builders. */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentEvent, DaemonEnv, type EventId, type MessageId, type WakeId } from "@dream/domain"
import { NodeServices } from "@effect/platform-node"
import { DateTime, Layer } from "effect"
import { DreamdConfig } from "../src/Config.ts"

export const tempDir = (prefix = "dreamd-test-") => mkdtempSync(join(tmpdir(), prefix))

export const configRecord = (dir: string, overrides: Record<string, string> = {}): Record<string, string> => ({
  HOME: dir,
  DREAM_STATE_DIR: join(dir, "state"),
  DREAM_WORKDIR: join(dir, "project"),
  [DaemonEnv.apiUrl]: "http://api.test",
  [DaemonEnv.projectId]: "prj_test",
  [DaemonEnv.projectToken]: "project-token",
  [DaemonEnv.daemonToken]: "daemon-token",
  [DaemonEnv.harness]: "claude-code",
  [DaemonEnv.socket]: join(dir, "dreamd.sock"),
  ...overrides
})

/** Config and Node services for a test rooted at `dir`. */
export const baseLayer = (dir: string, overrides: Record<string, string> = {}) =>
  Layer.mergeAll(DreamdConfig.layerFromRecord(configRecord(dir, overrides)), NodeServices.layer)

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 4, 22, minute))

export const userMessage = (n: number, text = `message ${n}`) =>
  AgentEvent.cases.UserMessage.make({
    id: `evt_${n}` as EventId,
    at: at(n),
    messageId: `msg_${n}` as MessageId,
    text
  })

export const wakeWithCommand = (n: number, command: string) =>
  AgentEvent.cases.WakeDue.make({
    id: `evt_${n}` as EventId,
    at: at(n),
    wakeId: `wak_${n}` as WakeId,
    why: "check the scraper",
    run: { command }
  })

export const usageReset = (n: number) =>
  AgentEvent.cases.UsageReset.make({ id: `evt_${n}` as EventId, at: at(n), window: "fiveHour" })
