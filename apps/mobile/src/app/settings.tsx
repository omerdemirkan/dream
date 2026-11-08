/**
 * Settings: the plans Dream runs on (Claude, ChatGPT or both), the services
 * connected for every project, and the account.
 */
import type { ArchivedProject, Integration, ModelConnection, ProjectId, ProjectSummary } from "@dream/domain"
import { useAtomValue } from "@effect/atom-react"
import * as Application from "expo-application"
import { DateTime, Effect, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useUpdates } from "expo-updates"
import { type ReactNode, useState } from "react"
import { Pressable, ScrollView, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { dayLabel, providerName } from "../data/format.ts"
import { settingsPlans } from "../data/plans.ts"
import {
  archivedProjectsAtom,
  disconnectIntegrationFn,
  disconnectModelConnectionFn,
  integrationsAtom,
  modelConnectionsAtom,
  projectsAtom,
  replaceKeyFn,
  restoreProjectFn,
  sessionAtom,
  signOutFn
} from "../state/atoms.ts"
import { applyUpdate, runningUpdate } from "../platform/updates.ts"
import { appConfig } from "../state/runtime.ts"
import { useAction, useToast } from "../ui/actions.ts"
import { integrationReach, integrationSummary } from "../ui/describe.ts"
import { PlanCard } from "../ui/PlanCard.tsx"
import { AddPlanTile } from "../ui/Plans.tsx"
import { useProjectActions } from "../ui/ProjectMenu.tsx"
import { SecretField } from "../ui/Expanded.tsx"
import { Button, Icon, IconButton, Lab } from "../ui/kit.tsx"
import { color, gutter } from "../ui/theme.ts"

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
  const projects = Option.getOrElse(
    AsyncResult.value(useAtomValue(projectsAtom)),
    (): ReadonlyArray<ProjectSummary> => []
  )
  const archived = Option.getOrElse(
    AsyncResult.value(useAtomValue(archivedProjectsAtom)),
    (): ReadonlyArray<ArchivedProject> => []
  )
  const projectTitle = (id: ProjectId) =>
    (projects.find((summary) => summary.project.id === id) ?? archived.find((row) => row.project.id === id))?.project
      .title
  const plans = settingsPlans(connections)
  const params = useLocalSearchParams<{ plan?: string }>()
  const [show, showFor] = (params.plan ?? "").split(":")
  const signOut = useAction(signOutFn)
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
        <Text style={{ fontSize: 15, fontWeight: "600", color: color.t2 }}>Settings</Text>
        <View style={{ width: 40 }} />
      </View>

      <Section title={plans.connected.length > 1 ? "Plans" : "Plan"}>
        {plans.shown.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            show={showFor === connection.provider && (show === "menu" || show === "remove") ? show : undefined}
          />
        ))}
        {plans.addable.map((provider) => (
          <AddPlanTile key={provider} provider={provider} />
        ))}
      </Section>

      <Section title="Connected services">
        {integrations.length === 0 ? (
          <Text style={{ fontSize: 14, lineHeight: 20, color: color.t2, paddingVertical: 12 }}>
            Nothing yet. When a project needs a service, it asks, and what you connect works for every project.
          </Text>
        ) : (
          integrations.map((integration) => (
            <IntegrationRow key={integration.id} integration={integration} projectTitle={projectTitle} />
          ))
        )}
      </Section>

      {archived.length > 0 ? (
        <Section title="Archived">
          {archived.map((row) => (
            <ArchivedRow key={row.project.id} archived={row} />
          ))}
        </Section>
      ) : null}

      <Section title="Account">
        <Row
          title={session?.user.name ?? session?.user.email ?? "Signed in"}
          subtitle={session?.user.name ? session.user.email : ""}
        />
      </Section>
      <Button
        title="Sign out"
        variant="ghost"
        busy={signOut.busy}
        onPress={() => signOut.run(undefined)}
        style={{ marginTop: 24 }}
      />
      {appConfig.backend === "fixtures" ? (
        <Button
          title="Sample screens"
          variant="ghost"
          onPress={() => router.push("/fixtures")}
          style={{ marginTop: 10 }}
        />
      ) : null}

      {isUpdatePending ? (
        <Button
          title="Restart to update Dream"
          variant="ghost"
          onPress={() => void Effect.runPromise(applyUpdate.pipe(Effect.ignore))}
          style={{ marginTop: 10 }}
        />
      ) : null}

      <Text style={{ marginTop: 28, fontSize: 12, lineHeight: 18, color: color.t3, textAlign: "center" }}>
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

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View style={{ marginTop: 28 }}>
      <Lab style={{ marginBottom: 4 }}>{props.title}</Lab>
      {props.children}
    </View>
  )
}

function Row(props: {
  readonly title: string
  readonly subtitle: string
  readonly action?: string
  readonly busy?: boolean
  readonly onAction?: () => void
  /** A second, quieter action before the main one. */
  readonly secondary?: string | undefined
  readonly onSecondary?: () => void
  readonly icon?: "lock" | "key" | "spark"
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        paddingVertical: 13,
        borderBottomWidth: 1,
        borderColor: color.line
      }}
    >
      {props.icon ? <Icon name={props.icon} size={19} color={color.t2} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: color.t1 }}>{props.title}</Text>
        {props.subtitle ? (
          <Text style={{ fontSize: 13.5, lineHeight: 19, color: color.t2, marginTop: 2 }}>{props.subtitle}</Text>
        ) : null}
      </View>
      {props.secondary ? (
        <Pressable accessibilityRole="button" onPress={props.onSecondary} hitSlop={8}>
          <Text style={{ fontSize: 15, fontWeight: "600", color: color.t2 }}>{props.secondary}</Text>
        </Pressable>
      ) : null}
      {props.action ? (
        <Pressable accessibilityRole="button" onPress={props.onAction} disabled={props.busy === true} hitSlop={8}>
          <Text style={{ fontSize: 15, fontWeight: "600", color: props.busy ? color.t3 : color.t2 }}>
            {props.action}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** An archived project: Restore puts it back on Home as it was; Delete asks first. */
function ArchivedRow(props: { readonly archived: ArchivedProject }) {
  const { project, archivedAt } = props.archived
  const restore = useAction(restoreProjectFn)
  const { confirmDelete, deleting } = useProjectActions(project)
  const toast = useToast()
  const day = dayLabel(archivedAt, DateTime.nowUnsafe())
  return (
    <Row
      title={project.title}
      subtitle={`Archived ${day === "Today" || day === "Yesterday" ? day.toLowerCase() : day}`}
      action="Restore"
      busy={restore.busy || deleting}
      onAction={() =>
        restore.run(project.id, { onSuccess: () => toast(`${project.title} is back on Home`, { done: true }) })
      }
      secondary="Delete"
      onSecondary={confirmDelete}
    />
  )
}

function ConnectionRow(props: { readonly connection: ModelConnection; readonly show?: "menu" | "remove" | undefined }) {
  const router = useRouter()
  const disconnect = useAction(disconnectModelConnectionFn)
  const c = props.connection
  // A connected plan is the plan card: its usage, each project's share of it, and its menu.
  if (c.status === "connected") return <PlanCard connection={c} show={props.show} />
  return c.status === "pending" ? (
    <Row
      icon="spark"
      title={c.usage?.plan ?? providerName(c.provider)}
      subtitle="Finishing sign-in…"
      action="Cancel"
      busy={disconnect.busy}
      onAction={() => disconnect.run(c.id)}
    />
  ) : (
    <Row
      icon="spark"
      title={providerName(c.provider)}
      subtitle={c.status === "expired" ? "Sign-in expired" : "Sign-in failed"}
      action="Reconnect"
      onAction={() => router.push({ pathname: "/connect", params: { provider: c.provider } })}
    />
  )
}

function IntegrationRow(props: {
  readonly integration: Integration
  readonly projectTitle: (id: ProjectId) => string | undefined
}) {
  const disconnect = useAction(disconnectIntegrationFn)
  const replace = useAction(replaceKeyFn)
  const toast = useToast()
  const [key, setKey] = useState<string | undefined>(undefined)
  const i = props.integration
  // Pasted keys and file keys can be swapped for a new one here; sign-ins reconnect from a project's card.
  const replaceable = i.access._tag === "Key" || i.access._tag === "File"
  return (
    <View>
      <Row
        icon={i.access._tag === "Google" || i.access._tag === "OAuth" ? "lock" : "key"}
        title={i.label}
        subtitle={
          i.status === "connected"
            ? integrationReach(i, props.projectTitle)
            : `${integrationSummary(i)} · stopped working; connect it again from the project’s card`
        }
        action={i.access._tag === "File" ? "Remove" : "Disconnect"}
        busy={disconnect.busy}
        onAction={() => disconnect.run(i.id)}
        secondary={replaceable && key === undefined ? "Replace" : undefined}
        onSecondary={() => setKey("")}
      />
      {key === undefined ? null : (
        <View style={{ paddingTop: 12, paddingBottom: 4, borderBottomWidth: 1, borderColor: color.line }}>
          <SecretField value={key} onChange={setKey} placeholder={`New ${i.label} key`} />
          <Button
            title={i.access._tag === "File" ? "Save to this project" : "Save to vault"}
            disabled={!key.trim()}
            busy={replace.busy}
            onPress={() =>
              replace.run(
                { integrationId: i.id, key },
                {
                  onSuccess: () => {
                    setKey(undefined)
                    toast(
                      i.access._tag === "File"
                        ? `New ${i.label} key saved. The project will pick it up.`
                        : `New ${i.label} key saved.`,
                      { done: true }
                    )
                  }
                }
              )
            }
          />
          <Button title="Cancel" variant="ghost" onPress={() => setKey(undefined)} style={{ marginTop: 10 }} />
        </View>
      )}
    </View>
  )
}
