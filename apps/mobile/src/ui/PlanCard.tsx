/**
 * Settings' plan card (Deck v3, usage in Settings option B, mocks/screens/usage-settings B3/B4): the subscription,
 * what's left of its week, the five-hour and week bars with all their projects in white, and each project's share
 * of the week, drawn with the usage sheet's own pieces. Near the limit the border, bars and callout turn amber.
 */
import type { ModelConnection } from "@dream/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { DateTime, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useEffect } from "react"
import { Text, View } from "react-native"
import { planCard } from "../data/usage.ts"
import { accountUsageAtom } from "../state/atoms.ts"
import { Icon, IconButton } from "./kit.tsx"
import { usePlanMenu } from "./Plans.tsx"
import { color } from "./theme.ts"
import { Footnote, LimitCallout, SectionHeading, ShareRow, WindowBar } from "./Usage.tsx"

export function PlanCard(props: {
  readonly connection: ModelConnection
  /** Opens its menu, or the Remove warning, on arrival (`/settings?plan=menu:claude`, `remove:claude`). */
  readonly show?: "menu" | "remove" | undefined
}) {
  const menu = usePlanMenu(props.connection)
  useEffect(() => {
    if (props.show === undefined) return
    const id = setTimeout(props.show === "menu" ? menu.open : menu.remove, 900)
    return () => clearTimeout(id)
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const atom = accountUsageAtom(props.connection.provider)
  const result = useAtomValue(atom)
  // Fetched again each time Settings opens, so the shares are as fresh as the connection's own usage.
  const refresh = useAtomRefresh(atom)
  useEffect(() => refresh(), [refresh])
  const account = Option.getOrUndefined(AsyncResult.value(result))
  const card = planCard(props.connection, account, DateTime.nowUnsafe())
  const focusColor = card.nearLimit ? color.need : color.t1
  return (
    <View
      style={{
        marginTop: 6,
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 14,
        borderRadius: 22,
        borderCurve: "continuous",
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: card.nearLimit ? color.needLine : color.line
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 4 }}>
        <Icon name="spark" size={19} color={color.t2} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: color.t1 }}>{card.title}</Text>
          <Text style={{ fontSize: 13.5, lineHeight: 19, color: card.nearLimit ? color.need : color.t2, marginTop: 2 }}>
            {card.detail}
          </Text>
        </View>
        <IconButton
          icon="dots"
          size={34}
          tone="quiet"
          label={`${card.title} options`}
          busy={menu.busy}
          onPress={menu.open}
        />
      </View>
      {card.callout ? <LimitCallout callout={card.callout} /> : null}
      {card.windows.length > 0 ? <View style={{ height: 6 }} /> : null}
      {card.windows.map((w) => (
        <WindowBar key={w.label} bar={w} focusColor={focusColor} />
      ))}
      {card.projects.length > 0 ? (
        <>
          <SectionHeading>This week, across your projects</SectionHeading>
          {card.projects.map((p) => (
            <ShareRow key={p.key} row={p} focusColor={focusColor} />
          ))}
        </>
      ) : null}
      {card.footnote ? <Footnote>{card.footnote}</Footnote> : null}
    </View>
  )
}
