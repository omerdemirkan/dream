/**
 * Messages they have seen in Chat, so the notifications about them can leave Notification Center: a message counts
 * once it has been mostly on screen for a moment, while Dream is in front on its project. Seen ids go out in
 * batches, each id once, so scrolling through Chat costs a native call every so often rather than one per frame.
 */
import type { Message, MessageId, PushData } from "@dream/domain"
import { Option } from "effect"

/** How much of a message (or of the visible area, for one taller than it) has to be on screen. */
export const visibleShare = 0.6
/** How long it has to stay there. */
export const dwellMs = 700
/** How long seen ids wait for others before they go out together. */
export const batchMs = 400

/** Only Dream's messages are ever notified about; theirs never are. */
export const notifiable = (message: Message): boolean => !(message._tag === "Text" && message.from === "user")

/** Ids of the rows mostly inside `[top, bottom]`, all in the same coordinates. */
export const visibleIds = (
  rows: Iterable<readonly [MessageId, { readonly y: number; readonly height: number }]>,
  window: { readonly top: number; readonly bottom: number }
): Array<MessageId> => {
  const span = window.bottom - window.top
  if (span <= 0) return []
  const ids: Array<MessageId> = []
  for (const [id, { y, height }] of rows) {
    if (height <= 0) continue
    const shown = Math.min(y + height, window.bottom) - Math.max(y, window.top)
    if (shown > 0 && shown >= visibleShare * Math.min(height, span)) ids.push(id)
  }
  return ids
}

export interface SeenState {
  /** On screen without a break since. */
  readonly since: ReadonlyMap<MessageId, number>
  /** Counted already, so never sent again. */
  readonly seen: ReadonlySet<MessageId>
  /** Counted, waiting for the batch to go out. */
  readonly pending: ReadonlyArray<MessageId>
  readonly pendingSince: number | undefined
}

export const emptySeen: SeenState = { since: new Map(), seen: new Set(), pending: [], pendingSince: undefined }

/**
 * Advances the state to `now`, with `visible` the ids on screen now (none while Dream is in the background or
 * another screen is in front). Returns the batch to remove, if one is due, and when to call again if something is
 * still waiting on the clock.
 */
export const stepSeen = (
  state: SeenState,
  visible: ReadonlyArray<MessageId>,
  now: number
): { readonly state: SeenState; readonly flush: ReadonlyArray<MessageId>; readonly wakeIn: number | undefined } => {
  const since = new Map<MessageId, number>()
  const seen = new Set(state.seen)
  const pending = [...state.pending]
  let pendingSince = state.pendingSince
  for (const id of visible) {
    if (seen.has(id)) continue
    const from = state.since.get(id) ?? now
    if (now - from >= dwellMs) {
      seen.add(id)
      pending.push(id)
      pendingSince ??= now
    } else since.set(id, from)
  }
  const due = pendingSince !== undefined && now - pendingSince >= batchMs
  const waits = [
    ...[...since.values()].map((from) => from + dwellMs - now),
    ...(pendingSince !== undefined && !due ? [pendingSince + batchMs - now] : [])
  ]
  return {
    state: due ? { since, seen, pending: [], pendingSince: undefined } : { since, seen, pending, pendingSince },
    flush: due ? pending : [],
    wakeIn: waits.length > 0 ? Math.max(0, Math.min(...waits)) : undefined
  }
}

/** The delivered notifications (by identifier) that are about one of `messageIds`; the rest of the ids have none. */
export const notificationsAbout = (
  presented: ReadonlyArray<{ readonly identifier: string; readonly data: Option.Option<PushData> }>,
  messageIds: ReadonlyArray<MessageId>
): Array<string> =>
  presented
    .filter((n) =>
      Option.match(n.data, {
        onNone: () => false,
        onSome: (data) => data._tag === "OpenMessage" && messageIds.includes(data.messageId)
      })
    )
    .map((n) => n.identifier)
