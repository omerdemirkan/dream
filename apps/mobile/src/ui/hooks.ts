/**
 * Hooks shared by the screens: reading a project and its messages with held
 * answers folded in, opening the expanded view, and the current time.
 */
import type { AskMessage, Message, MessageId, ProjectId } from "@dream/domain"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { DateTime, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type RefObject, useCallback, useEffect, useState } from "react"
import type { HostInstance } from "react-native"
import type { AnswerInput } from "../data/Answers.ts"
import type { ProjectState } from "../data/projectState.ts"
import { openAsksAtom, pendingAnswersAtom, projectAtom } from "../state/atoms.ts"
import { focusAtom } from "../state/ui.ts"

const nowUtc = () => DateTime.nowUnsafe()

/** The current time, ticking every `everyMs`. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(nowUtc)
  useEffect(() => {
    const id = setInterval(() => setNow(nowUtc()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now
}

export function usePendingAnswers(): ReadonlyMap<MessageId, AnswerInput> {
  const result = useAtomValue(pendingAnswersAtom)
  return Option.getOrElse(AsyncResult.value(result), () => new Map<MessageId, AnswerInput>())
}

/** A question with an answer held for Undo reads as answered. */
export const withPending = <M extends Message>(message: M, pending: ReadonlyMap<MessageId, AnswerInput>): M => {
  if (message._tag !== "Question") return message
  const held = pending.get(message.id)
  if (!held || message.state._tag !== "Open") return message
  return { ...message, state: { _tag: "Answered", answer: held.answer, answeredAt: nowUtc() } }
}

export function useProject(projectId: ProjectId): ProjectState | undefined {
  const result = useAtomValue(projectAtom(projectId))
  return Option.getOrUndefined(Option.flatten(AsyncResult.value(result)))
}

/** One message, from the open project, else Home's open asks, else what the opener passed along. */
export function useMessage(projectId: ProjectId, messageId: MessageId, fallback?: AskMessage): Message | undefined {
  const project = useProject(projectId)
  const asks = useAtomValue(openAsksAtom)
  const pending = usePendingAnswers()
  const fromProject = project?.messages.find((m) => m.id === messageId)
  const fromAsks = Option.getOrUndefined(AsyncResult.value(asks))?.find((a) => a.message.id === messageId)?.message
  const message = fromProject ?? fromAsks ?? fallback
  return message ? withPending(message, pending) : undefined
}

export interface OpenMessage {
  readonly projectId: ProjectId
  readonly messageId: MessageId
  readonly message?: AskMessage | undefined
  /** The card it grows out of. */
  readonly from?: RefObject<HostInstance | null> | undefined
}

/** Expands a question or access request to full screen. */
export function useOpenMessage() {
  const setFocus = useAtomSet(focusAtom)
  return useCallback(
    (open: OpenMessage) => {
      const node = open.from?.current
      const focus = (origin: { x: number; y: number; width: number; height: number } | undefined) =>
        setFocus(
          Option.some({ projectId: open.projectId, messageId: open.messageId, origin, message: open.message })
        )
      if (node) node.measureInWindow((x, y, width, height) => focus(width > 0 ? { x, y, width, height } : undefined))
      else focus(undefined)
    },
    [setFocus]
  )
}
