/**
 * Settings' plans: each connected plan can be reconnected (another account, or a fresh sign-in) or removed, and a
 * plan that isn't connected has a dashed tile in the plan card's shape to add it. Removing a plan projects run on
 * says first that they pause until it's connected again (Dream holds their work meanwhile).
 */
import type { ModelConnection, ModelProvider, ProjectSummary } from "@dream/domain"
import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import * as Haptics from "expo-haptics"
import { useRouter } from "expo-router"
import { ActionSheetIOS, Alert, Pressable, Text, View } from "react-native"
import { providerName } from "../data/format.ts"
import { removeConsequence } from "../data/plans.ts"
import { disconnectModelConnectionFn, projectsAtom } from "../state/atoms.ts"
import { useAction, useToast } from "./actions.ts"
import { Icon } from "./kit.tsx"
import { color } from "./theme.ts"

const tiers: Record<ModelProvider, string> = { claude: "Pro or Max", chatgpt: "Plus or Pro" }

/** The plan card's menu: Reconnect, or Remove after saying what it does to their projects. */
export function usePlanMenu(connection: ModelConnection) {
  const router = useRouter()
  const disconnect = useAction(disconnectModelConnectionFn)
  const toast = useToast()
  const projects = Option.getOrElse(
    AsyncResult.value(useAtomValue(projectsAtom)),
    (): ReadonlyArray<ProjectSummary> => []
  )
  const name = providerName(connection.provider)
  const remove = () =>
    Alert.alert(`Remove ${name}?`, removeConsequence(connection.provider, projects), [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
          disconnect.run(connection.id, {
            onSuccess: () => toast(`Removed ${name}`, { done: true }),
            onFailure: (message) => toast(`Couldn’t remove ${name}. ${message}`)
          })
        }
      }
    ])
  return {
    busy: disconnect.busy,
    remove,
    open: () =>
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: connection.usage?.plan ?? name,
          options: ["Reconnect", "Remove", "Cancel"],
          destructiveButtonIndex: 1,
          cancelButtonIndex: 2,
          userInterfaceStyle: "dark"
        },
        (index) => {
          if (index === 0) router.push({ pathname: "/connect", params: { provider: connection.provider } })
          else if (index === 1) remove()
        }
      )
  }
}

/** Adds a plan: the plan card's outline, dashed, with a plus where its icon goes. */
export function AddPlanTile(props: { readonly provider: ModelProvider }) {
  const router = useRouter()
  const name = providerName(props.provider)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Add ${name}`}
      onPress={() => router.push({ pathname: "/connect", params: { provider: props.provider } })}
      style={({ pressed }) => ({
        marginTop: 10,
        paddingHorizontal: 16,
        paddingVertical: 14,
        borderRadius: 22,
        borderCurve: "continuous",
        borderWidth: 1.5,
        borderStyle: "dashed",
        borderColor: color.line2,
        backgroundColor: pressed ? color.s1 : "transparent"
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
        <Icon name="plus" size={19} color={color.t2} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: color.t1 }}>{`Add ${name}`}</Text>
          <Text style={{ fontSize: 13.5, lineHeight: 19, color: color.t2, marginTop: 2 }}>{tiers[props.provider]}</Text>
        </View>
      </View>
    </Pressable>
  )
}
