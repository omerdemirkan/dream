/**
 * A project as the phone holds it while it's open: folded from the
 * `ProjectLiveRpcs.Subscribe` stream (snapshot, then changes) plus any earlier
 * Chat history loaded with `ListMessages`.
 */
import type { AgentActivity, Message, MessageId, Project, ProjectEvent, StatusCard } from "@dream/domain"
import { DateTime, Order } from "effect"

export interface ProjectState {
  readonly project: Project
  readonly status: StatusCard
  /** Oldest first, deduplicated by id. */
  readonly messages: ReadonlyArray<Message>
  readonly hasEarlierMessages: boolean
  readonly working: boolean
  /** Starting, working or idle, and the next wake; absent from APIs that predate it (then only `working` is known). */
  readonly activity?: AgentActivity | undefined
}

const byCreatedAt = Order.mapInput(DateTime.Order, (message: Message) => message.createdAt)

const sortMessages = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> => {
  const unique = new Map<MessageId, Message>()
  for (const message of messages) unique.set(message.id, message)
  return Array.from(unique.values()).sort(byCreatedAt)
}

const upsert = (messages: ReadonlyArray<Message>, message: Message): ReadonlyArray<Message> =>
  messages.some((m) => m.id === message.id)
    ? messages.map((m) => (m.id === message.id ? message : m))
    : sortMessages([...messages, message])

/**
 * Applies one live event. A `Snapshot` replaces the state (it starts every
 * subscription, including after a reconnect) but keeps earlier history the
 * snapshot doesn't reach back to.
 */
export const applyEvent = (state: ProjectState | undefined, event: ProjectEvent): ProjectState | undefined => {
  if (event._tag === "Snapshot") {
    const oldest = event.messages[0]
    const earlier =
      state && oldest
        ? state.messages.filter((m) => DateTime.isLessThan(m.createdAt, oldest.createdAt))
        : (state?.messages ?? [])
    const keepsEarlier = earlier.length > 0 && event.hasEarlierMessages
    return {
      project: event.project,
      status: event.status,
      messages: sortMessages(keepsEarlier ? [...earlier, ...event.messages] : event.messages),
      hasEarlierMessages: keepsEarlier ? (state?.hasEarlierMessages ?? true) : event.hasEarlierMessages,
      working: event.working,
      activity: event.activity
    }
  }
  if (state === undefined) return undefined
  switch (event._tag) {
    case "ProjectChanged":
      return { ...state, project: event.project }
    case "StatusChanged":
      return { ...state, status: event.status }
    case "MessageAdded":
    case "MessageChanged":
      return { ...state, messages: upsert(state.messages, event.message) }
    case "WorkingChanged":
      return { ...state, working: event.working }
    case "ActivityChanged":
      return { ...state, activity: event.activity, working: event.activity.state === "working" }
  }
}

/** Adds a page of earlier history from `ListMessages` (which arrives newest first). */
export const addEarlier = (
  state: ProjectState,
  page: { readonly messages: ReadonlyArray<Message>; readonly hasEarlier: boolean }
): ProjectState => ({
  ...state,
  messages: sortMessages([...page.messages, ...state.messages]),
  hasEarlierMessages: page.hasEarlier
})

/** Replaces one message with a newer copy, e.g. the result of answering it. */
export const replaceMessage = (state: ProjectState, message: Message): ProjectState => ({
  ...state,
  messages: upsert(state.messages, message)
})
