/**
 * Chat: only what Dream chose to send, and what they send. Sparse by
 * design; long gaps are normal. One row at the bottom says whether the agent is
 * up (sent, starting, working, done for now), and a receipt under their latest
 * message says whether it has been seen.
 */
import type { AskMessage, Message, MessageId, WorkstreamId } from "@dream/domain"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  type HostInstance,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  Text,
  View
} from "react-native"
import { Gesture, GestureDetector } from "react-native-gesture-handler"
import { KeyboardChatScrollView } from "react-native-keyboard-controller"
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming
} from "react-native-reanimated"
import { scheduleOnRN } from "react-native-worklets"
import { dayLabel, sameDay, timeLabel } from "../data/format.ts"
import { chatRowOf, presenceOf, receiptOf } from "../data/presence.ts"
import type { ProjectState } from "../data/projectState.ts"
import { loadEarlierFn } from "../state/atoms.ts"
import { landingAtom, messageRects } from "../state/ui.ts"
import { nextOpenAsk } from "./asks.ts"
import { useClearSeen } from "./clearSeen.ts"
import { useNow, useOpenMessage } from "./hooks.ts"
import { isNotificationsCard, NotificationsCard } from "./AppNotifications.tsx"
import { AccessCard, AgentText, QuestionCard, UserBubble } from "./Messages.tsx"
import { Icon } from "./kit.tsx"
import { ChatActivityRow } from "./Presence.tsx"
import { color, gutter } from "./theme.ts"

/** The ring that flashes around a message Chat just landed on (`.msg.hl`). */
function Highlight(props: { readonly at: number; readonly need: boolean }) {
  const opacity = useSharedValue(0)
  useEffect(() => {
    if (props.at === 0) return
    opacity.value = 0
    opacity.value = withSequence(
      withTiming(0.85, { duration: 220, easing: Easing.out(Easing.ease) }),
      withTiming(0.5, { duration: 1210 }),
      withTiming(0, { duration: 770, easing: Easing.in(Easing.ease) })
    )
  }, [props.at, opacity])
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }))
  const ring = props.need ? "255,179,92" : "255,255,255"
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          inset: -3,
          borderRadius: 27,
          borderWidth: 3,
          borderColor: `rgba(${ring},1)`,
          boxShadow: `0 0 44px rgba(${ring},0.28)`
        },
        style
      ]}
    />
  )
}

function Divider(props: { readonly label: string; readonly first: boolean }) {
  return (
    <Text
      style={{
        alignSelf: "center",
        fontSize: 12.5,
        fontWeight: "500",
        color: color.t3,
        marginTop: props.first ? 2 : 16
      }}
    >
      {props.label}
    </Text>
  )
}

function AskRow(props: {
  readonly message: AskMessage
  readonly highlightAt: number
  readonly onAnswered: (messageId: MessageId) => void
}) {
  const ref = useRef<HostInstance>(null)
  const open = useOpenMessage()
  const m = props.message
  useEffect(() => {
    messageRects.set(
      m.id,
      () =>
        new Promise((resolve) => {
          const node = ref.current
          if (!node) return resolve(undefined)
          node.measureInWindow((x, y, width, height) => resolve(width > 0 ? { x, y, width, height } : undefined))
        })
    )
    return () => {
      messageRects.delete(m.id)
    }
  }, [m.id])
  const onOpen = () => open({ projectId: m.projectId, messageId: m.id, message: m, from: ref })
  const need = m.state._tag === "Open" && !(m._tag === "Access" && m.when !== undefined)
  return (
    <View>
      {m._tag === "Question" ? (
        <QuestionCard ref={ref} message={m} onOpen={onOpen} onAnswered={() => props.onAnswered(m.id)} />
      ) : isNotificationsCard(m) ? (
        <NotificationsCard ref={ref} message={m} onOpen={onOpen} />
      ) : (
        <AccessCard ref={ref} message={m} onOpen={onOpen} />
      )}
      <Highlight at={props.highlightAt} need={need} />
    </View>
  )
}

/** The workstream a message belongs to, small above it, while the card shows a row per workstream. */
function WorkstreamLabel(props: { readonly title: string; readonly mine: boolean }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        marginBottom: 5,
        alignSelf: props.mine ? "flex-end" : "flex-start"
      }}
    >
      <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: color.t3 }} />
      <Text numberOfLines={1} style={{ fontSize: 12.5, fontWeight: "600", letterSpacing: -0.06, color: color.t3 }}>
        {props.title}
      </Text>
    </View>
  )
}

/** How far a message slides before letting go of it writes to its workstream, as a reply does in Messages. */
const replyAt = 56

/** Swiping a labeled message to the right writes to its workstream. */
function ReplySwipe(props: { readonly onReply: () => void; readonly children: ReactNode }) {
  const x = useSharedValue(0)
  // The latest callback, so the gesture is made once.
  const reply = useRef(props.onReply)
  reply.current = props.onReply
  const pan = useMemo(() => {
    const fire = () => reply.current()
    return Gesture.Pan()
      .activeOffsetX(14)
      .failOffsetY([-12, 12])
      .onUpdate((e) => {
        x.value = Math.max(0, Math.min(replyAt + 16, e.translationX * 0.7))
      })
      .onEnd(() => {
        if (x.value >= replyAt) scheduleOnRN(fire)
        x.value = withTiming(0, { duration: 220 })
      })
  }, [x])
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))
  const hint = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [12, replyAt], [0, 1], "clamp"),
    transform: [{ scale: interpolate(x.value, [12, replyAt], [0.6, 1], "clamp") }]
  }))
  return (
    <GestureDetector gesture={pan}>
      <View>
        <Animated.View style={[{ position: "absolute", left: -2, top: 0, bottom: 0, justifyContent: "center" }, hint]}>
          <Icon name="reply" size={17} color={color.t2} weight="semibold" />
        </Animated.View>
        <Animated.View style={slide}>{props.children}</Animated.View>
      </View>
    </GestureDetector>
  )
}

/** The row at the bottom (A). It ticks every few seconds, so the typing dots give way on time, without redrawing Chat. */
function ChatActivity(props: { readonly state: ProjectState }) {
  const { state } = props
  const now = useNow(5000)
  const presence = presenceOf({
    activity: state.activity,
    working: state.working,
    pausedUntil: state.status.pausedUntil,
    now
  })
  const row = chatRowOf(presence, state.messages, now)
  return row ? <ChatActivityRow row={row} /> : null
}

export function ChatTab(props: {
  readonly state: ProjectState
  readonly topInset: number
  readonly bottomInset: number
  /** How much less than the keyboard's height the messages lift, as the composer does (`KeyboardStickyView`). */
  readonly keyboardOffset: number
  /** Told when they scroll back through history (`true`) and when they're back near the latest (`false`). */
  readonly onAway?: (away: boolean) => void
  /** Each workstream's title, while the card shows rows; then messages carry their workstream's label. */
  readonly labels?: ReadonlyMap<WorkstreamId, string> | undefined
  /** The workstream they're writing to: the other messages dim. */
  readonly scope?: WorkstreamId | undefined
  /** Swiping a labeled message writes to its workstream. */
  readonly onReply?: (workstream: WorkstreamId) => void
}) {
  const { state } = props
  const projectId = state.project.id
  const now = useNow()
  const landing = useAtomValue(landingAtom)
  const setLanding = useAtomSet(landingAtom)
  const loadEarlier = useAtomSet(loadEarlierFn)
  const scroll = useRef<ScrollViewInstance>(null)
  const positions = useRef(new Map<MessageId, { y: number; height: number }>())
  const viewport = useRef(0)
  const offset = useRef(0)
  const nearBottom = useRef(true)
  const away = useRef(false)
  const loadingEarlier = useRef(false)
  const [highlights, setHighlights] = useState<ReadonlyMap<MessageId, number>>(new Map())
  const landed = useRef(false)

  const target = Option.getOrUndefined(landing)
  const wanted = target && target.projectId === projectId ? target : undefined

  /** Scrolls so the message sits a little above the middle, as the mock does. */
  const scrollTo = useCallback((messageId: MessageId, animated: boolean) => {
    const at = positions.current.get(messageId)
    if (!at || !scroll.current) return false
    const offset = Math.max(170, (viewport.current - at.height) / 2.6)
    scroll.current.scrollTo({ y: Math.max(0, at.y - offset), animated })
    return true
  }, [])

  // Land on a message when asked to (from the expanded view, Status, Home or a notification).
  useEffect(() => {
    if (!wanted) return
    const done = scrollTo(wanted.messageId, false)
    if (!done) return
    landed.current = true
    if (wanted.highlight) {
      setHighlights((map) => new Map(map).set(wanted.messageId, Date.now()))
      setLanding(Option.none())
    }
  })

  // Answering a card inline moves on to the next open one below it, once the answered card has settled.
  const latest = useRef(state)
  latest.current = state
  const onAnswered = useCallback(
    (messageId: MessageId) => {
      setTimeout(() => {
        const next = nextOpenAsk(latest.current.messages, messageId, { wrap: false })
        if (next && scrollTo(next.id, true)) setHighlights((map) => new Map(map).set(next.id, Date.now()))
      }, 450)
    },
    [scrollTo]
  )

  // Notifications about messages they've now seen leave Notification Center. The Status card covers the top inset.
  const checkSeen = useClearSeen({
    messages: state.messages,
    positions,
    window: () => ({ top: offset.current + props.topInset, bottom: offset.current + viewport.current })
  })

  const onContentSizeChange = () => {
    checkSeen()
    if (wanted) return
    if (!landed.current || nearBottom.current) {
      scroll.current?.scrollToEnd({ animated: landed.current })
      landed.current = true
    }
  }

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const fromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height)
    offset.current = contentOffset.y
    checkSeen()
    nearBottom.current = fromBottom < 160
    // Some slack each way, so the Status card doesn't flicker between sizes around one point.
    const isAway = away.current ? fromBottom > 90 : fromBottom > 300
    if (isAway !== away.current) {
      away.current = isAway
      props.onAway?.(isAway)
    }
    if (contentOffset.y < 200 && state.hasEarlierMessages && !loadingEarlier.current) {
      loadingEarlier.current = true
      loadEarlier(projectId)
      setTimeout(() => (loadingEarlier.current = false), 1500)
    }
  }

  const receipt = receiptOf(state.messages, state.activity)

  const rows: Array<ReactNode> = []
  let previous: Message | undefined
  for (const message of state.messages) {
    if (!previous || !sameDay(previous.createdAt, message.createdAt)) {
      rows.push(<Divider key={`d-${message.id}`} label={dayLabel(message.createdAt, now)} first={!previous} />)
    }
    previous = message
    const time = sameDay(message.createdAt, now) ? timeLabel(message.createdAt) : undefined
    const highlightAt = highlights.get(message.id) ?? 0
    const workstream = message.workstream
    const label = workstream === undefined ? undefined : props.labels?.get(workstream)
    const mine = message._tag === "Text" && message.from === "user"
    const body = (
      <>
        {label === undefined ? null : <WorkstreamLabel title={label} mine={mine} />}
        {message._tag === "Text" ? (
          message.from === "user" ? (
            <UserBubble
              message={message}
              time={time}
              receipt={receipt?.messageId === message.id ? { seen: receipt.seen } : undefined}
            />
          ) : (
            <AgentText message={message} time={time} />
          )
        ) : (
          <AskRow message={message} highlightAt={highlightAt} onAnswered={onAnswered} />
        )}
      </>
    )
    const onReply = props.onReply
    rows.push(
      <View
        key={message.id}
        onLayout={(e) => {
          positions.current.set(message.id, { y: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height })
          checkSeen()
        }}
        style={props.scope !== undefined && workstream !== props.scope ? { opacity: 0.32 } : undefined}
      >
        {label !== undefined && workstream !== undefined && onReply ? (
          <ReplySwipe onReply={() => onReply(workstream)}>{body}</ReplySwipe>
        ) : (
          body
        )}
      </View>
    )
  }

  return (
    // Lifts the messages with the keyboard, frame by frame, and follows an interactive dismiss.
    <KeyboardChatScrollView
      ref={scroll}
      offset={props.keyboardOffset}
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: gutter,
        gap: 14
      }}
      onLayout={(e) => {
        viewport.current = e.nativeEvent.layout.height
        checkSeen()
      }}
      onContentSizeChange={onContentSizeChange}
      onScroll={onScroll}
      scrollEventThrottle={64}
      maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {state.hasEarlierMessages ? (
        <Text style={{ alignSelf: "center", fontSize: 12.5, color: color.t3 }}>Loading earlier messages…</Text>
      ) : null}
      {rows}
      <ChatActivity state={state} />
    </KeyboardChatScrollView>
  )
}
