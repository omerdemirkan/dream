/**
 * A plan's page, from its row in Settings (direction B): what's left of the week in large type and when it resets,
 * the week's bar (their projects in white, the rest in grey), the five hours, each project's share, and the plan's
 * actions at the foot. A plan whose week Dream hasn't seen says "Connected"; a sign-in under way or broken says so,
 * with what it can do. `?show=remove` opens the Remove warning on arrival.
 */
import { type ModelConnection, ModelProvider } from "@dream/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { DateTime, Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useEffect } from "react"
import { ActivityIndicator, Text, View } from "react-native"
import { providerName } from "../../data/format.ts"
import { settingsPlans } from "../../data/plans.ts"
import { type PlanPage, planPage } from "../../data/settings.ts"
import { accountUsageAtom, modelConnectionsAtom } from "../../state/atoms.ts"
import { DetailScreen } from "../../ui/DetailScreen.tsx"
import { ActionRow, AddTile, Group } from "../../ui/Group.tsx"
import { usePlanActions } from "../../ui/Plans.tsx"
import { color, tracking } from "../../ui/theme.ts"
import { Footnote, SectionHeading, ShareRow, WindowBar } from "../../ui/Usage.tsx"

export default function PlanScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ provider?: string; show?: string }>()
  const provider = Option.getOrElse(Schema.decodeUnknownOption(ModelProvider)(params.provider), () => "claude" as const)
  const connections = useAtomValue(modelConnectionsAtom)
  const connection = settingsPlans(
    Option.getOrElse(AsyncResult.value(connections), (): ReadonlyArray<ModelConnection> => [])
  ).shown.find((c) => c.provider === provider)
  const atom = accountUsageAtom(provider)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  const connected = connection?.status === "connected"
  useEffect(() => {
    if (connected) refresh()
  }, [connected, refresh])
  const account = connected ? Option.getOrUndefined(AsyncResult.value(result)) : undefined
  if (!connection)
    return (
      <DetailScreen title={providerName(provider)}>
        {AsyncResult.isInitial(connections) ? (
          <ActivityIndicator color={color.t3} style={{ marginTop: 40 }} />
        ) : (
          <>
            <Text style={{ fontSize: 15, lineHeight: 21, color: color.t2, marginBottom: 16 }}>
              {`${providerName(provider)} isn’t connected.`}
            </Text>
            <AddTile
              title={`Add ${providerName(provider)}`}
              onPress={() => router.replace({ pathname: "/connect", params: { provider } })}
            />
          </>
        )}
      </DetailScreen>
    )
  const page = planPage(connection, account, DateTime.nowUnsafe())
  return (
    <DetailScreen title={page.title}>
      <Plan page={page} connection={connection} showRemove={params.show === "remove"} />
    </DetailScreen>
  )
}

function Plan(props: { readonly page: PlanPage; readonly connection: ModelConnection; readonly showRemove: boolean }) {
  const router = useRouter()
  const { page } = props
  const actions = usePlanActions(props.connection, () => router.back())
  // Only on arrival.
  useEffect(() => {
    if (!props.showRemove || page.actions === "pending") return
    const id = setTimeout(actions.remove, 900)
    return () => clearTimeout(id)
  }, [])
  const card = page.card
  const focusColor = page.headline.need ? color.need : color.t1
  const name = providerName(props.connection.provider)
  const big = page.headline.rest !== undefined
  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", columnGap: 8, marginTop: 4 }}>
        <Text
          accessibilityRole="header"
          style={{
            fontSize: big ? 44 : 28,
            lineHeight: big ? 50 : 34,
            fontWeight: "700",
            letterSpacing: tracking(-0.04, big ? 44 : 28),
            color: page.headline.need ? color.need : color.t1,
            fontVariant: ["tabular-nums"]
          }}
        >
          {page.headline.big}
        </Text>
        {page.headline.rest ? <Text style={{ fontSize: 16, color: color.t2 }}>{page.headline.rest}</Text> : null}
      </View>
      {page.resets ? <Text style={{ fontSize: 14, color: color.t3, marginTop: 4 }}>{page.resets}</Text> : null}
      {page.about ? (
        <Text style={{ fontSize: 15, lineHeight: 21.5, color: color.t2, marginTop: 8 }}>{page.about}</Text>
      ) : null}

      {page.week ? (
        <View style={{ marginTop: 18 }}>
          <View
            style={{
              flexDirection: "row",
              gap: 2,
              height: 8,
              borderRadius: 4,
              overflow: "hidden",
              backgroundColor: "rgba(255,255,255,0.09)"
            }}
          >
            <View style={{ width: `${page.week.focus * 100}%`, backgroundColor: focusColor }} />
            <View style={{ width: `${page.week.others * 100}%`, backgroundColor: "rgba(255,255,255,0.32)" }} />
          </View>
          {page.legend ? (
            <View style={{ flexDirection: "row", gap: 16, marginTop: 10 }}>
              <Legend tint={focusColor} label={page.legend.projects} />
              <Legend tint="rgba(255,255,255,0.38)" label={page.legend.outside} />
            </View>
          ) : null}
        </View>
      ) : null}
      {card && card.windows.length > 0 ? (
        <View style={{ marginTop: 14 }}>
          {card.windows.map((w) => (
            <WindowBar key={w.label} bar={w} focusColor={focusColor} />
          ))}
        </View>
      ) : null}

      {card && card.projects.length > 0 ? (
        <View style={{ marginTop: 12 }}>
          <SectionHeading>This week, by project</SectionHeading>
          {card.projects.map((p) => (
            <ShareRow key={p.key} row={p} focusColor={focusColor} wide />
          ))}
          {card.footnote ? <Footnote>{card.footnote}</Footnote> : null}
        </View>
      ) : null}

      <Group style={{ marginTop: 30 }}>
        {page.actions === "pending" ? (
          <ActionRow title="Cancel sign-in" busy={actions.busy} onPress={actions.cancel} />
        ) : null}
        {page.actions !== "pending" ? (
          <ActionRow
            title="Reconnect"
            subtitle={page.actions === "broken" ? "Sign in again" : "Sign in again, or with another account"}
            onPress={actions.reconnect}
          />
        ) : null}
        {page.actions !== "pending" ? (
          <ActionRow title={`Remove ${name}`} busy={actions.busy} onPress={actions.remove} />
        ) : null}
      </Group>
    </>
  )
}

function Legend(props: { readonly tint: string; readonly label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: props.tint }} />
      <Text style={{ fontSize: 12.5, color: color.t3, fontVariant: ["tabular-nums"] }}>{props.label}</Text>
    </View>
  )
}
