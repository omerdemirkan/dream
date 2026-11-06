/**
 * The Status card pinned under the project's header, over Chat (Deck v3, option A).
 *
 * Compact, it says what the agent is doing now, where it is in the milestones and what it will need next; when
 * something waits for them it turns amber and leads with that ask. It folds to one line while they read back
 * through Chat or type, and opens over Chat into the whole roadmap (`StatusRoadmap`).
 */
import type { MilestoneState } from "@dream/domain"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { type HostInstance, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native"
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { scheduleOnRN } from "react-native-worklets"
import type { ProjectState } from "../data/projectState.ts"
import { useNow, useOpenMessage } from "./hooks.ts"
import { Dot, Icon, Lab } from "./kit.tsx"
import { StatusRoadmap } from "./Status.tsx"
import { askTitle, type CardView, cardOf, neededLabel, type Track } from "./statusView.ts"
import { color, needGlow } from "./theme.ts"

const easing = Easing.bezier(0.22, 0.8, 0.2, 1)

/** The folded card's height: one line. */
const lineHeight = 46

const cardFrame = (need: boolean) => ({
  borderRadius: 24,
  borderWidth: 1,
  borderColor: need ? color.needLine : color.line2,
  backgroundColor: color.s1,
  ...(need ? { experimental_backgroundImage: needGlow } : {})
})

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function TrackLabel(props: { readonly track: Track | undefined; readonly short?: boolean; readonly up?: boolean }) {
  const { track } = props
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7, flexShrink: 1 }}>
      {track ? (
        <Text numberOfLines={1} style={{ fontSize: 13, color: color.t3, flexShrink: 1 }}>
          {props.short
            ? `${track.position} of ${track.states.length}`
            : `${track.title} · ${track.position} of ${track.states.length}`}
        </Text>
      ) : null}
      <Icon
        name="chevDown"
        size={12}
        color={color.t3}
        weight="semibold"
        style={props.up ? { transform: [{ rotate: "180deg" }] } : undefined}
      />
    </View>
  )
}

/** The segmented bar: a segment per milestone, the current one half lit. */
function TrackBar(props: { readonly states: ReadonlyArray<MilestoneState>; readonly paused: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 5, marginTop: 14 }}>
      {props.states.map((state, i) => (
        <View
          key={i}
          style={{
            flex: 1,
            height: 4,
            borderRadius: 2,
            overflow: "hidden",
            backgroundColor: state === "done" ? color.t1 : "rgba(255,255,255,0.14)"
          }}
        >
          {state === "current" ? (
            <View style={{ width: "50%", height: 4, backgroundColor: props.paused ? color.t2 : color.t1 }} />
          ) : null}
        </View>
      ))}
    </View>
  )
}

function Foot(props: { readonly icon: "clock" | "spark"; readonly children: ReactNode }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 9,
        marginTop: 14,
        paddingTop: 12,
        borderTopWidth: 1,
        borderColor: color.line
      }}
    >
      <Icon name={props.icon} size={15} color={color.t3} />
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: color.t2 }}>
        {props.children}
      </Text>
    </View>
  )
}

const lead = { fontSize: 17, lineHeight: 23, letterSpacing: -0.2, color: color.t1, marginTop: 7 } as const

/** The card unfolded to its compact size: label and track, the line, the bar, the next need. */
function Full(props: { readonly view: CardView; readonly onRoadmap: () => void }) {
  const { view } = props
  if (view._tag === "Early") {
    return (
      <View style={{ paddingHorizontal: 18, paddingVertical: 16 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Lab>Looking into this</Lab>
          <TrackLabel track={undefined} />
        </View>
        <Text numberOfLines={4} style={{ fontSize: 15, lineHeight: 21, color: color.t2, marginTop: 7 }}>
          {view.text}
        </Text>
      </View>
    )
  }
  const needs = view._tag === "Needs"
  return (
    <View style={{ paddingHorizontal: 18, paddingVertical: 16 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <Lab style={needs ? { color: color.need } : undefined}>
          {needs ? (view.count > 1 ? `Needs you · ${view.count}` : "Needs you") : view.label}
        </Lab>
        {/* With an ask leading, the card opens the ask; the track still opens the roadmap. */}
        {needs ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open the roadmap"
            onPress={props.onRoadmap}
            hitSlop={{ top: 14, bottom: 10, left: 12, right: 14 }}
            style={{ flexShrink: 1 }}
          >
            <TrackLabel track={view.track} />
          </Pressable>
        ) : (
          <TrackLabel track={view.track} />
        )}
      </View>
      {needs ? (
        <>
          <Text numberOfLines={3} style={lead}>
            {askTitle(view.ask)}
          </Text>
          {view.also.length > 0 ? (
            <Foot icon="spark">
              {"Also: "}
              <Text style={{ color: color.t1 }}>{view.also.join(" · ")}</Text>
            </Foot>
          ) : null}
        </>
      ) : (
        <>
          {view.text ? (
            <Text numberOfLines={3} style={[lead, view.paused ? { color: color.t2 } : null]}>
              {view.text}
            </Text>
          ) : null}
          {view.track ? <TrackBar states={view.track.states} paused={view.paused} /> : null}
          {view.need ? (
            <Foot icon="clock">
              <Text style={{ color: color.t1 }}>{view.need.what}</Text>
              {view.need.when ? ` · ${neededLabel(view.need.when)}` : ""}
            </Foot>
          ) : null}
        </>
      )}
    </View>
  )
}

/** The card folded to one line. */
function Line(props: { readonly view: CardView; readonly working: boolean }) {
  const { view } = props
  const text = view._tag === "Needs" ? askTitle(view.ask) : view.text
  return (
    <View style={{ height: lineHeight, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16 }}>
      <Dot kind={view._tag === "Needs" ? "need" : props.working ? "live" : "quiet"} />
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 15, letterSpacing: -0.15, color: color.t1 }}>
        {text}
      </Text>
      <TrackLabel track={view._tag === "Early" ? undefined : view.track} short />
    </View>
  )
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export function StatusCardPin(props: {
  readonly state: ProjectState
  /** Folded to one line: they're reading back through Chat, or typing. */
  readonly compact: boolean
  readonly onRoadmap: () => void
  /** The unfolded card's height, which Chat keeps clear above its first message. */
  readonly onHeight: (height: number) => void
}) {
  const now = useNow()
  const view = cardOf(props.state, now)
  const ref = useRef<HostInstance>(null)
  const open = useOpenMessage()
  const fold = useSharedValue(props.compact ? 1 : 0)
  const full = useSharedValue(0)
  useEffect(() => {
    fold.value = withTiming(props.compact ? 1 : 0, { duration: 280, easing })
  }, [props.compact, fold])
  const frame = useAnimatedStyle(() =>
    full.value === 0 ? {} : { height: interpolate(fold.value, [0, 1], [full.value, lineHeight + 2]) }
  )
  const fullStyle = useAnimatedStyle(() => ({ opacity: interpolate(fold.value, [0, 0.5], [1, 0], "clamp") }))
  const lineStyle = useAnimatedStyle(() => ({ opacity: interpolate(fold.value, [0.4, 1], [0, 1], "clamp") }))

  const onPress = () => {
    if (view._tag === "Needs")
      open({ projectId: view.ask.projectId, messageId: view.ask.id, message: view.ask, from: ref })
    else props.onRoadmap()
  }
  const need = view._tag === "Needs"
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityHint={need ? "Opens the question" : "Opens the roadmap"}
      onPress={onPress}
    >
      {({ pressed }) => (
        <Animated.View style={[cardFrame(need), { overflow: "hidden", opacity: pressed ? 0.85 : 1 }, frame]}>
          <Animated.View
            style={fullStyle}
            pointerEvents={props.compact ? "none" : "auto"}
            onLayout={(e) => {
              const height = Math.round(e.nativeEvent.layout.height) + 2
              full.value = height
              props.onHeight(height)
            }}
          >
            <Full view={view} onRoadmap={props.onRoadmap} />
          </Animated.View>
          <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, right: 0, top: 0 }, lineStyle]}>
            <Line view={view} working={props.state.working} />
          </Animated.View>
        </Animated.View>
      )}
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// The roadmap, opened over Chat
// ---------------------------------------------------------------------------

/**
 * The card grown into the whole roadmap, over dimmed Chat. Tapping its top, the grabber or Chat folds it back.
 * What it holds is `StatusRoadmap`'s, so the contents can change without touching this.
 */
export function RoadmapSheet(props: {
  readonly state: ProjectState
  readonly open: boolean
  readonly onClose: () => void
  /** Where the card sits, and how tall it is, so the roadmap grows out of it and folds back into it. */
  readonly top: number
  readonly from: number
}) {
  const { height: H } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const now = useNow()
  const [mounted, setMounted] = useState(props.open)
  const [content, setContent] = useState(0)
  const progress = useSharedValue(0)
  const max = H - props.top - Math.max(insets.bottom, 12) - 8
  const head = 52
  const grabber = 26
  const target = content > 0 ? Math.min(head + content + grabber, max) : 0
  const from = useSharedValue(props.from)
  const to = useSharedValue(target)
  useEffect(() => {
    from.value = props.from
    to.value = target
  }, [props.from, target, from, to])

  useEffect(() => {
    if (props.open) setMounted(true)
    else if (mounted)
      progress.value = withTiming(0, { duration: 260, easing }, (finished) => {
        if (finished) scheduleOnRN(setMounted, false)
      })
  }, [props.open, mounted, progress])
  const ready = target > 0
  useEffect(() => {
    if (mounted && props.open && ready) progress.value = withTiming(1, { duration: 420, easing })
  }, [mounted, props.open, ready, progress])

  const scrim = useAnimatedStyle(() => ({ opacity: progress.value }))
  const card = useAnimatedStyle(() => ({
    height: to.value === 0 ? from.value : interpolate(progress.value, [0, 1], [from.value, to.value]),
    opacity: to.value === 0 ? 0 : 1
  }))
  const inside = useAnimatedStyle(() => ({ opacity: interpolate(progress.value, [0.15, 0.7], [0, 1], "clamp") }))

  if (!mounted) return null
  const view = cardOf(props.state, now)
  const need = view._tag === "Needs"
  const label = need ? (view.count > 1 ? `Needs you · ${view.count}` : "Needs you") : "Status"
  return (
    <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }} pointerEvents="box-none">
      <Animated.View style={[{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }, scrim]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close the roadmap"
          onPress={props.onClose}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.62)" }}
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        style={[
          cardFrame(false),
          {
            position: "absolute",
            top: props.top,
            left: 20,
            right: 20,
            overflow: "hidden",
            backgroundColor: color.sheet,
            boxShadow: "0 30px 60px rgba(0,0,0,0.6)"
          },
          card
        ]}
      >
        <Animated.View style={[{ flex: 1 }, inside]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close the roadmap"
            onPress={props.onClose}
            style={{
              height: head,
              paddingHorizontal: 18,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12
            }}
          >
            <Lab style={need ? { color: color.need } : undefined}>{label}</Lab>
            <TrackLabel track={view._tag === "Early" ? undefined : view.track} up />
          </Pressable>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 18 }}
            showsVerticalScrollIndicator={false}
          >
            <View onLayout={(e) => setContent(Math.ceil(e.nativeEvent.layout.height))} style={{ paddingBottom: 8 }}>
              <StatusRoadmap state={props.state} />
            </View>
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close the roadmap"
            onPress={props.onClose}
            style={{ height: grabber, alignItems: "center", justifyContent: "center" }}
          >
            <View style={{ width: 36, height: 5, borderRadius: 2.5, backgroundColor: color.line2 }} />
          </Pressable>
        </Animated.View>
      </Animated.View>
    </View>
  )
}
