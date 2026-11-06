/**
 * Project usage, Deck v3 option A: a small ring of the subscription's week on the right of the project header
 * (this project's share, everything else, what's left), and the usage sheet it opens. What they say comes from
 * `data/usage.ts`; sizes and colours follow mocks/screens/project-usage (screens.html, `.hr-u.ring`, `.sheet`).
 */
import type { ProjectId } from "@dream/domain"
import { useAtomValue } from "@effect/atom-react"
import { DateTime, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { SymbolView, type SymbolViewProps } from "expo-symbols"
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import Animated, { Easing, SlideInDown } from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Svg, { Circle, G } from "react-native-svg"
import { type RingArcs, type UsageSheet as SheetView, usageBadge, usageSheet } from "../data/usage.ts"
import { projectUsageAtom, usageGlanceAtom } from "../state/atoms.ts"
import { IconButton } from "./kit.tsx"
import { color, gutter, tracking } from "./theme.ts"

const others = "rgba(255,255,255,0.34)"
const track = "rgba(255,255,255,0.12)"

/** A ring of arcs over a faint track, starting at twelve o'clock: this project's, then everything else's. */
function Ring(props: {
  readonly size: number
  readonly stroke: number
  readonly arcs: RingArcs
  readonly warn: boolean
}) {
  const { size, stroke, arcs } = props
  const r = (size - stroke) / 2
  const c = size / 2
  const length = 2 * Math.PI * r
  const arc = (fraction: number, offset: number, tint: string) =>
    fraction > 0 ? (
      <Circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke={tint}
        strokeWidth={stroke}
        strokeDasharray={`${fraction * length} ${length}`}
        strokeDashoffset={-offset * length}
      />
    ) : null
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <G rotation={-90} origin={`${c}, ${c}`}>
        <Circle cx={c} cy={c} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        {arc(arcs.project, 0, props.warn ? color.need : color.t1)}
        {arc(arcs.others, arcs.project, others)}
      </G>
    </Svg>
  )
}

/** The header's right side: the ring and "4%" over "of week", or nothing while no usage is known. */
export function UsageBadge(props: { readonly projectId: ProjectId; readonly onPress: () => void }) {
  const glance = Option.getOrUndefined(AsyncResult.value(useAtomValue(usageGlanceAtom(props.projectId))))
  const badge = usageBadge(glance)
  if (!badge) return null
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge.accessibilityLabel}
      accessibilityHint="Opens usage"
      onPress={props.onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 7,
        paddingVertical: 6,
        paddingLeft: 6,
        marginRight: -2,
        opacity: pressed ? 0.6 : 1
      })}
    >
      <Ring size={26} stroke={4} arcs={badge.arcs} warn={badge.nearLimit} />
      <View style={{ alignItems: "flex-end" }}>
        <Text
          style={{
            fontSize: 15,
            lineHeight: 17,
            fontWeight: "600",
            letterSpacing: tracking(-0.02, 15),
            fontVariant: ["tabular-nums"],
            color: badge.nearLimit ? color.need : color.t1
          }}
        >
          {badge.value}
        </Text>
        <Text style={{ fontSize: 12, lineHeight: 14, color: color.t3 }}>{badge.caption}</Text>
      </View>
    </Pressable>
  )
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

/** Opens over the project, below its header. Fetches fresh each time it opens. */
export function UsageSheet(props: {
  readonly projectId: ProjectId
  readonly title: string
  readonly open: boolean
  readonly onClose: () => void
}) {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={props.open} transparent animationType="fade" onRequestClose={props.onClose} statusBarTranslucent>
      <View style={{ flex: 1 }}>
        <Pressable
          accessibilityLabel="Close"
          onPress={props.onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.58)" }]}
        />
        {props.open ? (
          <Animated.View
            entering={SlideInDown.duration(340).easing(Easing.bezier(0.2, 0.8, 0.2, 1))}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              top: insets.top + 50,
              backgroundColor: color.s1,
              borderTopLeftRadius: 30,
              borderTopRightRadius: 30,
              borderCurve: "continuous",
              borderWidth: 1,
              borderBottomWidth: 0,
              borderColor: color.line2,
              overflow: "hidden"
            }}
          >
            <View
              style={{
                alignSelf: "center",
                width: 36,
                height: 5,
                borderRadius: 3,
                backgroundColor: "rgba(255,255,255,0.22)",
                marginTop: 10,
                marginBottom: 14
              }}
            />
            <SheetContent {...props} bottom={Math.max(insets.bottom, 16) + 12} />
          </Animated.View>
        ) : null}
      </View>
    </Modal>
  )
}

function SheetContent(props: {
  readonly projectId: ProjectId
  readonly title: string
  readonly onClose: () => void
  readonly bottom: number
}) {
  const result = useAtomValue(projectUsageAtom(props.projectId))
  const usage = Option.getOrUndefined(AsyncResult.value(result))
  const view = usage ? usageSheet(usage, props.title, props.projectId, DateTime.nowUnsafe()) : undefined
  return (
    <ScrollView
      contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: props.bottom }}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 20, fontWeight: "700", letterSpacing: tracking(-0.035, 20), color: color.t1 }}>
            Usage
          </Text>
          <Text numberOfLines={1} style={{ fontSize: 13.5, color: color.t3, marginTop: 1 }}>
            {view?.subtitle ?? props.title}
          </Text>
        </View>
        <IconButton icon="close" size={32} tone="quiet" label="Close" onPress={props.onClose} />
      </View>
      {view ? (
        <Body view={view} title={props.title} />
      ) : AsyncResult.isFailure(result) ? (
        <Text style={{ fontSize: 14.5, color: color.t2, marginTop: 24 }}>Usage isn’t available right now.</Text>
      ) : (
        <ActivityIndicator color={color.t3} style={{ marginTop: 40 }} />
      )}
    </ScrollView>
  )
}

function Body(props: { readonly view: SheetView; readonly title: string }) {
  const { view } = props
  return (
    <>
      {view.hero ? <Hero hero={view.hero} title={props.title} /> : null}
      {view.callout ? (
        <Text
          style={{
            marginTop: 16,
            paddingVertical: 12,
            paddingHorizontal: 14,
            borderRadius: 16,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: color.needLine,
            backgroundColor: color.needBg,
            overflow: "hidden",
            fontSize: 14,
            lineHeight: 19.6,
            color: color.t1
          }}
        >
          <Text style={{ color: color.need, fontWeight: "600" }}>{view.callout.left}</Text>
          {view.callout.rest}
        </Text>
      ) : null}
      <Periods periods={view.periods} />
      {view.windows.length > 0 ? (
        <>
          <SectionHeading>{view.windowsTitle}</SectionHeading>
          {view.windows.map((w) => (
            <View key={w.label} style={{ paddingTop: 7, paddingBottom: 2 }}>
              <View style={{ flexDirection: "row", alignItems: "baseline" }}>
                <Text style={{ fontSize: 14.5, fontWeight: "600", color: color.t1, letterSpacing: -0.15 }}>
                  {w.label}
                </Text>
                <Text style={{ fontSize: 13, color: color.t2, marginLeft: 8, fontVariant: ["tabular-nums"] }}>
                  {w.used}
                </Text>
                {w.resets ? (
                  <Text style={{ fontSize: 13, color: color.t3, marginLeft: "auto" }}>{w.resets}</Text>
                ) : null}
              </View>
              <View
                style={{
                  flexDirection: "row",
                  height: 6,
                  borderRadius: 3,
                  overflow: "hidden",
                  backgroundColor: "rgba(255,255,255,0.09)",
                  gap: 2,
                  marginTop: 9
                }}
              >
                <View style={{ width: `${w.project * 100}%`, backgroundColor: w.nearLimit ? color.need : color.t1 }} />
                <View style={{ width: `${w.others * 100}%`, backgroundColor: "rgba(255,255,255,0.32)" }} />
              </View>
            </View>
          ))}
        </>
      ) : null}
      {view.projects.length > 0 ? (
        <>
          <SectionHeading>This week, across your projects</SectionHeading>
          {view.projects.map((p) => (
            <ProjectRow key={p.key} row={p} warn={p.current && view.hero?.nearLimit === true} />
          ))}
        </>
      ) : null}
      <Text style={{ fontSize: 12.5, lineHeight: 18, color: color.t3, marginTop: 10 }}>{view.footnote}</Text>
    </>
  )
}

function Hero(props: { readonly hero: NonNullable<SheetView["hero"]>; readonly title: string }) {
  const { hero } = props
  const row = (swatch: string, label: string, value: string, warn = false) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: swatch }} />
      <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: color.t2 }}>
        {label}
      </Text>
      <Text
        style={{
          fontSize: 14,
          fontWeight: "600",
          color: warn ? color.need : color.t1,
          paddingLeft: 14,
          fontVariant: ["tabular-nums"]
        }}
      >
        {value}
      </Text>
    </View>
  )
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 20, marginTop: 16, marginBottom: 2 }}>
      <View style={{ width: 118, height: 118 }}>
        <Ring size={118} stroke={14} arcs={hero.arcs} warn={hero.nearLimit} />
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <Text
            style={{
              fontSize: 28,
              lineHeight: 30,
              fontWeight: "700",
              letterSpacing: tracking(-0.04, 28),
              color: color.t1,
              fontVariant: ["tabular-nums"]
            }}
          >
            {hero.share}
          </Text>
          <Text style={{ fontSize: 12, color: color.t3, marginTop: 3 }}>of your week</Text>
        </View>
      </View>
      <View style={{ flex: 1, gap: 9, maxWidth: 190 }}>
        {row(hero.nearLimit ? color.need : color.t1, props.title, hero.legend.project)}
        {row(others, "Everything else", hero.legend.others)}
        {row(track, "Left", hero.legend.left, hero.nearLimit)}
        <Text style={{ fontSize: 12.5, color: color.t3 }}>Shares are estimates</Text>
      </View>
    </View>
  )
}

function Periods(props: { readonly periods: SheetView["periods"] }) {
  return (
    <View
      style={{
        flexDirection: "row",
        marginTop: 16,
        borderWidth: 1,
        borderColor: color.line,
        borderRadius: 18,
        borderCurve: "continuous",
        backgroundColor: color.bg
      }}
    >
      {props.periods.map((p, i) => (
        <View
          key={p.label}
          style={{
            flex: 1,
            paddingTop: 9,
            paddingBottom: 10,
            paddingHorizontal: 12,
            borderLeftWidth: i === 0 ? 0 : 1,
            borderColor: color.line
          }}
        >
          <Text numberOfLines={1} style={{ fontSize: 12, color: color.t3 }}>
            {p.label}
          </Text>
          <Text
            style={{
              fontSize: 17,
              fontWeight: "600",
              letterSpacing: tracking(-0.025, 17),
              marginTop: 3,
              color: p.value === "—" ? color.t3 : color.t1,
              fontVariant: ["tabular-nums"]
            }}
          >
            {p.value}
          </Text>
          {p.detail ? (
            <Text numberOfLines={1} adjustsFontSizeToFit style={{ fontSize: 12.5, color: color.t2, marginTop: 1 }}>
              {p.detail}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  )
}

function SectionHeading(props: { readonly children: string }) {
  return (
    <Text
      style={{
        fontSize: 13,
        fontWeight: "600",
        color: color.t3,
        marginTop: 16,
        marginBottom: 2,
        letterSpacing: tracking(0.01, 13)
      }}
    >
      {props.children}
    </Text>
  )
}

function ProjectRow(props: { readonly row: SheetView["projects"][number]; readonly warn: boolean }) {
  const { row } = props
  const tint = row.current ? color.t1 : color.t2
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 }}>
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 7,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: row.outside ? "transparent" : color.s2,
          borderWidth: 1,
          borderStyle: row.outside ? "dashed" : "solid",
          borderColor: row.outside ? color.line2 : color.line
        }}
      >
        <SymbolView
          name={(row.outside ? "globe" : symbolOr(row.icon)) as SymbolViewProps["name"]}
          size={13}
          tintColor={color.t2}
          weight="medium"
          style={{ width: 13, height: 13 }}
        />
      </View>
      <Text
        numberOfLines={1}
        style={{
          width: 112,
          fontSize: 14.5,
          letterSpacing: -0.15,
          color: tint,
          fontWeight: row.current ? "600" : "400"
        }}
      >
        {row.title}
      </Text>
      <View
        style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.07)", overflow: "hidden" }}
      >
        <View
          style={{
            width: `${row.bar * 100}%`,
            height: "100%",
            borderRadius: 3,
            backgroundColor: props.warn ? color.need : row.current ? color.t1 : "rgba(255,255,255,0.32)"
          }}
        />
      </View>
      <Text
        style={{
          width: 44,
          textAlign: "right",
          fontSize: 13.5,
          color: tint,
          fontWeight: row.current ? "600" : "400",
          fontVariant: ["tabular-nums"]
        }}
      >
        {row.share}
      </Text>
    </View>
  )
}

/** Agents name icons with SF Symbols, or sometimes an emoji, which a symbol view can't draw. */
const symbolOr = (icon: string | undefined) => (icon && /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(icon) ? icon : "sparkle")
