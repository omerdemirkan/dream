/**
 * Project usage, Deck v3 option A: a small ring of the subscription's week on the right of the project header
 * (this project's share, everything else, what's left), which opens the usage sheet (`UsageSheet.tsx`). What they
 * say comes from `data/usage.ts`; sizes and colours follow mocks/screens/project-usage (`.hr-u.ring`). Its pieces
 * (UsageRing, LimitField, WindowBar, ShareRow, LimitCallout, Footnote, SectionHeading) also draw the sheet and a
 * plan's page from Settings (`app/plan/[provider].tsx`), each taking the colour of what's in focus: white, or amber
 * near the limit.
 */
import type { ProjectId, UsageLimitReached } from "@dream/domain"
import { useAtomValue } from "@effect/atom-react"
import { useEffect, useRef, useState } from "react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { SymbolView, type SymbolViewProps } from "expo-symbols"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import Svg, { Circle, G } from "react-native-svg"
import {
  type LimitRow,
  parseLimit,
  type RingArcs,
  type ShareRowView,
  usageBadge,
  type WindowBarView
} from "../data/usage.ts"
import { usageGlanceAtom } from "../state/atoms.ts"
import { color, tracking } from "./theme.ts"

const others = "rgba(255,255,255,0.34)"
const track = "rgba(255,255,255,0.12)"

/**
 * A ring of arcs over a faint track, starting at twelve o'clock: the part in focus (this project) in `focusColor`
 * (white, or amber near the limit), then everything else's in grey.
 */
export function UsageRing(props: {
  readonly size: number
  readonly stroke: number
  readonly arcs: RingArcs
  readonly focusColor: string
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
        {arc(arcs.project, 0, props.focusColor)}
        {arc(arcs.others, arcs.project, others)}
      </G>
    </Svg>
  )
}

/**
 * The header's right side: the ring and "4%" over "of week", or nothing while no usage is known; "paused" in amber
 * while a limit they set holds the project.
 */
export function UsageBadge(props: {
  readonly projectId: ProjectId
  readonly pausedBy?: UsageLimitReached | undefined
  readonly onPress: () => void
}) {
  const glance = Option.getOrUndefined(AsyncResult.value(useAtomValue(usageGlanceAtom(props.projectId))))
  const badge = usageBadge(glance, props.pausedBy)
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
      <UsageRing size={26} stroke={4} arcs={badge.arcs} focusColor={badge.nearLimit ? color.need : color.t1} />
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

/**
 * One limit as a sentence with a field in it: "This project may use up to [25]% of the week". Empty means no limit;
 * what they type is saved when the field loses focus (tapping elsewhere, scrolling, closing the sheet).
 */
export function LimitField(props: {
  readonly before: string
  readonly after: string
  readonly label: string
  readonly row: LimitRow
  readonly onChange: (value: number | undefined) => void
}) {
  const { row } = props
  const shown = row.value === undefined ? "" : String(row.value)
  const [text, setText] = useState(shown)
  const editing = useRef(false)
  // A saved value, or one from a fresh fetch, replaces what's shown unless they're typing.
  useEffect(() => {
    if (!editing.current) setText(shown)
  }, [shown])
  const tint = row.reached ? color.need : color.t1
  const commit = () => {
    editing.current = false
    const value = parseLimit(text)
    setText(value === undefined ? "" : String(value))
    props.onChange(value)
  }
  // Closing the sheet mid-edit unmounts the field before it hears it lost focus: save what was typed then.
  const latest = useRef({ text, value: row.value, onChange: props.onChange })
  latest.current = { text, value: row.value, onChange: props.onChange }
  useEffect(
    () => () => {
      if (!editing.current) return
      const value = parseLimit(latest.current.text)
      if (value !== latest.current.value) latest.current.onChange(value)
    },
    []
  )
  return (
    <View style={{ paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: color.line }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", rowGap: 6 }}>
        <Text style={{ fontSize: 15, color: color.t1, letterSpacing: -0.15 }}>{props.before} </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            height: 32,
            paddingHorizontal: 10,
            borderRadius: 10,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: row.reached ? color.needLine : color.line2,
            backgroundColor: row.reached ? color.needBg : color.s2
          }}
        >
          <TextInput
            value={text}
            onChangeText={setText}
            onFocus={() => {
              editing.current = true
            }}
            onBlur={commit}
            onSubmitEditing={commit}
            placeholder="Off"
            placeholderTextColor={color.t3}
            keyboardType="number-pad"
            returnKeyType="done"
            maxLength={2}
            selectTextOnFocus
            accessibilityLabel={props.label}
            style={{
              minWidth: 22,
              fontSize: 15,
              fontWeight: "600",
              color: tint,
              textAlign: "right",
              fontVariant: ["tabular-nums"],
              padding: 0
            }}
          />
          {text === "" ? null : <Text style={{ fontSize: 15, fontWeight: "600", color: tint }}>%</Text>}
        </View>
        <Text style={{ fontSize: 15, color: color.t1, letterSpacing: -0.15 }}> {props.after}</Text>
      </View>
      {row.note ? (
        <Text style={{ fontSize: 13, color: row.reached ? color.need : color.t3, marginTop: 5 }}>{row.note}</Text>
      ) : null}
    </View>
  )
}

/**
 * One window: its name, how full it is and when it resets, over a bar of the part in focus (this project, or all
 * their projects) in `focusColor`, then everything else's in grey.
 */
export function WindowBar(props: { readonly bar: WindowBarView; readonly focusColor: string }) {
  const w = props.bar
  return (
    <View style={{ paddingTop: 7, paddingBottom: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline" }}>
        <Text style={{ fontSize: 14.5, fontWeight: "600", color: color.t1, letterSpacing: -0.15 }}>{w.label}</Text>
        <Text style={{ fontSize: 13, color: color.t2, marginLeft: 8, fontVariant: ["tabular-nums"] }}>{w.used}</Text>
        {w.resets ? <Text style={{ fontSize: 13, color: color.t3, marginLeft: "auto" }}>{w.resets}</Text> : null}
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
        <View style={{ width: `${w.focus * 100}%`, backgroundColor: props.focusColor }} />
        <View style={{ width: `${w.others * 100}%`, backgroundColor: "rgba(255,255,255,0.32)" }} />
      </View>
    </View>
  )
}

/** Near the limit: "8% of your week is left" in amber, then until when and what happens. */
export function LimitCallout(props: { readonly callout: { readonly left: string; readonly rest: string } }) {
  return (
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
      <Text style={{ color: color.need, fontWeight: "600" }}>{props.callout.left}</Text>
      {props.callout.rest}
    </Text>
  )
}

/** What the figures rest on: exact tokens, estimated shares. */
export function Footnote(props: { readonly children: string }) {
  return <Text style={{ fontSize: 12.5, lineHeight: 18, color: color.t3, marginTop: 10 }}>{props.children}</Text>
}

/** A quiet heading over a group: "Your ChatGPT Pro", "This week, across your projects". */
export function SectionHeading(props: { readonly children: string }) {
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

/**
 * One project's share of the week (or Outside Dream's): its bar in grey, or in `focusColor` for the project whose
 * sheet this is. `wide`, for the full-screen breakdown: the whole name over its bar, the share on the right.
 */
export function ShareRow(props: { readonly row: ShareRowView; readonly focusColor: string; readonly wide?: boolean }) {
  const { row } = props
  const tint = row.current ? color.t1 : color.t2
  const bar = (
    <View
      style={{
        flex: props.wide ? undefined : 1,
        height: 6,
        borderRadius: 3,
        backgroundColor: "rgba(255,255,255,0.07)",
        overflow: "hidden"
      }}
    >
      <View
        style={{
          width: `${row.bar * 100}%`,
          height: "100%",
          borderRadius: 3,
          backgroundColor: row.current ? props.focusColor : "rgba(255,255,255,0.32)"
        }}
      />
    </View>
  )
  const share = (
    <Text
      style={{
        width: 44,
        textAlign: "right",
        fontSize: props.wide ? 15 : 13.5,
        color: props.wide ? color.t1 : tint,
        fontWeight: row.current || props.wide ? "600" : "400",
        fontVariant: ["tabular-nums"]
      }}
    >
      {row.share}
    </Text>
  )
  if (props.wide)
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingVertical: 12,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderColor: color.line
        }}
      >
        <ShareIcon row={row} size={30} />
        <View style={{ flex: 1, gap: 8 }}>
          <Text style={{ fontSize: 15.5, lineHeight: 20, letterSpacing: -0.15, color: color.t1 }}>{row.title}</Text>
          {bar}
        </View>
        {share}
      </View>
    )
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 }}>
      <ShareIcon row={row} size={24} />
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
      {bar}
      {share}
    </View>
  )
}

/** The project's icon on a tile; Outside Dream's globe on a dashed one (also the cost rows', in `Costs.tsx`). */
export function ShareIcon(props: {
  readonly row: { readonly icon?: string; readonly outside: boolean }
  readonly size: number
}) {
  const { row, size } = props
  const glyph = Math.round(size * 0.54)
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.29),
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
        size={glyph}
        tintColor={color.t2}
        weight="medium"
        style={{ width: glyph, height: glyph }}
      />
    </View>
  )
}

/** Agents name icons with SF Symbols, or sometimes an emoji, which a symbol view can't draw. */
const symbolOr = (icon: string | undefined) => (icon && /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(icon) ? icon : "sparkle")
