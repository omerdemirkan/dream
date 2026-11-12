/**
 * Moving a project to another of their plans (`SwitchPlan`): a rare thing, so it lives on the usage sheet's Adjust
 * page (and beside Adjust when the plan it's on runs low and the other has room). The sheet says so while a move
 * waits or after one didn't work, and Chat has one line where it happened, drawn like the day dividers.
 */
import type { ModelProvider, PlanSwitch, Project } from "@dream/domain"
import { providerOf } from "@dream/domain"
import { DateTime } from "effect"
import { providerName } from "./format.ts"

/** How long a move that didn't work is mentioned in the sheet. */
const FailedShownFor = { hours: 24 }

export interface PlanLine {
  /** Where the move stands. */
  readonly text: string
  /** What they can do about it: try `to` again (or, while a move waits, stay with the plan it's on). */
  readonly action?: PlanAction
}

export interface PlanAction {
  readonly label: string
  readonly to: ModelProvider
  readonly confirm?: PlanConfirm
}

/** The question asked before a move: it's a real change, though nothing in the project is lost. */
export interface PlanConfirm {
  readonly title: string
  readonly body: string
  readonly button: string
}

export const confirmMove = (to: ModelProvider): PlanConfirm => ({
  title: `Move to your ${providerName(to)} plan?`,
  body:
    `The agent hands its work to one on ${providerName(to)}, which picks up where it left off. The project, its ` +
    "apps and its schedules stay as they are.",
  button: "Move"
})

/** A move to `to`, asking first. */
export const moveAction = (to: ModelProvider): PlanAction => ({
  label: `Move to ${providerName(to)}`,
  to,
  confirm: confirmMove(to)
})

/**
 * What the sheet says about a move: one waiting for the agent's handoff (they can stay), or one that didn't work
 * in the last day (they can try again, while that plan is still connected). Nothing otherwise.
 */
export const planNotice = (
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
  const failedLately =
    move?.state === "failed" &&
    move.to !== current &&
    move.endedAt !== undefined &&
    DateTime.isGreaterThan(DateTime.add(move.endedAt, FailedShownFor), now)
  if (!failedLately) return undefined
  return {
    text: `The move to ${providerName(move.to)} didn’t work, so it stays on ${providerName(current)}.`,
    ...(connected.includes(move.to) ? { action: { ...moveAction(move.to), label: "Try again" } } : {})
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
