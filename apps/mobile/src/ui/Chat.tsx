/**
 * The Chat tab: only what Dream chose to send, and what they send. Sparse by
 * design; long gaps are normal and nothing animates while the agent works.
 */
import type { AskMessage, Message, MessageId } from "@dream/domain"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import {
  type HostInstance,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  type ScrollViewInstance,
  Text,
  View
} from "react-native"
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withTiming } from "react-native-reanimated"
import { dayLabel, sameDay, timeLabel } from "../data/format.ts"
import type { ProjectState } from "../data/projectState.ts"
import { loadEarlierFn } from "../state/atoms.ts"
import { landingAtom, messageRects } from "../state/ui.ts"
import { useNow, useOpenMessage, usePendingAnswers, withPending } from "./hooks.ts"
import { AccessCard, AgentText, QuestionCard, UserBubble } from "./Messages.tsx"
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

function AskRow(props: { readonly message: AskMessage; readonly highlightAt: number }) {
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
        <QuestionCard ref={ref} message={m} onOpen={onOpen} />
      ) : (
        <AccessCard ref={ref} message={m} onOpen={onOpen} />
      )}
      <Highlight at={props.highlightAt} need={need} />
    </View>
  )
}

export function ChatTab(props: {
  readonly state: ProjectState
  readonly topInset: number
  readonly bottomInset: number
}) {
  const { state } = props
  const projectId = state.project.id
  const now = useNow()
  const pending = usePendingAnswers()
  const landing = useAtomValue(landingAtom)
  const setLanding = useAtomSet(landingAtom)
  const loadEarlier = useAtomSet(loadEarlierFn)
  const scroll = useRef<ScrollViewInstance>(null)
  const positions = useRef(new Map<MessageId, { y: number; height: number }>())
  const viewport = useRef(0)
  const nearBottom = useRef(true)
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

  const onContentSizeChange = () => {
    if (wanted) return
    if (!landed.current || nearBottom.current) {
      scroll.current?.scrollToEnd({ animated: landed.current })
      landed.current = true
    }
  }

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    nearBottom.current = contentOffset.y + layoutMeasurement.height > contentSize.height - 160
    if (contentOffset.y < 200 && state.hasEarlierMessages && !loadingEarlier.current) {
      loadingEarlier.current = true
      loadEarlier(projectId)
      setTimeout(() => (loadingEarlier.current = false), 1500)
    }
  }

  const rows: Array<ReactNode> = []
  let previous: Message | undefined
  for (const raw of state.messages) {
    const message = withPending(raw, pending)
    if (!previous || !sameDay(previous.createdAt, message.createdAt)) {
      rows.push(<Divider key={`d-${message.id}`} label={dayLabel(message.createdAt, now)} first={!previous} />)
    }
    previous = message
    const time = sameDay(message.createdAt, now) ? timeLabel(message.createdAt) : undefined
    const highlightAt = highlights.get(message.id) ?? 0
    rows.push(
      <View
        key={message.id}
        onLayout={(e) =>
          positions.current.set(message.id, { y: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height })
        }
      >
        {message._tag === "Text" ? (
          message.from === "user" ? (
            <UserBubble message={message} time={time} />
          ) : (
            <AgentText message={message} time={time} />
          )
        ) : (
          <AskRow message={message} highlightAt={highlightAt} />
        )}
      </View>
    )
  }

  return (
    <ScrollView
      ref={scroll}
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingTop: props.topInset,
        paddingBottom: props.bottomInset,
        paddingHorizontal: gutter,
        gap: 14
      }}
      onLayout={(e) => (viewport.current = e.nativeEvent.layout.height)}
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
    </ScrollView>
  )
}
