/**
 * Settings' grouped lists (Settings direction B): a rounded group of one-line rows, each with its answer on the
 * right and a chevron when it opens a page, a quiet line under a group, and the dashed tile in a row's shape that
 * adds a plan. Settings and every page it opens are built from these.
 */
import type { ModelProvider } from "@dream/domain"
import { Children, createContext, isValidElement, type ReactElement, type ReactNode, useContext } from "react"
import { ActivityIndicator, Pressable, Text, View } from "react-native"
import Svg, { Path } from "react-native-svg"
import type { ServiceIcon } from "../data/settings.ts"
import { Icon } from "./kit.tsx"
import { color } from "./theme.ts"

/** A row is at least this tall; one with a second line grows. */
const rowHeight = 52
/** Where a row's text starts when it has an icon (14 inset + 30 tile + 12 gap): the separators start there. */
const textInset = 56

/** What a pressed row turns: a shade lighter than its group. */
const PressedColor = createContext<string>(color.s2)

/**
 * A rounded group of rows. `raised` lifts it a shade, for a group on a sheet (the sheet is the colour a group
 * usually is).
 */
export function Group(props: {
  readonly children: ReactNode
  readonly need?: boolean
  readonly raised?: boolean
  readonly style?: object
}) {
  const rows = Children.toArray(props.children).filter(isValidElement) as Array<ReactElement<RowProps>>
  return (
    <PressedColor.Provider value={props.raised ? color.s3 : color.s2}>
      <View
        style={[
          {
            backgroundColor: props.raised ? color.s2 : color.s1,
            borderRadius: 20,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: props.need ? color.needLine : color.line,
            overflow: "hidden"
          },
          props.style
        ]}
      >
        {rows.map((row, i) => (
          <View key={row.key ?? i}>
            {i > 0 ? (
              <View
                style={{
                  height: 1,
                  backgroundColor: color.line,
                  marginLeft: row.props.icon ? textInset : 16
                }}
              />
            ) : null}
            {row}
          </View>
        ))}
      </View>
    </PressedColor.Provider>
  )
}

interface RowProps {
  readonly title: string
  readonly subtitle?: string | undefined
  readonly icon?: ReactNode
  /** The answer on the right: a string in the quiet colour, or anything (a ring beside it). */
  readonly value?: ReactNode
  /** The value in amber: something needs them. */
  readonly need?: boolean
  /** The value in white and bold, for a figure ("$44.81"). */
  readonly strong?: boolean
  /** Opens a page: a chevron, and the whole row presses. */
  readonly onPress?: (() => void) | undefined
  /** Whether a row that presses shows the chevron; an action ("Sign out") doesn't, since it opens nothing. */
  readonly chevron?: boolean
  readonly busy?: boolean
  readonly accessibilityLabel?: string | undefined
  readonly accessibilityHint?: string | undefined
}

export function GroupRow(props: RowProps) {
  const pressedColor = useContext(PressedColor)
  const value =
    typeof props.value === "string" ? (
      <Text
        numberOfLines={1}
        style={{
          fontSize: 15,
          color: props.need ? color.need : props.strong ? color.t1 : color.t2,
          fontWeight: props.strong ? "600" : "400",
          fontVariant: ["tabular-nums"],
          flexShrink: 1
        }}
      >
        {props.value}
      </Text>
    ) : (
      props.value
    )
  const content = (pressed: boolean) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: rowHeight,
        paddingHorizontal: 14,
        paddingVertical: props.subtitle ? 9 : 0,
        backgroundColor: pressed ? pressedColor : "transparent"
      }}
    >
      {props.icon}
      <View style={{ flex: 1, paddingLeft: props.icon ? 0 : 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: "500", letterSpacing: -0.16, color: color.t1 }}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text style={{ fontSize: 13.5, lineHeight: 18.5, color: color.t2, marginTop: 1 }}>{props.subtitle}</Text>
        ) : null}
      </View>
      {value ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, maxWidth: "55%" }}>
          {value}
        </View>
      ) : null}
      {props.busy ? <ActivityIndicator size="small" color={color.t3} /> : null}
      {props.onPress && !props.busy && props.chevron !== false ? <Icon name="chev" size={13} color={color.t3} /> : null}
    </View>
  )
  if (!props.onPress) return content(false)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.accessibilityLabel ??
        [props.title, props.subtitle, typeof props.value === "string" ? props.value : undefined]
          .filter(Boolean)
          .join(", ")
      }
      accessibilityHint={props.accessibilityHint}
      disabled={props.busy === true}
      onPress={props.onPress}
    >
      {({ pressed }) => content(pressed)}
    </Pressable>
  )
}

/** An action in a group: a row that's only its words ("Reconnect", "Sign out"). */
export function ActionRow(props: {
  readonly title: string
  readonly subtitle?: string
  readonly onPress: () => void
  readonly busy?: boolean
}) {
  return (
    <GroupRow
      title={props.title}
      subtitle={props.subtitle}
      busy={props.busy ?? false}
      onPress={props.onPress}
      chevron={false}
      accessibilityLabel={props.title}
      accessibilityHint={props.subtitle}
    />
  )
}

/** A quiet line under a group, inset to its rows' text; amber's words stay calm, only the group's border turns. */
export function GroupFooter(props: { readonly children: string; readonly strong?: boolean }) {
  return (
    <Text
      style={{
        fontSize: 12.5,
        lineHeight: 18,
        color: props.strong ? color.t2 : color.t3,
        marginTop: 8,
        marginHorizontal: 16
      }}
    >
      {props.children}
    </Text>
  )
}

/** A section's label, 22 points under the one before. */
export function SectionLabel(props: { readonly children: string }) {
  return (
    <Text
      accessibilityRole="header"
      style={{
        fontSize: 11,
        fontWeight: "600",
        letterSpacing: 0.99,
        textTransform: "uppercase",
        color: color.t3,
        marginTop: 22,
        marginBottom: 9,
        marginHorizontal: 4
      }}
    >
      {props.children}
    </Text>
  )
}

/** Adds what a group lists: the row's outline, dashed, with a plus where its icon goes. */
export function AddTile(props: {
  readonly title: string
  readonly detail?: string
  readonly onPress: () => void
  readonly style?: object
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.title}
      onPress={props.onPress}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          minHeight: rowHeight,
          paddingHorizontal: 14,
          borderRadius: 20,
          borderCurve: "continuous",
          borderWidth: 1.5,
          borderStyle: "dashed",
          borderColor: color.line2,
          backgroundColor: pressed ? color.s1 : "transparent"
        },
        props.style
      ]}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 9,
          borderWidth: 1,
          borderStyle: "dashed",
          borderColor: color.line2,
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        <Icon name="plus" size={15} color={color.t2} />
      </View>
      <Text style={{ flex: 1, fontSize: 16, fontWeight: "500", letterSpacing: -0.16, color: color.t1 }}>
        {props.title}
      </Text>
      {props.detail ? <Text style={{ fontSize: 15, color: color.t3 }}>{props.detail}</Text> : null}
    </Pressable>
  )
}

/** A row's icon on a small tile, in the project tiles' shape. */
export function RowTile(props: { readonly children: ReactNode; readonly size?: number }) {
  const size = props.size ?? 30
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        borderCurve: "continuous",
        backgroundColor: color.s2,
        borderWidth: 1,
        borderColor: color.line,
        alignItems: "center",
        justifyContent: "center"
      }}
    >
      {props.children}
    </View>
  )
}

/** Claude's warm burst and ChatGPT's knot, simplified, so the two plans don't share one sparkle. */
const planInk: Record<ModelProvider, string> = { claude: "#E08A6B", chatgpt: "#E9E9EC" }
const planPath: Record<ModelProvider, string> = {
  claude: "M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18",
  chatgpt: "M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6zM12 8.2l3.3 1.9v3.8L12 15.8l-3.3-1.9v-3.8z"
}

export function PlanMark(props: { readonly provider: ModelProvider; readonly size?: number }) {
  const size = props.size ?? 30
  const glyph = Math.round(size * 0.56)
  return (
    <RowTile size={size}>
      <Svg width={glyph} height={glyph} viewBox="0 0 24 24">
        <Path
          d={planPath[props.provider]}
          stroke={planInk[props.provider]}
          strokeWidth={props.provider === "claude" ? 2.1 : 1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
    </RowTile>
  )
}

const serviceGlyph = { lock: "lock", key: "key", doc: "doc", apple: "apple" } as const

export function ServiceMark(props: { readonly icon: ServiceIcon; readonly size?: number }) {
  const size = props.size ?? 30
  return (
    <RowTile size={size}>
      <Icon name={serviceGlyph[props.icon]} size={Math.round(size * 0.52)} color={color.t2} />
    </RowTile>
  )
}
