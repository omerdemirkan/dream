/**
 * Hooks shared by the screens: reading a project and its messages with held
 * answers folded in, opening the expanded view, and the current time.
 */
import {
  type ArchivedProject,
  type AskMessage,
  type Harness,
  type ModelProvider,
  type ProjectSummary,
  type Message,
  type MessageId,
  type ProjectId,
  RequestId
} from "@dream/domain"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { DateTime, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type RefObject, useCallback, useEffect, useRef, useState } from "react"
import type { HostInstance } from "react-native"
import type { ProjectState } from "../data/projectState.ts"
import { connectedPlans, planMissing } from "../data/plans.ts"
import { randomUuid } from "../data/Session.ts"
import { archivedProjectsAtom, modelConnectionsAtom, projectAtom, projectsAtom } from "../state/atoms.ts"
import { askPushAtom, focusAtom } from "../state/ui.ts"

const nowUtc = () => DateTime.nowUnsafe()

/** The current time, ticking every `everyMs`. */
/** The plans that work now (none until they've loaded). */
export function useConnectedPlans(): ReadonlyArray<ModelProvider> {
  const connections = Option.getOrUndefined(AsyncResult.value(useAtomValue(modelConnectionsAtom)))
  return connections === undefined ? [] : connectedPlans(connections)
}

/** Whether a project on `harness` waits because its plan isn't connected. */
export function usePlanMissing(harness: Harness | undefined): boolean {
  const connections = Option.getOrUndefined(AsyncResult.value(useAtomValue(modelConnectionsAtom)))
  return harness !== undefined && planMissing(connections, harness)
}

export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(nowUtc)
  useEffect(() => {
    const id = setInterval(() => setNow(nowUtc()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now
}

export function useProject(projectId: ProjectId): ProjectState | undefined {
  const result = useAtomValue(projectAtom(projectId))
  return Option.getOrUndefined(Option.flatten(AsyncResult.value(result)))
}

/** One message, from the open project, else what the opener passed along. */
export function useMessage(projectId: ProjectId, messageId: MessageId, fallback?: AskMessage): Message | undefined {
  const project = useProject(projectId)
  return project?.messages.find((m) => m.id === messageId) ?? fallback
}

export interface OpenMessage {
  readonly projectId: ProjectId
  readonly messageId: MessageId
  readonly message?: AskMessage | undefined
  /** The card it grows out of. */
  readonly from?: RefObject<HostInstance | null> | undefined
}

/** A moment that calls for asking to send notifications, such as their first answer. */
export function useAskPush() {
  const set = useAtomSet(askPushAtom)
  return useCallback(() => set((n) => n + 1), [set])
}

/** Expands a question or access request to full screen. */
export function useOpenMessage() {
  const setFocus = useAtomSet(focusAtom)
  return useCallback(
    (open: OpenMessage) => {
      const node = open.from?.current
      const focus = (origin: { x: number; y: number; width: number; height: number } | undefined) =>
        setFocus(Option.some({ projectId: open.projectId, messageId: open.messageId, origin, message: open.message }))
      if (node) node.measureInWindow((x, y, width, height) => focus(width > 0 ? { x, y, width, height } : undefined))
      else focus(undefined)
    },
    [setFocus]
  )
}

/**
 * A request id for a write they may retry: the same id for as long as they
 * retry the same thing (`key`, e.g. the text), a new one once it went through
 * (`done`) or they changed it. The API uses it so a retry can't post twice.
 */
export function useRequestId() {
  const current = useRef<{ readonly key: string; readonly id: RequestId } | undefined>(undefined)
  return {
    /** Sending `key` uses `id`, e.g. the id a kept draft was first sent with. */
    adopt: (key: string, id: RequestId) => {
      current.current = { key, id }
    },
    for: (key: string): RequestId => {
      if (current.current?.key !== key) current.current = { key, id: RequestId.make(randomUuid()) }
      return current.current.id
    },
    done: () => {
      current.current = undefined
    }
  }
}

/** For pages that name projects (Settings' services): a project's title, archived ones included. */
export function useProjectTitle() {
  const projects = Option.getOrElse(
    AsyncResult.value(useAtomValue(projectsAtom)),
    (): ReadonlyArray<ProjectSummary> => []
  )
  const archived = Option.getOrElse(
    AsyncResult.value(useAtomValue(archivedProjectsAtom)),
    (): ReadonlyArray<ArchivedProject> => []
  )
  return (id: ProjectId) =>
    (projects.find((summary) => summary.project.id === id) ?? archived.find((row) => row.project.id === id))?.project
      .title
}
