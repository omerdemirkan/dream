/**
 * Chat's half of clearing seen notifications (`data/seenMessages.ts`): what is on screen, whether Dream and this
 * project are in front, and the clock.
 */
import type { Message, MessageId } from "@dream/domain"
import { Effect } from "effect"
import { useFocusEffect } from "expo-router"
import { type RefObject, useCallback, useEffect, useRef } from "react"
import { AppState } from "react-native"
import { emptySeen, notifiable, stepSeen, visibleIds } from "../data/seenMessages.ts"
import * as Push from "../platform/push.ts"

/** Returns `check`, for Chat to call whenever what's on screen may have changed (scroll, layout). */
export function useClearSeen(props: {
  readonly messages: ReadonlyArray<Message>
  readonly positions: RefObject<ReadonlyMap<MessageId, { readonly y: number; readonly height: number }>>
  /** The visible part of the content, in its coordinates. */
  readonly window: () => { readonly top: number; readonly bottom: number }
}) {
  const state = useRef(emptySeen)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const focused = useRef(false)
  const latest = useRef(props)
  latest.current = props

  const check = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    const { messages, positions, window } = latest.current
    const inFront = focused.current && AppState.currentState === "active"
    const candidates = new Set(messages.filter(notifiable).map((m) => m.id))
    const visible = inFront ? visibleIds(positions.current, window()).filter((id) => candidates.has(id)) : []
    const step = stepSeen(state.current, visible, Date.now())
    state.current = step.state
    if (step.flush.length > 0) void Effect.runPromise(Push.removeDeliveredFor(step.flush).pipe(Effect.ignore))
    if (step.wakeIn !== undefined) timer.current = setTimeout(check, step.wakeIn)
  }, [])

  useFocusEffect(
    useCallback(() => {
      focused.current = true
      check()
      return () => {
        focused.current = false
        check()
      }
    }, [check])
  )

  useEffect(() => {
    const subscription = AppState.addEventListener("change", check)
    return () => {
      subscription.remove()
      if (timer.current !== undefined) clearTimeout(timer.current)
      // Seen, but the batch hadn't gone out yet.
      const pending = state.current.pending
      if (pending.length > 0) void Effect.runPromise(Push.removeDeliveredFor(pending).pipe(Effect.ignore))
    }
  }, [check])

  return check
}
