/**
 * Chat: only what Dream chose to send, and what they send. Sparse by
 * design; long gaps are normal. One row at the bottom says whether the agent is
 * up (sent, starting, working, done for now), and a receipt under their latest
 * message says whether it has been seen.
 */
import type { AskMessage, Message, MessageId, WorkstreamId } from "@dream/domain"
import * as Haptics from "expo-haptics"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { DateTime, Option } from "effect"
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  type HostInstance,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
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
import { chatPlanLine } from "../data/planSwitch.ts"
import { chatRowOf, presenceOf, receiptOf } from "../data/presence.ts"
import { chatItems, foldLine, senderName, type ThreadSummary, topLevel } from "../data/threads.ts"
import type { ProjectState } from "../data/projectState.ts"
import { loadEarlierFn } from "../state/atoms.ts"
import { heldAtom, holdRequestAtom, landingAtom, messageRects, threadOpenAtom } from "../state/ui.ts"
import { nextOpenAsk } from "./asks.ts"
import { useClearSeen } from "./clearSeen.ts"
import { useNow, useOpenMessage, usePlanMissing } from "./hooks.ts"
import { isNotificationsCard, NotificationsCard } from "./AppNotifications.tsx"
import { AccessCard, AgentText, QuestionCard, UserBubble } from "./Messages.tsx"
import { Icon } from "./kit.tsx"
import { threadExcerpt } from "@dream/domain"
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

export function AskRow(props: {
  readonly message: AskMessage
  readonly highlightAt: number
  readonly onAnswered: (messageId: MessageId) => void
}) {
  const ref = useRef<HostInstance>(null)
  const open = useOpenMessage()
  const m = props.message
  useEffect(
    () =>
      messageRects.set(
        m.id,
        () =>
          new Promise((resolve) => {
            const node = ref.current
            if (!node) return resolve(undefined)
            node.measureInWindow((x, y, width, height) => resolve(width > 0 ? { x, y, width, height } : undefined))
          })
      ),
    [m.id]
  )
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

/** How far a message slides before letting go of it opens its thread, as a reply does in Messages. */
const replyAt = 56

/**
 * A message in Chat or a thread: holding it lifts it with its menu (`HoldMenu`), and swiping it to the right opens its
 * thread to reply, as in Messages. Holding cancels the tap underneath, so a card doesn't also open.
 */
export function Holdable(props: {
  readonly message: Message
  /** Swiping right replies (Chat); a thread's own messages don't swipe. */
  readonly onReply?: (() => void) | undefined
  readonly children: ReactNode
}) {
  const x = useSharedValue(0)
  const setHeld = useAtomSet(heldAtom)
  const box = useRef<HostInstance>(null)
  // The latest callbacks and message, so the gestures are made once.
  const latest = useRef(props)
  latest.current = props
  const gesture = useMemo(() => {
    const reply = () => latest.current.onReply?.()
    const hold = () => {
      const node = box.current
      if (!node) return
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      node.measureInWindow((left, top, width, height) =>
        setHeld(
          Option.some({
            message: latest.current.message,
            rect: { x: left, y: top, width, height }
          })
        )
      )
    }
    const press = Gesture.LongPress()
      .minDuration(380)
      .maxDistance(12)
      .onStart(() => {
        scheduleOnRN(hold)
      })
    if (!props.onReply) return press
    const pan = Gesture.Pan()
      .activeOffsetX(14)
      .failOffsetY([-12, 12])
      .onUpdate((e) => {
        x.value = Math.max(0, Math.min(replyAt + 16, e.translationX * 0.7))
      })
      .onEnd(() => {
        if (x.value >= replyAt) scheduleOnRN(reply)
        x.value = withTiming(0, { duration: 220 })
      })
    return Gesture.Race(press, pan)
  }, [x, setHeld, props.onReply === undefined])
  // `?hold=<messageId>`: held as if pressed, once it's laid out.
  const request = useAtomValue(holdRequestAtom)
  const setRequest = useAtomSet(holdRequestAtom)
  useEffect(() => {
    if (!Option.contains(request, props.message.id)) return
    const timer = setTimeout(() => {
      setRequest(Option.none())
      const node = box.current
      node?.measureInWindow((left, top, width, height) =>
        setHeld(Option.some({ message: props.message, rect: { x: left, y: top, width, height } }))
      )
    }, 900)
    return () => clearTimeout(timer)
  }, [request, props.message, setRequest, setHeld])
  const slide = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))
  const hint = useAnimatedStyle(() => ({
    opacity: interpolate(x.value, [12, replyAt], [0, 1], "clamp"),
    transform: [{ scale: interpolate(x.value, [12, replyAt], [0.6, 1], "clamp") }]
  }))
  return (
    <GestureDetector gesture={gesture}>
      <View ref={box} collapsable={false}>
        {props.onReply ? (
          <Animated.View
            style={[{ position: "absolute", left: -2, top: 0, bottom: 0, justifyContent: "center" }, hint]}
          >
            <Icon name="reply" size={17} color={color.t2} weight="semibold" />
          </Animated.View>
        ) : null}
        <Animated.View style={slide}>{props.children}</Animated.View>
      </View>
    </GestureDetector>
  )
}

/**
 * The little curve from the agent's message down to its thread's line. It starts at the message's bottom edge and
 * far enough in to clear a card's rounded corner, and ends level with the middle of the line.
 */
function Curve() {
  return (
    <View
      style={{
        width: 14,
        height: 26,
        marginLeft: 18,
        borderColor: color.line2,
        borderBottomWidth: 1.5,
        borderLeftWidth: 1.5,
        borderBottomLeftRadius: 10
      }}
    />
  )
}

/** A thread folded into one line under its message: how many replies, and the latest. Tapping opens it. */
export function ThreadFold(props: {
  readonly summary: ThreadSummary
  readonly mine: boolean
  readonly waiting: boolean
  readonly onPress: () => void
}) {
  const line = foldLine(props.summary)
  return (
    <View
      style={{
        flexDirection: props.mine ? "row-reverse" : "row",
        alignItems: "flex-start",
        gap: 8,
        marginTop: 2
      }}
    >
      {props.mine ? null : <Curve />}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${line.count}. ${line.latest}`}
        accessibilityHint="Opens the thread"
        onPress={props.onPress}
        hitSlop={6}
        style={({ pressed }) => ({
          flexShrink: 1,
          maxWidth: "88%",
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          // About 10pt clear of the message above, so the line reads as under it rather than stuck to it.
          marginTop: 8,
          paddingVertical: 7,
          paddingLeft: 8,
          paddingRight: 12,
          borderRadius: 16,
          backgroundColor: pressed ? color.s2 : color.s1,
          borderWidth: 1,
          borderColor: props.waiting ? color.needLine : color.line
        })}
      >
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            backgroundColor: color.s3,
            alignItems: "center",
            justifyContent: "center"
          }}
        >
          <Icon name="reply" size={10} color={color.t1} weight="bold" />
        </View>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13.5, color: color.t2 }}>
          <Text style={{ color: color.t1, fontWeight: "600" }}>{line.count}</Text>
          {` · ${line.latest}`}
        </Text>
      </Pressable>
    </View>
  )
}

/** The agent's reply in a thread, where it falls in Chat, so it isn't missed folded far up. Tapping opens the thread. */
function ReplyEcho(props: {
  readonly reply: Message
  readonly root: Message | undefined
  readonly onPress: () => void
}) {
  const about = props.root === undefined ? "an earlier message" : `“${threadExcerpt(props.root, 60)}”`
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens the thread"
      onPress={props.onPress}
      style={({ pressed }) => ({
        alignSelf: "flex-start",
        maxWidth: "94%",
        paddingVertical: 10,
        paddingHorizontal: 13,
        borderRadius: 18,
        backgroundColor: pressed ? color.s2 : color.s1,
        borderWidth: 1,
        borderColor: color.line
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon name="reply" size={11} color={color.t3} weight="semibold" />
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12.5, fontWeight: "600", color: color.t3 }}>
          {`${senderName(props.reply)} replied to ${about}`}
        </Text>
      </View>
      <Text numberOfLines={3} style={{ fontSize: 15.5, lineHeight: 21.5, color: color.t1, marginTop: 4 }}>
        {threadExcerpt(props.reply, 400)}
      </Text>
    </Pressable>
  )
}

/** One message as Chat and a thread show it: their bubble, the agent's text, or a card. */
export function MessageBody(props: {
  readonly message: Message
  readonly time: string | undefined
  readonly receipt?: { readonly seen: boolean } | undefined
  readonly highlightAt?: number
  readonly onAnswered?: (messageId: MessageId) => void
}) {
  const message = props.message
  if (message._tag === "Text") {
    return message.from === "user" ? (
      <UserBubble message={message} time={props.time} receipt={props.receipt} />
    ) : (
      <AgentText message={message} time={props.time} />
    )
  }
  return <AskRow message={message} highlightAt={props.highlightAt ?? 0} onAnswered={props.onAnswered ?? (() => {})} />
}

/** The row at the bottom (A). It ticks every few seconds, so the typing dots give way on time, without redrawing Chat. */
export function ChatActivity(props: { readonly state: ProjectState }) {
  const { state } = props
  const now = useNow(5000)
  const missing = usePlanMissing(state.project.harness)
  const presence = presenceOf({
    activity: state.activity,
    working: state.working,
    pausedUntil: state.status.pausedUntil,
    planMissing: missing,
    pausedBy: state.status.pausedBy,
    now
  })
  const row = chatRowOf(presence, state.messages, now, state.status.now)
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

  const setThread = useAtomSet(threadOpenAtom)
  const openThread = useCallback(
    (messageId: MessageId, highlight?: MessageId) =>
      setThread(Option.some({ projectId, messageId, ...(highlight === undefined ? {} : { highlight }) })),
    [projectId, setThread]
  )

  const target = Option.getOrUndefined(landing)
  const wanted = target && target.projectId === projectId ? target : undefined
  // A reply lives in its thread, not in Chat: landing on one (from a notification) opens the thread at it.
  const wantedReply = wanted ? state.messages.find((m) => m.id === wanted.messageId)?.replyTo : undefined
  useEffect(() => {
    if (!wanted || wantedReply === undefined) return
    setLanding(Option.none())
    openThread(wantedReply, wanted.messageId)
  }, [wanted, wantedReply, setLanding, openThread])

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
    if (!wanted || wantedReply !== undefined) return
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

  const onContentSizeChange = (_: number, height: number) => {
    checkSeen()
    // Messages that don't fill the screen can't be scrolled back through, so the earlier ones load now. Replies fold
    // into their threads, so a page of messages can make a short Chat.
    if (viewport.current > 0 && height < viewport.current && state.hasEarlierMessages && !loadingEarlier.current) {
      loadingEarlier.current = true
      loadEarlier(projectId)
      setTimeout(() => (loadingEarlier.current = false), 1500)
    }
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

  // Their latest message in Chat itself carries the receipt; one in a thread carries it there.
  const receipt = receiptOf(topLevel(state.messages), state.activity)
  const waiting = (m: Message) => m._tag !== "Text" && m.state._tag === "Open"

  const rows: Array<ReactNode> = []
  // The project's latest move to another plan, where it happened, or at the end while it waits.
  const planLine = chatPlanLine(state.project.planSwitch)
  let planLineShown = false
  const showPlanLine = (key: string) => {
    if (planLine === undefined || planLineShown) return
    planLineShown = true
    rows.push(<Divider key={key} label={planLine.label} first={rows.length === 0} />)
  }
  let previous: Message | undefined
  for (const item of chatItems(state.messages)) {
    const message = item._tag === "Message" ? item.message : item.reply
    if (!previous || !sameDay(previous.createdAt, message.createdAt)) {
      rows.push(<Divider key={`d-${message.id}`} label={dayLabel(message.createdAt, now)} first={!previous} />)
    }
    if (planLine?.at !== undefined && DateTime.isLessThan(planLine.at, message.createdAt)) showPlanLine("plan-line")
    previous = message
    if (item._tag === "Echo") {
      const rootId = item.reply.replyTo
      rows.push(
        <View
          key={message.id}
          style={props.scope !== undefined && message.workstream !== props.scope ? { opacity: 0.32 } : undefined}
        >
          <ReplyEcho
            reply={item.reply}
            root={item.root}
            onPress={() => rootId !== undefined && openThread(rootId, item.reply.id)}
          />
        </View>
      )
      continue
    }
    const time = sameDay(message.createdAt, now) ? timeLabel(message.createdAt) : undefined
    const workstream = message.workstream
    const label = workstream === undefined ? undefined : props.labels?.get(workstream)
    const mine = message._tag === "Text" && message.from === "user"
    const thread = item.thread
    rows.push(
      <View
        key={message.id}
        onLayout={(e) => {
          positions.current.set(message.id, { y: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height })
          checkSeen()
        }}
        style={props.scope !== undefined && workstream !== props.scope ? { opacity: 0.32 } : undefined}
      >
        {label === undefined ? null : <WorkstreamLabel title={label} mine={mine} />}
        <Holdable message={message} onReply={() => openThread(message.id)}>
          <MessageBody
            message={message}
            time={time}
            receipt={receipt?.messageId === message.id ? { seen: receipt.seen } : undefined}
            highlightAt={highlights.get(message.id) ?? 0}
            onAnswered={onAnswered}
          />
        </Holdable>
        {thread ? (
          <ThreadFold summary={thread} mine={mine} waiting={waiting(message)} onPress={() => openThread(message.id)} />
        ) : null}
      </View>
    )
  }
  showPlanLine("plan-line")

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
