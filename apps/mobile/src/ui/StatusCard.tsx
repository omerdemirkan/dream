/**
 * The Status card pinned under the project's header, over Chat.
 *
 * Compact, it is the "now" sentence on one line and the milestone track, and an amber line while something waits
 * for them. It folds to a single line while they read back through Chat or type, and opens over Chat into
 * `StatusRoadmap`.
 */
import type { MilestoneState, WorkstreamId } from "@dream/domain"
import { useEffect, useRef, useState } from "react"
import { type HostInstance, Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native"
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { scheduleOnRN } from "react-native-worklets"
import type { ProjectState } from "../data/projectState.ts"
import { useNow, useOpenMessage } from "./hooks.ts"
import { Dot, Icon } from "./kit.tsx"
import { NeedLine, StatusRoadmap } from "./Status.tsx"
import { type CardView, cardOf, type RowsView, type RowView, type Track } from "./statusView.ts"
import { bigTextScale, color, needGlow } from "./theme.ts"

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

function Chevron(props: { readonly up?: boolean }) {
  return (
    <Icon
      name="chevDown"
      size={13}
      color={color.t3}
      weight="semibold"
      style={props.up ? { transform: [{ rotate: "180deg" }] } : undefined}
    />
  )
}

/** The segmented bar, the current milestone half lit, and "2 of 3". */
function TrackRow(props: { readonly track: Track; readonly paused: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 14 }}>
      <View style={{ flex: 1, flexDirection: "row", gap: 5 }}>
        {props.track.states.map((state: MilestoneState, i) => (
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
      <Text style={{ fontSize: 14, color: color.t3 }}>{`${props.track.position} of ${props.track.states.length}`}</Text>
    </View>
  )
}

/** One workstream: its dot, its title, and where it stands, or in amber what it waits on them for. */
function WorkstreamRow(props: {
  readonly row: RowView
  readonly first: boolean
  readonly dimmed: boolean
  readonly onScope: (id: WorkstreamId) => void
}) {
  const ref = useRef<HostInstance>(null)
  const open = useOpenMessage()
  const { row } = props
  const waiting = row.waiting
  const ink = waiting ? color.need : color.t1
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={`${row.title}${row.line ? `, ${row.line}` : ""}`}
      accessibilityHint={waiting ? "Opens what it needs from you" : "Writes to this workstream"}
      onPress={() =>
        waiting
          ? open({ projectId: waiting.projectId, messageId: waiting.id, message: waiting, from: ref })
          : props.onScope(row.id)
      }
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 12,
        paddingVertical: 10,
        borderTopWidth: props.first ? 0 : 1,
        borderColor: color.line,
        opacity: pressed ? 0.6 : props.dimmed ? 0.45 : 1
      })}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          marginTop: 7,
          backgroundColor: ink,
          boxShadow: `0 0 0 3px ${waiting ? color.needBg : "rgba(255,255,255,0.10)"}`
        }}
      />
      <View style={{ flex: 1, paddingRight: props.first ? 22 : 0 }}>
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={bigTextScale}
          style={{ fontSize: 15.5, lineHeight: 21, fontWeight: "600", letterSpacing: -0.25, color: ink }}
        >
          {row.title}
        </Text>
        {row.line ? (
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={bigTextScale}
            style={{ fontSize: 14, lineHeight: 19, marginTop: 1, color: waiting ? color.need : color.t2 }}
          >
            {row.line}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

/** The card while two or more workstreams are active: a row each, the rest summed up, what finished folded. */
function Rows(props: {
  readonly rows: RowsView
  readonly need: CardView["looseNeed"]
  readonly scope: WorkstreamId | undefined
  readonly onScope: (id: WorkstreamId) => void
}) {
  const { rows } = props
  return (
    <View style={{ paddingLeft: 16, paddingRight: 16, paddingTop: 6, paddingBottom: 8 }}>
      <View style={{ position: "absolute", top: 18, right: 16 }}>
        <Chevron />
      </View>
      <View>
        {rows.rows.map((row, i) => (
          <WorkstreamRow
            key={row.id}
            row={row}
            first={i === 0}
            dimmed={props.scope !== undefined && props.scope !== row.id}
            onScope={props.onScope}
          />
        ))}
      </View>
      {rows.more ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingVertical: 11,
            borderTopWidth: 1,
            borderColor: color.line
          }}
        >
          <View style={{ width: 8, alignItems: "center" }}>
            <View
              style={{
                width: 4,
                height: 4,
                borderRadius: 2,
                backgroundColor: rows.more.waiting ? color.need : color.t3
              }}
            />
          </View>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: rows.more.waiting ? color.need : color.t2 }}>
            {rows.more.text}
          </Text>
        </View>
      ) : null}
      {props.need ? (
        <View style={{ paddingVertical: 11, borderTopWidth: 1, borderColor: color.line }}>
          <NeedLine need={props.need} size="card" />
        </View>
      ) : null}
      {rows.done ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            paddingTop: 10,
            paddingBottom: 4,
            borderTopWidth: 1,
            borderColor: color.line
          }}
        >
          <View
            style={{
              width: 16,
              height: 16,
              marginLeft: -4,
              marginRight: -2,
              borderRadius: 8,
              backgroundColor: color.s3,
              alignItems: "center",
              justifyContent: "center"
            }}
          >
            <Icon name="check" size={8} color={color.t2} weight="bold" />
          </View>
          <Text numberOfLines={1} style={{ flex: 1, fontSize: 13.5, color: color.t3 }}>
            {rows.done.text}
          </Text>
          {rows.done.others > 0 ? (
            <Text style={{ fontSize: 13, color: color.t3 }}>{`+${rows.done.others}`}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

/** The card at its compact size: the sentence, the track, the need; or with workstreams, their rows. */
function Full(props: {
  readonly view: CardView
  readonly scope: WorkstreamId | undefined
  readonly onScope: (id: WorkstreamId) => void
}) {
  const { view } = props
  if (view.rows) return <Rows rows={view.rows} need={view.looseNeed} scope={props.scope} onScope={props.onScope} />
  const now = view.stand === "now"
  return (
    <View style={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: view.need ? 14 : 16 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
        <Text
          numberOfLines={now ? 2 : 3}
          maxFontSizeMultiplier={bigTextScale}
          style={
            now
              ? { flex: 1, fontSize: 17, lineHeight: 23, letterSpacing: -0.2, color: view.paused ? color.t2 : color.t1 }
              : { flex: 1, fontSize: 15, lineHeight: 21, color: color.t2 }
          }
        >
          {view.text}
        </Text>
        <View style={{ marginTop: 5 }}>
          <Chevron />
        </View>
      </View>
      {view.track ? <TrackRow track={view.track} paused={view.paused} /> : null}
      {view.need ? (
        <View style={{ marginTop: 14, paddingTop: 13, borderTopWidth: 1, borderColor: color.line }}>
          <NeedLine need={view.need} size="card" />
        </View>
      ) : null}
    </View>
  )
}

/** The card folded to one line: the need when there is one, else the sentence. */
function Line(props: { readonly view: CardView; readonly working: boolean }) {
  const { view } = props
  return (
    <View style={{ height: lineHeight, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16 }}>
      <Dot kind={view.need ? "need" : props.working ? "live" : "quiet"} />
      <Text
        numberOfLines={1}
        style={{ flex: 1, fontSize: 15, letterSpacing: -0.15, color: view.need ? color.need : color.t1 }}
      >
        {view.need ? view.need.text : view.rows ? view.rows.all.map((r) => r.title).join(", ") : view.text}
      </Text>
      {view.track ? (
        <Text style={{ fontSize: 13, color: color.t3 }}>{`${view.track.position} of ${view.track.states.length}`}</Text>
      ) : null}
      <Chevron />
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
  /** The workstream they're writing to, whose row stays bright. */
  readonly scope?: WorkstreamId | undefined
  /** Tapping a workstream's row writes to it. */
  readonly onScope?: (id: WorkstreamId) => void
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

  // Folded to the need's line, a tap opens the ask; otherwise the card opens (the need's own line opens the ask).
  const onPress = () => {
    if (props.compact && view.need)
      open({ projectId: view.need.ask.projectId, messageId: view.need.ask.id, message: view.need.ask, from: ref })
    else props.onRoadmap()
  }
  const need = view.need !== undefined
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityHint={props.compact && need ? "Opens what it needs from you" : "Opens the roadmap"}
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
            <Full view={view} scope={props.scope} onScope={props.onScope ?? (() => {})} />
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
 * The card grown into the whole roadmap, over dimmed Chat. Tapping the sentence, the grabber or Chat folds it back.
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
  const [mounted, setMounted] = useState(props.open)
  const [content, setContent] = useState(0)
  const progress = useSharedValue(0)
  const max = H - props.top - Math.max(insets.bottom, 12) - 8
  const grabber = 30
  const target = content > 0 ? Math.min(content + grabber, max) : 0
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
          <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            <View
              onLayout={(e) => setContent(Math.ceil(e.nativeEvent.layout.height))}
              style={{ paddingHorizontal: 18, paddingTop: 18, paddingBottom: 4 }}
            >
              <StatusRoadmap state={props.state} onClose={props.onClose} />
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
