/**
 * What Dream pays to run their projects (docs/metering.md, "In the app"): a section at the foot of a project's usage
 * sheet, a card in Settings, and the pieces of the full-screen detail it opens (`app/costs`). Dollars, never the
 * plan's percentages, and drawn so the two don't read as one: a section of its own under a hairline, no rings or
 * window bars. What it says comes from `data/costs.ts`.
 */
import type { ProjectId } from "@dream/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useRouter } from "expo-router"
import { useEffect, useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { type CostRowView, costsTile, type DayBar, projectCostsView, type ShareView } from "../data/costs.ts"
import { accountCostsAtom, projectCostsAtom } from "../state/atoms.ts"
import { Icon, Lab } from "./kit.tsx"
import { color, tracking } from "./theme.ts"
import { Footnote, SectionHeading, ShareIcon } from "./Usage.tsx"

/** The one line under each view of costs, as the plan's part has "Shares are estimates.", and nothing below it. */
export const costsFootnote = "Estimates. None of this comes out of your plan."

// ---------------------------------------------------------------------------
// The usage sheet's section
// ---------------------------------------------------------------------------

/**
 * What Dream paid for this project this month, under the plan's part of the sheet. Fetched when the sheet opens;
 * nothing at all while it loads, if the API can't say, or for a project that hasn't cost anything yet.
 */
export function ProjectCostsSection(props: { readonly projectId: ProjectId }) {
  const atom = projectCostsAtom(props.projectId)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  useEffect(() => refresh(), [refresh])
  const costs = result.waiting ? undefined : Option.getOrUndefined(AsyncResult.value(result))
  const view = costs ? projectCostsView(costs) : undefined
  if (!view) return null
  return (
    <View style={{ marginTop: 26, borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line2 }}>
      <SectionHeading>{view.heading}</SectionHeading>
      <Total total={view.total} aside={view.lastMonth} />
      {view.rows.map((row) => (
        <CostRow key={row.key} row={row} nested={false} />
      ))}
      <Footnote>{costsFootnote}</Footnote>
    </View>
  )
}

/** A big total, with last month beside it. */
export function Total(props: { readonly total: string; readonly aside?: string | undefined; readonly size?: number }) {
  const size = props.size ?? 28
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", marginTop: 6, marginBottom: 6 }}>
      <Text
        style={{
          fontSize: size,
          lineHeight: size * 1.15,
          fontWeight: "700",
          letterSpacing: tracking(-0.04, size),
          color: color.t1,
          fontVariant: ["tabular-nums"]
        }}
      >
        {props.total}
      </Text>
      {props.aside ? (
        <Text style={{ marginLeft: "auto", fontSize: 13, color: color.t3, fontVariant: ["tabular-nums"] }}>
          {props.aside}
        </Text>
      ) : null}
    </View>
  )
}

/** What it paid for, how much of it, and the amount; the AI models under theirs, quieter, when `nested`. */
export function CostRow(props: { readonly row: CostRowView; readonly nested: boolean }) {
  const { row } = props
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingVertical: 6 }}>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 15, letterSpacing: -0.15, color: color.t1 }}>
          {row.title}
        </Text>
        {row.detail ? (
          <Text numberOfLines={1} style={{ flexShrink: 2, fontSize: 13.5, color: color.t3 }}>
            {row.detail}
          </Text>
        ) : null}
        <Text
          style={{
            marginLeft: "auto",
            paddingLeft: 12,
            fontSize: 15,
            fontWeight: "600",
            color: color.t1,
            fontVariant: ["tabular-nums"]
          }}
        >
          {row.amount}
        </Text>
      </View>
      {props.nested
        ? row.models.map((m) => (
            <View
              key={m.key}
              style={{ flexDirection: "row", alignItems: "baseline", gap: 8, paddingLeft: 14, paddingVertical: 3 }}
            >
              <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13.5, color: color.t2 }}>
                {m.title}
              </Text>
              {m.detail ? <Text style={{ fontSize: 12.5, color: color.t3 }}>{m.detail}</Text> : null}
              <Text
                style={{
                  marginLeft: "auto",
                  paddingLeft: 12,
                  fontSize: 13.5,
                  color: color.t2,
                  fontVariant: ["tabular-nums"]
                }}
              >
                {m.amount}
              </Text>
            </View>
          ))
        : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Settings' card
// ---------------------------------------------------------------------------

/**
 * Settings' section: this month's total across their projects, last month's, and the last 30 days small; it opens
 * the detail. Absent
 * until something has cost anything, and against an API without costs.
 */
export function CostsCard() {
  const router = useRouter()
  const result = useAtomValue(accountCostsAtom)
  // Fetched again each time Settings opens.
  const refresh = useAtomRefresh(accountCostsAtom)
  useEffect(() => refresh(), [refresh])
  const costs = Option.getOrUndefined(AsyncResult.value(result))
  if (!costs || (costs.month.lines.length === 0 && costs.lastMonth.usd <= 0)) return null
  const tile = costsTile(costs)
  return (
    // Settings' sections: a quiet label 28 points under the one before.
    <View style={{ marginTop: 28 }}>
      <Lab style={{ marginBottom: 4 }}>What Dream pays</Lab>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Dream paid ${tile.total} ${tile.caption}`}
        accessibilityHint="Shows what it paid for, project by project"
        onPress={() => router.push("/costs")}
        style={({ pressed }) => ({
          marginTop: 6,
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 14,
          borderRadius: 22,
          borderCurve: "continuous",
          backgroundColor: color.s1,
          borderWidth: 1,
          borderColor: color.line,
          opacity: pressed ? 0.7 : 1
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 16 }}>
          <View style={{ flex: 1 }}>
            <Total total={tile.total} size={26} />
            <Text style={{ fontSize: 13.5, lineHeight: 19, color: color.t2 }}>{tile.caption}</Text>
          </View>
          <DayBars days={tile.days} height={36} width={112} />
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            marginTop: 14,
            paddingTop: 12,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderColor: color.line
          }}
        >
          <Text style={{ flex: 1, fontSize: 14.5, color: color.t2 }}>See more</Text>
          <Icon name="chev" size={13} color={color.t3} />
        </View>
      </Pressable>
    </View>
  )
}

// ---------------------------------------------------------------------------
// The 30 days
// ---------------------------------------------------------------------------

/** A bar per day, today last in white. Small and silent in Settings' card. */
export function DayBars(props: {
  readonly days: ReadonlyArray<DayBar>
  readonly height: number
  readonly width?: number
  readonly selected?: number | undefined
}) {
  const last = props.days.length - 1
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        gap: props.width !== undefined && props.width < 200 ? 1.5 : 3,
        height: props.height,
        width: props.width
      }}
      accessible={false}
    >
      {props.days.map((d, i) => (
        <View
          key={d.day}
          style={{
            flex: 1,
            height: Math.max(2, d.height * props.height),
            borderTopLeftRadius: 2,
            borderTopRightRadius: 2,
            backgroundColor:
              d.height === 0
                ? "rgba(255,255,255,0.09)"
                : i === (props.selected ?? last)
                  ? color.t1
                  : "rgba(255,255,255,0.32)"
          }}
        />
      ))}
    </View>
  )
}

/**
 * The detail's chart: the 30 days with what each cost, touched to read a day ("Nov 3 · $1.20"); its first day and
 * today under it.
 */
export function DayChart(props: { readonly days: ReadonlyArray<DayBar> }) {
  const [selected, setSelected] = useState<number | undefined>(undefined)
  const [width, setWidth] = useState(0)
  const { days } = props
  if (days.length === 0) return null
  const pick = (x: number) => {
    if (width <= 0) return
    setSelected(Math.min(days.length - 1, Math.max(0, Math.floor((x / width) * days.length))))
  }
  const shown = selected === undefined ? undefined : days[selected]
  return (
    <View style={{ marginTop: 18 }}>
      <Text
        style={{ fontSize: 13, color: shown ? color.t1 : color.t3, fontVariant: ["tabular-nums"], marginBottom: 10 }}
      >
        {shown ? shown.label : "The last 30 days"}
      </Text>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => pick(e.nativeEvent.locationX)}
        onResponderMove={(e) => pick(e.nativeEvent.locationX)}
        onResponderRelease={() => setSelected(undefined)}
        onResponderTerminate={() => setSelected(undefined)}
        accessible
        accessibilityLabel={`The last 30 days. ${days.map((d) => d.label).join(", ")}`}
      >
        <DayBars days={days} height={72} selected={selected} />
      </View>
      <View style={{ flexDirection: "row", marginTop: 6 }}>
        <Text style={{ fontSize: 12, color: color.t3 }}>{days[0]?.label.split(" · ")[0]}</Text>
        <Text style={{ fontSize: 12, color: color.t3, marginLeft: "auto" }}>Today</Text>
      </View>
    </View>
  )
}

// ---------------------------------------------------------------------------
// Shares: projects, or people for an operator
// ---------------------------------------------------------------------------

/** A project's (or person's) part of the month, whole name over a bar; a project opens its usage sheet. */
export function ShareCostRow(props: {
  readonly row: ShareView
  readonly onPress?: (() => void) | undefined
  /** People have no icon. */
  readonly tile?: boolean
}) {
  const { row } = props
  const content = (
    <>
      {props.tile === false ? null : <ShareIcon row={row} size={30} />}
      <View style={{ flex: 1, gap: 7 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text style={{ flexShrink: 1, fontSize: 15.5, lineHeight: 20, letterSpacing: -0.15, color: color.t1 }}>
            {row.title}
          </Text>
          {row.detail ? (
            <Text numberOfLines={1} style={{ flexShrink: 2, fontSize: 13, color: color.t3 }}>
              {row.detail}
            </Text>
          ) : null}
        </View>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.07)", overflow: "hidden" }}>
          <View
            style={{
              width: `${row.bar * 100}%`,
              height: "100%",
              borderRadius: 3,
              backgroundColor: "rgba(255,255,255,0.32)"
            }}
          />
        </View>
      </View>
      <Text
        style={{
          minWidth: 56,
          textAlign: "right",
          fontSize: 15,
          fontWeight: "600",
          color: color.t1,
          fontVariant: ["tabular-nums"]
        }}
      >
        {row.amount}
      </Text>
    </>
  )
  const style = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.line
  }
  return props.onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens its usage"
      onPress={props.onPress}
      style={({ pressed }) => [style, { opacity: pressed ? 0.6 : 1 }]}
    >
      {content}
    </Pressable>
  ) : (
    <View style={style}>{content}</View>
  )
}
