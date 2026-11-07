/**
 * What Dream writes into an E2B sandbox's metadata, so that whoever lists sandboxes (the Worker's reaper, the cost
 * report, a person at the dashboard) can tell what each one is for, and which ones are safe to clean up.
 *
 * Product sandboxes always carry the user they belong to: a project's (`projectId`, `userId`), a refresh donor
 * (the project's, plus `purpose: "refresh-donor"`), a model sign-in (`purpose: "model-connect"`, `userId`).
 * Scripts that make throwaway sandboxes (template checks, probes, QA tools) label them `purpose: "dev"` with the
 * script's name; a sandbox with no owner at all counts as one of those.
 */
import { DateTime, Duration, Schema } from "effect"

export const SandboxPurpose = Schema.Literals(["refresh-donor", "model-connect", "harness-check", "dev"])
export type SandboxPurpose = typeof SandboxPurpose.Type

/** The metadata keys Dream uses. */
export const SandboxMetadataKey = {
  projectId: "projectId",
  userId: "userId",
  purpose: "purpose",
  /** Which script made a `dev` sandbox. */
  script: "script",
  /** `"skip"`: the reaper leaves this sandbox alone (a long experiment someone is watching). */
  reaper: "reaper"
} as const

/** Metadata for a sandbox a script makes and should kill when it's done. */
export const devSandboxMetadata = (script: string, purpose: "dev" | "harness-check" = "dev") => ({
  [SandboxMetadataKey.purpose]: purpose,
  [SandboxMetadataKey.script]: script
})

/** A throwaway sandbox running, or paused, longer than this was forgotten: the reaper kills it. */
export const ReapAfter = Duration.hours(1)

/** What the reaper knows of a listed sandbox. */
export interface ListedSandbox {
  readonly sandboxId: string
  /** When it last started or resumed. */
  readonly startedAt: DateTime.Utc
  readonly metadata: Readonly<Record<string, string>>
}

/**
 * Whether a sandbox is a forgotten throwaway: no owner (no `projectId` or `userId`), or a refresh donor (which lives
 * minutes), started over `ReapAfter` ago. Never a sandbox some project records as its own (`projectSandboxes`), and
 * never one labeled to be left alone.
 */
export const reapable = (sandbox: ListedSandbox, now: DateTime.Utc, projectSandboxes: ReadonlySet<string>): boolean => {
  const meta = sandbox.metadata
  if (projectSandboxes.has(sandbox.sandboxId)) return false
  if (meta[SandboxMetadataKey.reaper] === "skip") return false
  const donor = meta[SandboxMetadataKey.purpose] === "refresh-donor"
  const owned = meta[SandboxMetadataKey.projectId] !== undefined || meta[SandboxMetadataKey.userId] !== undefined
  if (owned && !donor) return false
  return Duration.isGreaterThanOrEqualTo(DateTime.distance(sandbox.startedAt, now), ReapAfter)
}

// ---------------------------------------------------------------------------
// Machine sizes
// ---------------------------------------------------------------------------

/**
 * The machines a project's sandbox can be. New projects get `standard`; the agent can ask for `large` when builds
 * crawl or processes get killed for memory (`dream machine move`), and back. E2B can't resize a sandbox, so a change
 * is a move: Dream copies the home directory into a new sandbox of the other size between turns and restarts the
 * servers that were running.
 */
export const SandboxSize = Schema.Literals(["standard", "large"])
export type SandboxSize = typeof SandboxSize.Type

/** What each size has. Projects created before sizes existed are `large` (they were all 4 CPUs and 8 GB). */
export const SandboxSizes: Readonly<Record<SandboxSize, { readonly cpus: number; readonly memoryGb: number }>> = {
  standard: { cpus: 2, memoryGb: 4 },
  large: { cpus: 4, memoryGb: 8 }
}

/** The size of a sandbox E2B reports `cpuCount` vCPUs for. */
export const sizeForCpus = (cpuCount: number): SandboxSize =>
  cpuCount >= SandboxSizes.large.cpus ? "large" : "standard"

/** A move the agent asked for, done after the turn it asked in. */
export const MachineMove = Schema.Struct({
  to: SandboxSize,
  why: Schema.String,
  requestedAt: Schema.DateTimeUtc
})
export type MachineMove = typeof MachineMove.Type

/** `dream machine`: this sandbox's size, and a move that's waiting. */
export const MachineInfo = Schema.Struct({
  size: SandboxSize,
  cpus: Schema.Int,
  memoryGb: Schema.Int,
  move: Schema.optionalKey(MachineMove)
})
export type MachineInfo = typeof MachineInfo.Type

export const machineInfo = (size: SandboxSize, move?: MachineMove): MachineInfo => ({
  size,
  ...SandboxSizes[size],
  ...(move === undefined ? {} : { move })
})
