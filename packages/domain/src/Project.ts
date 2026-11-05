import { Schema } from "effect"
import { ProjectId, UserId } from "./Ids.ts"

/** The coding agent that runs the project. Fixed when the project is created. */
export const Harness = Schema.Literals(["claude-code", "codex"])
export type Harness = typeof Harness.Type

/**
 * How hard the top-level agent reasons: the levels both harnesses take for a session (Claude Code's `effort`,
 * Codex's `model_reasoning_effort`). Each model may accept more (Codex's `ultra`) or fewer.
 */
export const ReasoningEffort = Schema.Literals(["low", "medium", "high", "xhigh", "max"])
export type ReasoningEffort = typeof ReasoningEffort.Type

/**
 * Where the project is, as the agent describes it (`dream status --phase`).
 * Starts at "new" (shown as "Looking into this"). If the agent hasn't set one
 * when its first turn starts, the platform moves it to "exploring".
 * Being paused for usage is not a phase; see `StatusCard.pausedUntil`.
 */
export const ProjectPhase = Schema.Literals(["new", "interviewing", "exploring", "building", "live"])
export type ProjectPhase = typeof ProjectPhase.Type

export const Project = Schema.Struct({
  id: ProjectId,
  ownerId: UserId,
  /** Starts as a few words of the idea; the agent names it (`dream status --title`). */
  title: Schema.String,
  /** Short label under the title, e.g. "iOS app" or "Background worker". Set by the agent. */
  kind: Schema.optionalKey(Schema.String),
  /** SF Symbol name for the project tile, e.g. "dumbbell" (agents also use an emoji; the app shows either). Set by the agent. */
  icon: Schema.optionalKey(Schema.String),
  /** What they first asked for, verbatim. */
  idea: Schema.String,
  harness: Harness,
  phase: ProjectPhase,
  /** The one line Home shows under the title: the Status card's `now`, else its `justDid`. */
  headline: Schema.optionalKey(Schema.String),
  /** Lowercase, DNS-safe; the first half of the public hostname. */
  slug: Schema.String,
  /**
   * `https://<slug>-<random>.<domain>`. Assigned at creation and stable for the
   * life of the project; it serves traffic once the agent runs `dream publish`.
   */
  publicUrl: Schema.String,
  /** The sandbox port the public URL forwards to, once published. */
  publishedPort: Schema.optionalKey(Schema.Int),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
})
export type Project = typeof Project.Type

/** A row on Home. Derived from D1; cheap to list. */
export const ProjectSummary = Schema.Struct({
  project: Project,
  /** Open questions and access requests that need them now. */
  openAsks: Schema.Int,
  /** Milestone progress for the row's progress bar, when the agent has milestones. */
  progress: Schema.optionalKey(Schema.Struct({ done: Schema.Int, total: Schema.Int })),
  /** Set while the project waits for a usage window to reset. */
  pausedUntil: Schema.optionalKey(Schema.DateTimeUtc)
})
export type ProjectSummary = typeof ProjectSummary.Type
