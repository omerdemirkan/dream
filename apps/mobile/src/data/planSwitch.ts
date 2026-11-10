/**
 * Moving a project to another of their plans (`SwitchPlan`): a rare thing, so it's one quiet line under the agent in
 * the project's usage sheet, shown only to someone with more than one plan connected (or with a move under way),
 * and one line in Chat where it happened, drawn like the day dividers.
 */
import type { ModelProvider, PlanSwitch, Project } from "@dream/domain"
import { providerOf } from "@dream/domain"
import { DateTime } from "effect"
import { providerName } from "./format.ts"

/** How long a move that didn't work is mentioned under the agent. */
const FailedShownFor = { hours: 24 }

export interface PlanLine {
  /** Where the project stands. */
  readonly text: string
  /** What they can do about it: move to `to` (or, while a move waits, stay with the plan it's on). */
  readonly action?: { readonly label: string; readonly to: ModelProvider; readonly confirm?: PlanConfirm }
}

/** The question asked before a move: it's a real change, though nothing in the project is lost. */
export interface PlanConfirm {
  readonly title: string
  readonly body: string
  readonly button: string
}

const confirmMove = (to: ModelProvider): PlanConfirm => ({
  title: `Move to your ${providerName(to)} plan?`,
  body:
    `The agent hands its work to one on ${providerName(to)}, which picks up where it left off. The project, its ` +
    "apps and its schedules stay as they are.",
  button: "Move"
})

/**
 * The line under the agent: the plan it runs on, and a move to another of theirs. `connected` is the plans that work
 * now; with one, there's nothing to say unless a move is under way.
 */
export const planLine = (
  project: Pick<Project, "harness" | "planSwitch">,
  connected: ReadonlyArray<ModelProvider>,
  now: DateTime.Utc
): PlanLine | undefined => {
  const current = providerOf(project.harness)
  const move = project.planSwitch
  if (move?.state === "waiting") {
    return {
      text: `Moving to your ${providerName(move.to)} plan once the agent has handed over.`,
      action: { label: `Stay on ${providerName(current)}`, to: current }
    }
  }
  const other = connected.find((provider) => provider !== current)
  if (other === undefined) return undefined
  const failedLately =
    move?.state === "failed" &&
    move.to === other &&
    move.endedAt !== undefined &&
    DateTime.isGreaterThan(DateTime.add(move.endedAt, FailedShownFor), now)
  return failedLately
    ? {
        text: `The move to ${providerName(other)} didn’t work, so it stays on ${providerName(current)}.`,
        action: { label: "Try again", to: other, confirm: confirmMove(other) }
      }
    : {
        text: `Runs on your ${providerName(current)} plan.`,
        action: { label: `Move to ${providerName(other)}`, to: other, confirm: confirmMove(other) }
      }
}

/** The line Chat shows for the latest move: where it happened (`at`), or at the end while it waits. */
export interface ChatPlanLine {
  readonly label: string
  readonly at?: DateTime.Utc
}

export const chatPlanLine = (move: PlanSwitch | undefined): ChatPlanLine | undefined => {
  if (move === undefined) return undefined
  const to = providerName(move.to)
  switch (move.state) {
    case "waiting":
      return { label: `Moving to your ${to} plan` }
    case "done":
      return { label: `Moved to your ${to} plan`, at: move.endedAt ?? move.requestedAt }
    case "failed":
      return { label: `Couldn’t move to your ${to} plan`, at: move.endedAt ?? move.requestedAt }
  }
}
