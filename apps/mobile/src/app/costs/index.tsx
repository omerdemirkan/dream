/**
 * What Dream pays to run their projects, in full: what Settings' costs card opens. This month's total and last
 * month's, the 30 days, what it paid for (OpenAI by model), the projects largest first (each opens its
 * usage sheet), and for an operator a way into everyone's. Settings' own header, so back
 * (or the edge swipe) returns to it.
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useRouter } from "expo-router"
import { useEffect } from "react"
import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native"
import { accountCostsView } from "../../data/costs.ts"
import { accountCostsAtom } from "../../state/atoms.ts"
import { CostRow, costsFootnote, DayChart, ShareCostRow, Total } from "../../ui/Costs.tsx"
import { Icon } from "../../ui/kit.tsx"
import { color } from "../../ui/theme.ts"
import { Footnote, SectionHeading } from "../../ui/Usage.tsx"
import { DetailScreen } from "../../ui/DetailScreen.tsx"

export default function CostsDetail() {
  const router = useRouter()
  const result = useAtomValue(accountCostsAtom)
  const refresh = useAtomRefresh(accountCostsAtom)
  useEffect(() => refresh(), [refresh])
  const costs = Option.getOrUndefined(AsyncResult.value(result))
  const view = costs ? accountCostsView(costs) : undefined
  return (
    <DetailScreen title="What Dream pays">
      {view ? (
        <>
          <Total total={view.total} size={34} />
          <Text style={{ fontSize: 14, color: color.t2 }}>{view.caption}</Text>
          {view.rows.length === 0 ? (
            <Text style={{ fontSize: 14.5, color: color.t2, marginTop: 16 }}>Nothing yet this month.</Text>
          ) : (
            <>
              <DayChart days={view.days} />
              <SectionHeading>What it paid for</SectionHeading>
              {view.rows.map((row) => (
                <CostRow key={row.key} row={row} nested />
              ))}
            </>
          )}
          {view.projects.length > 0 ? (
            <>
              <SectionHeading>By project</SectionHeading>
              {view.projects.map((p) => (
                <ShareCostRow
                  key={p.key}
                  row={p}
                  onPress={
                    p.projectId
                      ? () =>
                          router.push({ pathname: "/project/[id]", params: { id: p.projectId ?? "", sheet: "usage" } })
                      : undefined
                  }
                />
              ))}
            </>
          ) : null}
          {view.everyone ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push("/costs/everyone")}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                marginTop: 24,
                paddingVertical: 13,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderColor: color.line,
                opacity: pressed ? 0.6 : 1
              })}
            >
              <Text style={{ flex: 1, fontSize: 15, color: color.t2 }}>Everyone on this Dream</Text>
              <Icon name="chev" size={13} color={color.t3} />
            </Pressable>
          ) : null}
          <Footnote>{costsFootnote}</Footnote>
        </>
      ) : AsyncResult.isInitial(result) || result.waiting ? (
        <ActivityIndicator color={color.t3} style={{ marginTop: 40 }} />
      ) : (
        <Text style={{ fontSize: 14.5, color: color.t2, marginTop: 16 }}>Costs aren’t available right now.</Text>
      )}
    </DetailScreen>
  )
}
