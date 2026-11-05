/**
 * Settings: the subscription Dream runs on, the services connected for every
 * project, and the account.
 */
import type { Integration, ModelConnection } from "@dream/domain"
import { useAtomValue } from "@effect/atom-react"
import * as Application from "expo-application"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useRouter } from "expo-router"
import type { ReactNode } from "react"
import { Pressable, ScrollView, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { providerName, resetLabel, usageLine } from "../data/format.ts"
import {
  disconnectIntegrationFn,
  disconnectModelConnectionFn,
  integrationsAtom,
  modelConnectionsAtom,
  sessionAtom,
  signOutFn
} from "../state/atoms.ts"
import { appConfig } from "../state/runtime.ts"
import { useAction } from "../ui/actions.ts"
import { integrationSummary } from "../ui/describe.ts"
import { Button, Icon, IconButton, Lab } from "../ui/kit.tsx"
import { color, gutter } from "../ui/theme.ts"

export default function Settings() {
  const router = useRouter()
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

      <Section title="Subscription">
        {connections.length === 0 ? (
          <Row
            title="Not connected"
            subtitle="Projects need Claude or ChatGPT to run."
            action="Connect"
            onAction={() => router.push("/connect")}
          />
        ) : (
          connections.map((connection) => <ConnectionRow key={connection.id} connection={connection} />)
        )}
      </Section>

      <Section title="Connected services">
        {integrations.length === 0 ? (
          <Text style={{ fontSize: 14, lineHeight: 20, color: color.t2, paddingVertical: 12 }}>
            Nothing yet. When a project needs a service, it asks, and what you connect works for every project.
          </Text>
        ) : (
          integrations.map((integration) => <IntegrationRow key={integration.id} integration={integration} />)
        )}
      </Section>

      <Section title="Account">
        <Row title={session?.user.name ?? session?.user.email ?? "Signed in"} subtitle={session?.user.email ?? ""} />
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

      <Text style={{ marginTop: 28, fontSize: 12, lineHeight: 18, color: color.t3, textAlign: "center" }}>
        Dream {Application.nativeApplicationVersion ?? ""} ·{" "}
        {appConfig.backend === "fixtures" ? "sample projects" : appConfig.apiUrl.replace(/^https?:\/\//, "")}
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

function ConnectionRow(props: { readonly connection: ModelConnection }) {
  const router = useRouter()
  const disconnect = useAction(disconnectModelConnectionFn)
  const c = props.connection
  const usage = c.usage ? usageLine(c.usage) : undefined
  const resets = c.usage?.weekly?.resetsAt ? ` · resets ${resetLabel(c.usage.weekly.resetsAt)}` : ""
  const subtitle =
    c.status === "connected"
      ? `${usage ?? "Connected"}${usage ? resets : ""}`
      : c.status === "pending"
        ? "Finishing sign-in…"
        : c.status === "expired"
          ? "Sign-in expired"
          : "Sign-in failed"
  return c.status === "connected" || c.status === "pending" ? (
    <Row
      icon="spark"
      title={c.usage?.plan ?? providerName(c.provider)}
      subtitle={subtitle}
      action="Disconnect"
      busy={disconnect.busy}
      onAction={() => disconnect.run(c.id)}
    />
  ) : (
    <Row
      icon="spark"
      title={providerName(c.provider)}
      subtitle={subtitle}
      action="Reconnect"
      onAction={() => router.push("/connect")}
    />
  )
}

function IntegrationRow(props: { readonly integration: Integration }) {
  const disconnect = useAction(disconnectIntegrationFn)
  const i = props.integration
  return (
    <Row
      icon={i.access._tag === "Google" ? "lock" : "key"}
      title={i.label}
      subtitle={`${integrationSummary(i)} · shared by all your projects`}
      action="Disconnect"
      busy={disconnect.busy}
      onAction={() => disconnect.run(i.id)}
    />
  )
}
