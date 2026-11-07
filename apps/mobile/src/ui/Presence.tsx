/**
 * Whether the agent is up, on screen (Deck v3, "A+B+C"): the presence dot on a project's tile, its state line, the
 * row at the bottom of Chat, and the receipt under their latest message. What each one says comes from
 * `data/presence.ts`; this file only draws it.
 */
import type { DateTime } from "effect"
import { type ReactNode, useEffect } from "react"
import { type StyleProp, Text, type TextStyle, View } from "react-native"
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming
} from "react-native-reanimated"
import Svg, { Path } from "react-native-svg"
import { timeLabel } from "../data/format.ts"
import { type ChatRow, elapsedLabel, type PresenceDot as Dot, type StateLine } from "../data/presence.ts"
import { useNow } from "./hooks.ts"
import { Tile } from "./kit.tsx"
import { color } from "./theme.ts"

const awake = "#5CCB8A"
const asleep = "#5D5D64"
const ring = "#77777E"

/** `@keyframes pdp`: a ring that grows out of the dot and fades, every 2 s. */
function Pulse(props: { readonly size: number; readonly tint: string }) {
  const progress = useSharedValue(0)
  useEffect(() => {
    progress.value = withRepeat(withTiming(1, { duration: 2000, easing: Easing.out(Easing.ease) }), -1)
    return () => cancelAnimation(progress)
  }, [progress])
  const style = useAnimatedStyle(() => ({
    opacity: 0.55 * (1 - progress.value),
    transform: [{ scale: 1 + (progress.value * 16) / props.size }]
  }))
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          width: props.size,
          height: props.size,
          borderRadius: props.size / 2,
          backgroundColor: props.tint
        },
        style
      ]}
    />
  )
}

/** `@keyframes breathe`. */
function useBreathe(on: boolean) {
  const opacity = useSharedValue(1)
  useEffect(() => {
    if (!on) {
      cancelAnimation(opacity)
      opacity.value = 1
      return
    }
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.35, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) })
      ),
      -1
    )
    return () => cancelAnimation(opacity)
  }, [on, opacity])
  return useAnimatedStyle(() => ({ opacity: opacity.value }))
}

/** The dot on a project's tile (`.pd`): white pulse working, grey breathing starting, green awake, grey asleep, a ring paused. */
export function PresenceDot(props: { readonly dot: Dot; readonly size?: number }) {
  const size = props.size ?? 13
  const breathe = useBreathe(props.dot === "starting")
  if (props.dot === "none") return null
  const fill =
    props.dot === "working" ? color.t1 : props.dot === "awake" ? awake : props.dot === "paused" ? color.bg : asleep
  return (
    <View
      accessible
      accessibilityLabel={label[props.dot]}
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      {props.dot === "working" ? <Pulse size={size} tint="rgba(255,255,255,1)" /> : null}
      <Animated.View
        style={[
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 2.5,
            borderColor: color.bg,
            backgroundColor: fill
          },
          props.dot === "paused" ? { boxShadow: `inset 0 0 0 2px ${ring}` } : null,
          breathe
        ]}
      />
    </View>
  )
}

const label: Record<Exclude<Dot, "none">, string> = {
  working: "Working",
  starting: "Starting",
  awake: "Awake",
  asleep: "Asleep",
  paused: "Paused"
}

/** A project's tile with its presence dot at the corner (`.tw`). */
export function PresenceTile(props: {
  readonly icon: string | undefined
  readonly size?: "md" | "lg"
  readonly dot: Dot
}) {
  const dotSize = props.size === "md" ? 12 : 13
  return (
    <View style={{ position: "relative" }}>
      <Tile icon={props.icon} size={props.size ?? "lg"} />
      <View style={{ position: "absolute", right: -3, bottom: -3 }}>
        <PresenceDot dot={props.dot} size={dotSize} />
      </View>
    </View>
  )
}

/** "**Working** · 2m": a strong lead is white and bold, the rest quiet. */
export function StateLineText(props: { readonly line: StateLine; readonly style?: StyleProp<TextStyle> }) {
  const { line } = props
  return (
    <Text numberOfLines={1} style={[{ color: color.t2 }, props.style]}>
      <Text style={line.strong ? { color: color.t1, fontWeight: "600" } : line.need ? { color: color.need } : null}>
        {line.lead}
      </Text>
      {line.rest ? ` · ${line.rest}` : ""}
    </Text>
  )
}

/** The current time, every second while a turn's elapsed time is on screen and every 30 s otherwise. */
export const useTickingNow = (ticking: boolean) => useNow(ticking ? 1000 : 30_000)

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** `@keyframes bounce` on three dots, a beat apart (`.tdots`). */
function BounceDot(props: { readonly delay: number }) {
  const t = useSharedValue(0)
  useEffect(() => {
    t.value = withDelay(
      props.delay,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 360, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 360, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 480 })
        ),
        -1
      )
    )
    return () => cancelAnimation(t)
  }, [t, props.delay])
  const style = useAnimatedStyle(() => ({ opacity: 0.5 + 0.5 * t.value, transform: [{ translateY: -4 * t.value }] }))
  return <Animated.View style={[{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: color.t2 }, style]} />
}

function Bubble(props: {
  readonly children: ReactNode
  readonly two?: boolean
  readonly wide?: boolean
  readonly label: string
}) {
  return (
    <View
      accessible
      accessibilityLabel={props.label}
      accessibilityLiveRegion="polite"
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: props.two ? "flex-start" : "center",
        gap: 11,
        minHeight: 40,
        maxWidth: props.wide ? "100%" : "86%",
        paddingVertical: props.two ? 11 : 9,
        paddingLeft: 14,
        paddingRight: 16,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        borderBottomRightRadius: 20,
        borderBottomLeftRadius: 6,
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: color.line
      }}
    >
      {props.children}
    </View>
  )
}

/** The little white dot in the row (`.pl`): pulsing while working, breathing grey while starting. */
function RowDot(props: { readonly starting: boolean }) {
  const breathe = useBreathe(props.starting)
  return (
    <View
      style={{ width: 8, height: 8, alignItems: "center", justifyContent: "center", marginTop: props.starting ? 6 : 0 }}
    >
      {props.starting ? null : <Pulse size={8} tint="rgba(255,255,255,1)" />}
      <Animated.View
        style={[
          { width: 8, height: 8, borderRadius: 4, backgroundColor: props.starting ? color.t2 : color.t1 },
          breathe
        ]}
      />
    </View>
  )
}

/**
 * "Working · 35m", and under it what the turn is doing when dreamd has said (`progressNote`): the row widens to
 * the full column for it, and the line stays on one line, as dreamd sized it.
 */
function WorkingRow(props: {
  readonly since: DateTime.Utc | undefined
  readonly note: { readonly text: string; readonly quiet: boolean } | undefined
}) {
  const now = useTickingNow(props.since !== undefined)
  const elapsed = props.since ? elapsedLabel(props.since, now) : undefined
  const head = elapsed ? `Working, ${elapsed}` : "Working"
  return (
    <Bubble
      two={props.note !== undefined}
      wide={props.note !== undefined}
      label={props.note ? `${head}. ${props.note.text}` : head}
    >
      <RowDot starting={false} />
      <View style={{ flexShrink: 1 }}>
        <Text style={{ fontSize: 15, letterSpacing: -0.15, color: color.t2 }}>
          <Text style={{ color: color.t1, fontWeight: "600" }}>Working</Text>
          {elapsed ? ` · ${elapsed}` : ""}
        </Text>
        {props.note ? (
          <Text
            numberOfLines={1}
            style={{ fontSize: 14, lineHeight: 19, color: props.note.quiet ? color.t3 : color.t2, marginTop: 2 }}
          >
            {props.note.text}
          </Text>
        ) : null}
      </View>
    </Bubble>
  )
}

/** The row at the bottom of Chat (A): typing dots, starting, working, or a quiet "Done for now". */
export function ChatActivityRow(props: { readonly row: ChatRow }) {
  const { row } = props
  switch (row._tag) {
    case "Sent":
      return (
        <Bubble label="Dream got your message">
          <View style={{ flexDirection: "row", gap: 4, paddingHorizontal: 2, paddingVertical: 2 }}>
            <BounceDot delay={0} />
            <BounceDot delay={150} />
            <BounceDot delay={300} />
          </View>
        </Bubble>
      )
    case "Starting":
      return (
        <Bubble two label="Starting its computer">
          <RowDot starting />
          <View style={{ flexShrink: 1 }}>
            <Text style={{ fontSize: 15, fontWeight: "600", letterSpacing: -0.15, color: color.t1 }}>
              Starting its computer…
            </Text>
            <Text style={{ fontSize: 13, lineHeight: 17.5, color: color.t3, marginTop: 2 }}>
              {row.fresh
                ? "Usually 10–30 seconds. No need to wait here: I’ll send a notification when I have a question."
                : "Usually 10–30 seconds"}
            </Text>
          </View>
        </Bubble>
      )
    case "Working":
      return <WorkingRow since={row.since} note={row.note} />
    case "Done":
      return (
        <View
          accessible
          accessibilityLabel="Done for now"
          style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 7, marginTop: -4 }}
        >
          <Check size={14} />
          <Text style={{ fontSize: 13, color: color.t3 }}>Done for now</Text>
        </View>
      )
  }
}

function Check(props: { readonly size: number; readonly double?: boolean }) {
  return (
    <Svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color.t3}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Path d={props.double ? "M2.5 12.5l4.5 4.5L16.5 7.5M12 16.5l.5.5L22 7.5" : "M5 12.5l4.5 4.5L19 7.5"} />
    </Svg>
  )
}

/** Under their latest message (C): "✓ Sent · 2:02 PM", then "✓✓ Seen · 2:02 PM". */
export function Receipt(props: { readonly seen: boolean; readonly sentAt: DateTime.Utc; readonly showTime: boolean }) {
  const word = props.seen ? "Seen" : "Sent"
  const time = props.showTime ? ` · ${timeLabel(props.sentAt)}` : ""
  return (
    <View
      accessible
      accessibilityLabel={`${word}${time}`}
      style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 }}
    >
      <Check size={props.seen ? 15 : 13} double={props.seen} />
      <Text style={{ fontSize: 12, color: color.t3 }}>
        {word}
        {time}
      </Text>
    </View>
  )
}
