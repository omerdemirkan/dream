/**
 * Settings (direction B, mocks/screens/settings-directions): a short index of one-line rows, each with its answer on
 * the right, and every row opens a page built the same way. The plans with what's left of each week, Dream usage
 * this month, the connected services, archived projects and the account, then a restart when an update waits and
 * the version.
 */
import type { ArchivedProject, Integration, ModelConnection, ModelProvider } from "@dream/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import * as Application from "expo-application"
import { DateTime, Effect, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useRouter } from "expo-router"
import { useUpdates } from "expo-updates"
import { useEffect } from "react"
import { ScrollView, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { providerName } from "../data/format.ts"
import { settingsPlans } from "../data/plans.ts"
import { accountView, costsRow, planRow, serviceRow } from "../data/settings.ts"
import { applyUpdate, runningUpdate } from "../platform/updates.ts"
import {
  accountCostsAtom,
  accountUsageAtom,
  archivedProjectsAtom,
  integrationsAtom,
  modelConnectionsAtom,
  sessionAtom
} from "../state/atoms.ts"
import { appConfig } from "../state/runtime.ts"
import { AddTile, Group, GroupFooter, GroupRow, PlanMark, RowTile, SectionLabel, ServiceMark } from "../ui/Group.tsx"
import { Icon, IconButton } from "../ui/kit.tsx"
import { color, gutter } from "../ui/theme.ts"
import { UsageRing } from "../ui/Usage.tsx"

const tiers = { claude: "Pro or Max", chatgpt: "Plus or Pro" } as const

export default function Settings() {
  const router = useRouter()
  const { isUpdatePending } = useUpdates()
  const update = runningUpdate()
  const insets = useSafeAreaInsets()
  const session = Option.getOrUndefined(Option.flatten(AsyncResult.value(useAtomValue(sessionAtom))))
  const connections = Option.getOrElse(
    AsyncResult.value(useAtomValue(modelConnectionsAtom)),
    (): ReadonlyArray<ModelConnection> => []
  )
  const integrations = Option.getOrElse(
    AsyncResult.value(useAtomValue(integrationsAtom)),
    (): ReadonlyArray<Integration> => []
  )
  const archived = Option.getOrElse(
    AsyncResult.value(useAtomValue(archivedProjectsAtom)),
    (): ReadonlyArray<ArchivedProject> => []
  )
  const plans = settingsPlans(connections)
  const account = accountView(session?.user)
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
        <Text accessibilityRole="header" style={{ fontSize: 15, fontWeight: "600", color: color.t2 }}>
          Settings
        </Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={{ height: 4 }} />
      <SectionLabel>Subscription usage</SectionLabel>
      <Plans shown={plans.shown} />
      {plans.addable.map((provider) => (
        <AddTile
          key={provider}
          title={`Add ${providerName(provider)}`}
          detail={tiers[provider]}
          onPress={() => router.push({ pathname: "/connect", params: { provider } })}
          style={{ marginTop: plans.shown.length > 0 || provider !== plans.addable[0] ? 10 : 0 }}
        />
      ))}

      <DreamUsage />

      <SectionLabel>Connected services</SectionLabel>
      {integrations.length === 0 ? (
        <GroupFooter>
          Nothing yet. When a project needs a service, it asks, and what you connect works for every project.
        </GroupFooter>
      ) : (
        <Group>
          {integrations.map((integration) => {
            const row = serviceRow(integration)
            return (
              <GroupRow
                key={integration.id}
                icon={<ServiceMark icon={row.icon} />}
                title={row.title}
                value={row.value}
                need={row.need}
                onPress={() => router.push({ pathname: "/service/[id]", params: { id: integration.id } })}
              />
            )
          })}
        </Group>
      )}

      <Group style={{ marginTop: 22 }}>
        {archived.length > 0 ? (
          <GroupRow title="Archived projects" value={`${archived.length}`} onPress={() => router.push("/archived")} />
        ) : null}
        <GroupRow title={account.title} subtitle={account.subtitle} onPress={() => router.push("/account")} />
      </Group>

      {isUpdatePending || appConfig.backend === "fixtures" ? (
        <Group style={{ marginTop: 12 }}>
          {isUpdatePending ? (
            <GroupRow
              title="Restart to update Dream"
              value={<View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color.t1 }} />}
              onPress={() => void Effect.runPromise(applyUpdate.pipe(Effect.ignore))}
              chevron={false}
              accessibilityLabel="Restart to update Dream"
            />
          ) : null}
          {appConfig.backend === "fixtures" ? (
            <GroupRow title="Sample screens" onPress={() => router.push("/fixtures")} />
          ) : null}
        </Group>
      ) : null}

      <Text style={{ marginTop: 18, fontSize: 12, lineHeight: 18, color: color.t3, textAlign: "center" }}>
        Dream {Application.nativeApplicationVersion ?? ""} ·{" "}
        {appConfig.backend === "fixtures" ? "sample projects" : appConfig.apiUrl.replace(/^https?:\/\//, "")}
        {update === undefined
          ? ""
          : `\nUpdate ${update.id.slice(0, 8)} · ${update.createdAt.toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit"
            })}`}
      </Text>
    </ScrollView>
  )
}

/** The plans, one row each, with what a nearly used week means under them. */
function Plans(props: { readonly shown: ReadonlyArray<ModelConnection> }) {
  const accounts = { claude: useAccountUsage("claude", props.shown), chatgpt: useAccountUsage("chatgpt", props.shown) }
  const now = DateTime.nowUnsafe()
  const rows = props.shown.map((connection) => ({
    connection,
    row: planRow(connection, connection.status === "connected" ? accounts[connection.provider] : undefined, now)
  }))
  if (rows.length === 0) return null
  const notes = rows.flatMap(({ row }) => (row.note ? [row.note] : []))
  return (
    <>
      <Group need={rows.some(({ row }) => row.need)}>
        {rows.map(({ connection, row }) => (
          <PlanLine key={connection.id} connection={connection} row={row} />
        ))}
      </Group>
      {notes.map((note) => (
        <GroupFooter key={note} strong>
          {note}
        </GroupFooter>
      ))}
    </>
  )
}

/** A plan's split of the week, while it's connected; fetched again each time Settings opens. */
function useAccountUsage(provider: ModelProvider, shown: ReadonlyArray<ModelConnection>) {
  const connected = shown.some((c) => c.provider === provider && c.status === "connected")
  const atom = accountUsageAtom(provider)
  const result = useAtomValue(atom)
  const refresh = useAtomRefresh(atom)
  useEffect(() => {
    if (connected) refresh()
  }, [connected, refresh])
  return connected ? Option.getOrUndefined(AsyncResult.value(result)) : undefined
}

function PlanLine(props: { readonly connection: ModelConnection; readonly row: ReturnType<typeof planRow> }) {
  const router = useRouter()
  const { row } = props
  return (
    <GroupRow
      icon={<PlanMark provider={props.connection.provider} />}
      title={row.title}
      value={
        <>
          <Text
            numberOfLines={1}
            style={{
              fontSize: 15,
              color: row.need ? color.need : color.t2,
              fontVariant: ["tabular-nums"],
              flexShrink: 1
            }}
          >
            {row.value}
          </Text>
          {row.ring ? (
            <UsageRing size={20} stroke={3} arcs={row.ring} focusColor={row.need ? color.need : color.t1} />
          ) : null}
        </>
      }
      accessibilityLabel={`${row.title}, ${row.value}`}
      onPress={() => router.push({ pathname: "/plan/[provider]", params: { provider: props.connection.provider } })}
    />
  )
}

/** This month so far; absent while it loads and against an API without costs. */
function DreamUsage() {
  const router = useRouter()
  const result = useAtomValue(accountCostsAtom)
  // Fetched again each time Settings opens.
  const refresh = useAtomRefresh(accountCostsAtom)
  useEffect(() => refresh(), [refresh])
  const row = costsRow(Option.getOrUndefined(AsyncResult.value(result)))
  if (!row) return null
  return (
    <>
      <SectionLabel>Dream usage</SectionLabel>
      <Group>
        <GroupRow
          icon={
            <RowTile>
              <Icon name="cpu" size={16} color={color.t2} />
            </RowTile>
          }
          title={row.title}
          value={row.value}
          strong={row.value !== "Nothing yet"}
          onPress={row.opens ? () => router.push("/costs") : undefined}
          accessibilityHint="Shows what Dream paid for, project by project"
        />
      </Group>
    </>
  )
}
