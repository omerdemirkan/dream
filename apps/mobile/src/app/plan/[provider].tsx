/**
 * A plan's week, project by project: what the plan card's "See more" opens. The week's bar, then every project's
 * share with its whole name (the deleted ones together), Outside Dream's, and the footnote. Settings' own header,
 * so back (or the edge swipe) returns to it.
 */
import { type ModelConnection, ModelProvider } from "@dream/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { DateTime, Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useEffect } from "react"
import { ActivityIndicator, ScrollView, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { providerName } from "../../data/format.ts"
import { planCard } from "../../data/usage.ts"
import { accountUsageAtom, modelConnectionsAtom } from "../../state/atoms.ts"
import { IconButton } from "../../ui/kit.tsx"
import { color, gutter } from "../../ui/theme.ts"
import { Footnote, SectionHeading, ShareRow, WindowBar } from "../../ui/Usage.tsx"

export default function PlanBreakdown() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ provider?: string }>()
  const provider = Option.getOrElse(Schema.decodeUnknownOption(ModelProvider)(params.provider), () => "claude" as const)
  const connection = Option.getOrElse(
    AsyncResult.value(useAtomValue(modelConnectionsAtom)),
    (): ReadonlyArray<ModelConnection> => []
  ).find((c) => c.provider === provider && c.status === "connected")
  const atom = accountUsageAtom(provider)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  useEffect(() => refresh(), [refresh])
  const account = Option.getOrUndefined(AsyncResult.value(result))
  const card = connection ? planCard(connection, account, DateTime.nowUnsafe()) : undefined
  const focusColor = card?.nearLimit ? color.need : color.t1
  const week = card?.windows.find((w) => w.label === "Week")
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: color.bg }}
      contentContainerStyle={{
        paddingTop: insets.top + 4,
        paddingHorizontal: gutter,
        paddingBottom: insets.bottom + 40
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 44 }}>
        <IconButton icon="back" label="Back" onPress={() => router.back()} />
        <Text style={{ fontSize: 15, fontWeight: "600", color: color.t2 }}>
          {card?.title ?? providerName(provider)}
        </Text>
        <View style={{ width: 40 }} />
      </View>
      {card && card.projects.length > 0 ? (
        <>
          {week ? (
            <View style={{ marginTop: 14 }}>
              <WindowBar bar={week} focusColor={focusColor} />
            </View>
          ) : null}
          <SectionHeading>This week, across your projects</SectionHeading>
          {card.projects.map((p) => (
            <ShareRow key={p.key} row={p} focusColor={focusColor} wide />
          ))}
          {card.footnote ? <Footnote>{card.footnote}</Footnote> : null}
        </>
      ) : AsyncResult.isInitial(result) || result.waiting ? (
        <ActivityIndicator color={color.t3} style={{ marginTop: 40 }} />
      ) : (
        <Text style={{ fontSize: 14.5, color: color.t2, marginTop: 16 }}>Usage isn’t available right now.</Text>
      )}
    </ScrollView>
  )
}
