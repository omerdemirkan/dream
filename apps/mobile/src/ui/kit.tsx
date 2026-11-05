/**
 * The small shared pieces of Deck v3: icons, tiles, dots, buttons, choices.
 * Names follow the mock's CSS classes where there is one.
 */
import { SymbolView, type SymbolViewProps } from "expo-symbols"
import type { ReactNode } from "react"
import { useEffect } from "react"
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle
} from "react-native"
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
import { color } from "./theme.ts"

// ---------------------------------------------------------------------------
// Icons: SF Symbols, the same set the Live Activity widget uses
// ---------------------------------------------------------------------------

const glyphs = {
  back: "chevron.left",
  close: "xmark",
  mic: "mic",
  up: "arrow.up",
  check: "checkmark",
  chev: "chevron.right",
  lock: "lock",
  clock: "clock",
  key: "key",
  expand: "arrow.up.left.and.arrow.down.right",
  layers: "square.stack.3d.up",
  cpu: "cpu",
  play: "play.fill",
  pause: "pause.fill",
  spark: "sparkle",
  person: "person.crop.circle",
  safari: "safari",
  doc: "doc.text",
  paste: "doc.on.clipboard",
  copy: "doc.on.doc",
  wrench: "wrench.adjustable",
  warn: "exclamationmark.triangle",
  arrowOut: "arrow.up.right"
} as const satisfies Record<string, SymbolViewProps["name"]>

export type Glyph = keyof typeof glyphs

export function Icon(props: {
  readonly name: Glyph
  readonly size?: number
  readonly color?: string
  readonly weight?: "regular" | "medium" | "semibold" | "bold"
  readonly style?: StyleProp<ViewStyle>
}) {
  const size = props.size ?? 20
  return (
    <SymbolView
      name={glyphs[props.name]}
      size={size}
      tintColor={props.color ?? color.t1}
      weight={props.weight ?? "medium"}
      resizeMode="scaleAspectFit"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width: size, height: size }, props.style]}
    />
  )
}

/**
 * The agent names a project's icon with any SF Symbol (`dream status --icon`).
 * It arrives as a plain string; an unknown name simply draws nothing.
 */
const symbolName = (name: string | undefined): SymbolViewProps["name"] =>
  (name && name.length > 0 ? name : "sparkle") as SymbolViewProps["name"]

/** SF Symbol names are lowercase ASCII words joined by dots; agents often pick an emoji instead. */
const isSymbolName = (name: string | undefined) => name === undefined || /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(name)

// ---------------------------------------------------------------------------
// Tiles, dots, the orb
// ---------------------------------------------------------------------------

const tileSizes = {
  sm: { box: 28, radius: 9, glyph: 15 },
  md: { box: 38, radius: 12, glyph: 19 },
  lg: { box: 44, radius: 13, glyph: 21 }
} as const

export function Tile(props: { readonly icon: string | undefined; readonly size?: keyof typeof tileSizes }) {
  const s = tileSizes[props.size ?? "lg"]
  return (
    <View
      style={{
        width: s.box,
        height: s.box,
        borderRadius: s.radius,
        backgroundColor: color.s2,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: color.line,
        alignItems: "center",
        justifyContent: "center"
      }}
    >
      {isSymbolName(props.icon) ? (
        <SymbolView
          name={symbolName(props.icon)}
          size={s.glyph}
          tintColor={color.t2}
          weight="medium"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ width: s.glyph, height: s.glyph }}
        />
      ) : (
        <Text
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ fontSize: s.glyph, lineHeight: s.glyph * 1.25 }}
        >
          {props.icon}
        </Text>
      )}
    </View>
  )
}

/** Opacity that breathes, as `@keyframes breathe`. */
const useBreathe = (on: boolean) => {
  const opacity = useSharedValue(1)
  useEffect(() => {
    if (!on) {
      cancelAnimation(opacity)
      opacity.value = 1
      return
    }
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.35, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) })
      ),
      -1
    )
    return () => cancelAnimation(opacity)
  }, [on, opacity])
  return useAnimatedStyle(() => ({ opacity: opacity.value }))
}

export function Dot(props: {
  readonly kind?: "need" | "live" | "quiet" | "soft"
  readonly style?: StyleProp<ViewStyle>
}) {
  const kind = props.kind ?? "quiet"
  const breathe = useBreathe(kind === "live" || kind === "soft")
  return (
    <Animated.View
      style={[
        {
          width: 7,
          height: 7,
          borderRadius: 3.5,
          backgroundColor:
            kind === "need" ? color.need : kind === "live" ? color.t1 : kind === "soft" ? color.t2 : color.t3
        },
        kind === "need" ? { boxShadow: `0 0 0 3px ${color.needBg}` } : null,
        breathe,
        props.style
      ]}
    />
  )
}

/** Dream's mark on Home: white while all is calm, amber when something needs them. */
export function Orb(props: { readonly need: boolean }) {
  return (
    <View
      style={{
        width: 20,
        height: 20,
        borderRadius: 10,
        experimental_backgroundImage: props.need
          ? "radial-gradient(circle at 35% 30%, #ffe6c4, #FFB35C 55%, #d97a1e)"
          : "radial-gradient(circle at 35% 30%, #ffffff, #c4c4cc 55%, #74747e)",
        boxShadow: props.need ? "0 0 22px rgba(255,179,92,0.55)" : "0 0 18px rgba(255,255,255,0.22)"
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export const type = StyleSheet.create({
  lab: { fontSize: 11, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: color.t3 },
  eyebrow: { fontSize: 11, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: color.need },
  body: { fontSize: 16, lineHeight: 23, color: color.t1, letterSpacing: -0.08 },
  sub: { fontSize: 14, lineHeight: 20, color: color.t2 },
  small: { fontSize: 13, lineHeight: 18, color: color.t3 }
})

export function Lab(props: { readonly children: ReactNode; readonly style?: StyleProp<TextStyle> }) {
  return <Text style={[type.lab, props.style]}>{props.children}</Text>
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Press = Omit<PressableProps, "style" | "children">

/** `.btn`: the white pill. `ghost` is `.btn.ghost-b`. */
export function Button(
  props: Press & {
    readonly title: string
    readonly variant?: "white" | "ghost" | "need"
    readonly busy?: boolean
    readonly trailing?: Glyph
    readonly style?: StyleProp<ViewStyle>
  }
) {
  const { title, variant = "white", busy, trailing, style, disabled, ...rest } = props
  const off = disabled === true
  const bg = off ? color.s2 : variant === "ghost" ? color.s2 : variant === "need" ? color.need : color.t1
  const fg = off ? color.t3 : variant === "ghost" ? color.t1 : variant === "need" ? color.needInk : color.black
  return (
    <Pressable
      accessibilityRole="button"
      disabled={off || busy === true}
      {...rest}
      style={({ pressed }) => [
        {
          height: 50,
          borderRadius: 25,
          backgroundColor: bg,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          borderWidth: variant === "ghost" ? 1 : 0,
          borderColor: color.line
        },
        pressed ? { transform: [{ scale: 0.98 }] } : null,
        style
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          <Text style={{ color: fg, fontSize: 16, fontWeight: "600", letterSpacing: -0.16 }}>{title}</Text>
          {trailing ? <Icon name={trailing} size={16} color={fg} weight="semibold" /> : null}
        </>
      )}
    </Pressable>
  )
}

/** `.linkb`: a quiet centered text button under the main action. */
export function LinkButton(props: Press & { readonly title: string }) {
  const { title, ...rest } = props
  return (
    <Pressable
      accessibilityRole="button"
      {...rest}
      style={({ pressed }) => ({ padding: 14, opacity: pressed ? 0.5 : 1 })}
    >
      <Text style={{ textAlign: "center", color: color.t2, fontSize: 15 }}>{title}</Text>
    </Pressable>
  )
}

/** `.ib`: the round icon button. */
export function IconButton(
  props: Press & {
    readonly icon: Glyph
    readonly size?: number
    readonly tone?: "plain" | "white" | "need" | "quiet"
    readonly label: string
    readonly style?: StyleProp<ViewStyle>
  }
) {
  const { icon, size = 40, tone = "plain", label, style, ...rest } = props
  const bg = tone === "white" ? color.t1 : tone === "need" ? color.need : tone === "quiet" ? color.s3 : color.s1
  const fg = tone === "white" ? color.black : tone === "need" ? color.needInk : color.t1
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      {...rest}
      style={({ pressed }) => [
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: pressed && tone === "plain" ? color.s3 : bg,
          borderWidth: tone === "plain" ? 1 : 0,
          borderColor: color.line,
          alignItems: "center",
          justifyContent: "center"
        },
        pressed && tone !== "plain" ? { transform: [{ scale: 0.95 }] } : null,
        style
      ]}
    >
      <Icon name={icon} size={Math.round(size * 0.47)} color={fg} weight="semibold" />
    </Pressable>
  )
}

/** `.backl`: "‹ Cabin · Chat" at the top of the expanded view. */
export function BackPill(props: Press & { readonly title: string }) {
  const { title, ...rest } = props
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Back to ${title}`}
      hitSlop={8}
      {...rest}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 40,
        paddingLeft: 10,
        paddingRight: 14,
        marginLeft: -4,
        borderRadius: 20,
        backgroundColor: pressed ? color.s3 : color.s1,
        borderWidth: 1,
        borderColor: color.line,
        alignSelf: "flex-start"
      })}
    >
      <Icon name="back" size={16} weight="semibold" />
      <Text style={{ color: color.t1, fontSize: 15, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  )
}

export function GoogleMark(props: { readonly size?: number }) {
  const size = props.size ?? 22
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill="#4285F4"
        d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.3h5.9a5 5 0 01-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8.1z"
      />
      <Path
        fill="#34A853"
        d="M12 23c3 0 5.5-1 7.3-2.7l-3.5-2.7c-1 .7-2.2 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2.1v2.8A11 11 0 0012 23z"
      />
      <Path fill="#FBBC05" d="M5.7 14.1a6.6 6.6 0 010-4.2V7.1H2.1a11 11 0 000 9.8z" />
      <Path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.1-3.1A11 11 0 002.1 7.1l3.6 2.8C6.6 7.4 9.1 5.4 12 5.4z" />
    </Svg>
  )
}

/** `.gbtn`: "Continue with Google". */
export function GoogleButton(
  props: Press & { readonly busy?: boolean; readonly compact?: boolean; readonly title?: string }
) {
  const { busy, compact, title, ...rest } = props
  return (
    <Pressable
      accessibilityRole="button"
      disabled={busy === true}
      {...rest}
      style={({ pressed }) => ({
        height: compact ? 48 : 56,
        borderRadius: 28,
        backgroundColor: color.white,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        opacity: busy ? 0.7 : 1,
        transform: pressed ? [{ scale: 0.985 }] : [],
        marginTop: compact ? 14 : 0
      })}
    >
      {busy ? null : <GoogleMark />}
      <Text style={{ color: "#1f1f1f", fontSize: compact ? 16 : 17, fontWeight: "600", letterSpacing: -0.17 }}>
        {busy ? "Opening Google…" : (title ?? "Continue with Google")}
      </Text>
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------

export function Choice(
  props: Press & { readonly label: string; readonly selected?: boolean; readonly size?: "sm" | "md" | "lg" }
) {
  const { label, selected, size = "md", ...rest } = props
  const height = size === "lg" ? 58 : size === "sm" ? 46 : 48
  return (
    <Pressable
      accessibilityRole="button"
      {...rest}
      style={({ pressed }) => [
        {
          minHeight: height,
          paddingHorizontal: 16,
          paddingVertical: 11,
          gap: 10,
          borderRadius: size === "lg" ? 18 : 16,
          backgroundColor: selected ? color.need : pressed ? color.s3 : color.s2,
          borderWidth: 1,
          borderColor: selected ? color.need : color.line,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between"
        },
        pressed ? { transform: [{ scale: 0.985 }] } : null
      ]}
    >
      {/* Agents write options as long as a sentence: wrap rather than cut them off. */}
      <Text
        numberOfLines={size === "lg" ? 3 : 2}
        style={{
          flex: 1,
          color: selected ? color.needInk : color.t1,
          fontSize: size === "lg" ? 17 : size === "sm" ? 15.5 : 16,
          fontWeight: "600",
          letterSpacing: -0.16
        }}
      >
        {label}
      </Text>
      <Icon name="chev" size={15} color={selected ? color.needInk : color.t3} />
    </Pressable>
  )
}

export function Choices(props: {
  readonly options: ReadonlyArray<string>
  readonly selected?: string | undefined
  readonly onPick: (option: string) => void
  readonly size?: "sm" | "md" | "lg"
  readonly style?: StyleProp<ViewStyle>
}) {
  return (
    <View style={[{ gap: 8 }, props.style]}>
      {props.options.map((option) => (
        <Choice
          key={option}
          label={option}
          selected={props.selected === option}
          size={props.size ?? "md"}
          onPress={() => props.onPick(option)}
        />
      ))}
    </View>
  )
}

// ---------------------------------------------------------------------------
// The listening wave
// ---------------------------------------------------------------------------

function Bar(props: { readonly delay: number }) {
  const height = useSharedValue(6)
  useEffect(() => {
    height.value = withDelay(
      props.delay,
      withRepeat(
        withSequence(
          withTiming(20, { duration: 450, easing: Easing.inOut(Easing.ease) }),
          withTiming(6, { duration: 450, easing: Easing.inOut(Easing.ease) })
        ),
        -1
      )
    )
    return () => cancelAnimation(height)
  }, [height, props.delay])
  const style = useAnimatedStyle(() => ({ height: height.value }))
  return <Animated.View style={[{ width: 3, borderRadius: 2, backgroundColor: color.need }, style]} />
}

export function Bars() {
  return (
    <View style={{ flexDirection: "row", gap: 3, alignItems: "center", height: 22 }}>
      {[0, 120, 280, 50, 200].map((delay) => (
        <Bar key={delay} delay={delay} />
      ))}
    </View>
  )
}
