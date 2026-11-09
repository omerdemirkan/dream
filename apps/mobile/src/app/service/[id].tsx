/**
 * A connected service's page, from its row in Settings (direction B): what it is and since when, who can use it in a
 * sentence (a key file links to the project it lives on), that it stopped working if it did, then Replace for a
 * pasted key or key file and Disconnect (Remove, for a key file), which asks first. `?replace=1` opens the paste
 * field on arrival.
 */
import type { Integration, ProjectSummary } from "@dream/domain"
import { useAtomValue } from "@effect/atom-react"
import * as Haptics from "expo-haptics"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useState } from "react"
import { ActivityIndicator, Alert, Text, View } from "react-native"
import { servicePage } from "../../data/settings.ts"
import { disconnectIntegrationFn, integrationsAtom, projectsAtom, replaceKeyFn } from "../../state/atoms.ts"
import { useAction, useToast } from "../../ui/actions.ts"
import { DetailScreen } from "../../ui/DetailScreen.tsx"
import { SecretField } from "../../ui/Expanded.tsx"
import { ActionRow, Group, GroupFooter, GroupRow, ServiceMark } from "../../ui/Group.tsx"
import { useProjectTitle } from "../../ui/hooks.ts"
import { Button, Tile } from "../../ui/kit.tsx"
import { color, tracking } from "../../ui/theme.ts"

export default function ServiceScreen() {
  const params = useLocalSearchParams<{ id?: string; replace?: string }>()
  const result = useAtomValue(integrationsAtom)
  const integration = Option.getOrElse(AsyncResult.value(result), (): ReadonlyArray<Integration> => []).find(
    (i) => i.id === params.id
  )
  if (!integration)
    return (
      <DetailScreen title="Connected service">
        {AsyncResult.isInitial(result) ? (
          <ActivityIndicator color={color.t3} style={{ marginTop: 40 }} />
        ) : (
          <Text style={{ fontSize: 15, lineHeight: 21, color: color.t2 }}>This service isn’t connected anymore.</Text>
        )}
      </DetailScreen>
    )
  return <Service integration={integration} replacing={params.replace === "1"} />
}

function Service(props: { readonly integration: Integration; readonly replacing: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const projectTitle = useProjectTitle()
  const projects = Option.getOrElse(
    AsyncResult.value(useAtomValue(projectsAtom)),
    (): ReadonlyArray<ProjectSummary> => []
  )
  const disconnect = useAction(disconnectIntegrationFn)
  const replace = useAction(replaceKeyFn)
  const [key, setKey] = useState<string | undefined>(props.replacing ? "" : undefined)
  const i = props.integration
  const page = servicePage(i, projectTitle)
  const owner = page.projectId === undefined ? undefined : projects.find((s) => s.project.id === page.projectId)
  const confirmRemove = () =>
    Alert.alert(page.remove.title, page.remove.message, [
      { text: "Cancel", style: "cancel" },
      {
        text: page.remove.label,
        style: "destructive",
        onPress: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
          disconnect.run(i.id, {
            onSuccess: () => {
              toast(page.remove.done, { done: true })
              router.back()
            },
            onFailure: (message) => toast(`Couldn’t ${page.remove.label.toLowerCase()} ${page.title}. ${message}`)
          })
        }
      }
    ])
  return (
    <DetailScreen title={page.title}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 6 }}>
        <ServiceMark icon={page.icon} size={48} />
        <View style={{ flex: 1 }}>
          <Text
            accessibilityRole="header"
            style={{ fontSize: 22, fontWeight: "700", letterSpacing: tracking(-0.03, 22), color: color.t1 }}
          >
            {page.title}
          </Text>
          <Text style={{ fontSize: 13.5, lineHeight: 19, color: color.t2, marginTop: 2 }}>{page.kind}</Text>
        </View>
      </View>
      {page.stopped ? (
        <Text style={{ fontSize: 15, lineHeight: 21.5, color: color.need, marginTop: 18 }}>{page.stopped}</Text>
      ) : null}
      {page.about ? (
        <Text style={{ fontSize: 15, lineHeight: 21.5, color: color.t2, marginTop: 18 }}>{page.about}</Text>
      ) : null}

      {page.projectId !== undefined && page.projectTitle !== undefined ? (
        <Group style={{ marginTop: 18 }}>
          <GroupRow
            icon={<Tile icon={owner?.project.icon} size="sm" />}
            title={page.projectTitle}
            onPress={
              owner ? () => router.push({ pathname: "/project/[id]", params: { id: owner.project.id } }) : undefined
            }
          />
        </Group>
      ) : null}

      {key !== undefined && page.replace ? (
        <View style={{ marginTop: 22 }}>
          <SecretField value={key} onChange={setKey} placeholder={page.replace.placeholder} />
          <Button
            title={page.replace.save}
            disabled={!key.trim()}
            busy={replace.busy}
            onPress={() =>
              replace.run(
                { integrationId: i.id, key },
                {
                  onSuccess: () => {
                    setKey(undefined)
                    toast(page.replace?.done ?? "Saved.", { done: true })
                  }
                }
              )
            }
          />
          <Button title="Cancel" variant="ghost" onPress={() => setKey(undefined)} style={{ marginTop: 10 }} />
        </View>
      ) : (
        <>
          <Group style={{ marginTop: 22 }}>
            {page.replace ? <ActionRow title={page.replace.label} onPress={() => setKey("")} /> : null}
            <ActionRow title={page.remove.label} busy={disconnect.busy} onPress={confirmRemove} />
          </Group>
          <GroupFooter>{page.remove.message}</GroupFooter>
        </>
      )}
    </DetailScreen>
  )
}
