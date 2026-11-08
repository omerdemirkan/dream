import { Schema } from "effect"
import { ProjectId, UserId } from "./Ids.ts"
import type { ModelProvider } from "./Usage.ts"
import { UsageLimitReached } from "./Usage.ts"

/** The coding agent that runs the project. Fixed when the project is created. */
export const Harness = Schema.Literals(["claude-code", "codex"])
export type Harness = typeof Harness.Type

/** The subscription a harness runs on: a person can connect both, and each project uses its harness's. */
export const providerOf = (harness: Harness): ModelProvider => (harness === "codex" ? "chatgpt" : "claude")

/** The harness a subscription runs. */
export const harnessOf = (provider: ModelProvider): Harness => (provider === "chatgpt" ? "codex" : "claude-code")

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
  /**
   * The model its top-level agent runs on, when they chose one other than Dream's default (`agentOf` in `Agent.ts`
   * resolves either). Only the project's own record carries it (`GetProject`, the live snapshot); Home's rows leave
   * it out. Added November 2026.
   */
  agentModel: Schema.optionalKey(Schema.NonEmptyString),
  /** Its top-level agent's reasoning effort, when they chose one other than Dream's default. Added November 2026. */
  agentEffort: Schema.optionalKey(ReasoningEffort),
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

/**
 * Whether the agent is up, as the ProjectDO sees it.
 * - `starting`: events are waiting and the ProjectDO is creating or resuming the sandbox to deliver them.
 * - `working`: a turn is running.
 * - `idle`: neither. The sandbox stays awake until `awakeUntil`, then sleeps until something wakes it.
 *
 * New states may be added; the phone treats one it doesn't know as if `activity` were absent.
 */
export const AgentState = Schema.Literals(["idle", "starting", "working"])
export type AgentState = typeof AgentState.Type

/**
 * What the presence dot and state line (Home, a project's header) and the row at the bottom of Chat show. Being
 * paused for usage is `pausedUntil`, and waiting for them is an open ask; neither is a state here.
 */
/** The most characters a progress line may have. dreamd also checks how wide it would be on the phone. */
export const ProgressLineMaxLength = 60

/** One line in the agent's voice saying what it's doing right now ("Making the slip detector stricter"). */
export const ProgressText = Schema.NonEmptyString.check(Schema.isMaxLength(ProgressLineMaxLength))

/**
 * What a long turn is doing, so it shows real progress without a message. dreamd derives it from the turn's
 * harness events (no model) and reports it while someone is watching: a new line at most once a minute, when the
 * work has moved on, and the liveness fields every couple of minutes.
 */
export const TurnProgress = Schema.Struct({
  /** What the agent is doing, once dreamd has something to say. */
  line: Schema.optionalKey(ProgressText),
  /** When the harness last did anything: proof the turn is alive. */
  activeAt: Schema.DateTimeUtc,
  /** Set while one long step (a command, a build, a helper) runs with nothing else happening: since when. */
  waitingSince: Schema.optionalKey(Schema.DateTimeUtc),
  /** When dreamd reported this. */
  at: Schema.DateTimeUtc
})
export type TurnProgress = typeof TurnProgress.Type

export const AgentActivity = Schema.Struct({
  state: AgentState,
  /**
   * When `state` began: when the ProjectDO started bringing the sandbox up (`starting`), when the turn started
   * (`working`), when the last turn ended (`idle`; absent before the first turn).
   */
  since: Schema.optionalKey(Schema.DateTimeUtc),
  /** `idle` only: when the sandbox goes to sleep, a few minutes after the last turn. Past or absent: asleep. */
  awakeUntil: Schema.optionalKey(Schema.DateTimeUtc),
  /** The next scheduled wake (`dream wake`), if there is one. */
  nextWakeAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** `working` only: what the turn is doing, once dreamd has reported it. Absent from older APIs. */
  progress: Schema.optionalKey(TurnProgress)
})
export type AgentActivity = typeof AgentActivity.Type

/** A row on Home. Derived from D1; cheap to list. */
export const ProjectSummary = Schema.Struct({
  project: Project,
  /** Open questions and access requests that need them now. */
  openAsks: Schema.Int,
  /** Milestone progress for the row's progress bar, when the agent has milestones. */
  progress: Schema.optionalKey(Schema.Struct({ done: Schema.Int, total: Schema.Int })),
  /** Set while the project waits for a usage window to reset. */
  pausedUntil: Schema.optionalKey(Schema.DateTimeUtc),
  /** As `StatusCard.pausedBy`: a limit they set holds it. Added November 2026. */
  pausedBy: Schema.optionalKey(UsageLimitReached),
  /** Whether the agent is up, and its next wake. Absent from older APIs. */
  activity: Schema.optionalKey(AgentActivity)
})
export type ProjectSummary = typeof ProjectSummary.Type

/**
 * A project they archived (`ArchiveProject`): off Home and out of the needs-you deck, its agent stopped and its
 * sandbox paused with everything in it, until they restore it (`RestoreProject`) as it was.
 */
export const ArchivedProject = Schema.Struct({
  project: Project,
  archivedAt: Schema.DateTimeUtc
})
export type ArchivedProject = typeof ArchivedProject.Type
