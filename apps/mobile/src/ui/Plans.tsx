/**
 * A plan's actions: reconnect it (another account, or a fresh sign-in) or remove it. Removing a plan projects run on
 * says first that they pause until it's connected again (Dream holds their work meanwhile).
 */
import type { ModelConnection, ProjectSummary } from "@dream/domain"
import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import * as Haptics from "expo-haptics"
import { useRouter } from "expo-router"
import { Alert } from "react-native"
import { providerName } from "../data/format.ts"
import { removeConsequence } from "../data/plans.ts"
import { disconnectModelConnectionFn, projectsAtom } from "../state/atoms.ts"
import { useAction, useToast } from "./actions.ts"

/**
 * A plan's actions, on its page: Reconnect (another account, or a fresh sign-in), and Remove after saying what it
 * does to their projects; `onRemoved` runs once it's gone.
 */
export function usePlanActions(connection: ModelConnection, onRemoved: () => void) {
  const router = useRouter()
  const disconnect = useAction(disconnectModelConnectionFn)
  const toast = useToast()
  const projects = Option.getOrElse(
    AsyncResult.value(useAtomValue(projectsAtom)),
    (): ReadonlyArray<ProjectSummary> => []
  )
  const name = providerName(connection.provider)
  return {
    busy: disconnect.busy,
    reconnect: () => router.push({ pathname: "/connect", params: { provider: connection.provider } }),
    /** A sign-in under way: stop waiting for it. */
    cancel: () => disconnect.run(connection.id, { onSuccess: onRemoved }),
    remove: () =>
      Alert.alert(`Remove ${name}?`, removeConsequence(connection.provider, projects), [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
            disconnect.run(connection.id, {
              onSuccess: () => {
                toast(`Removed ${name}`, { done: true })
                onRemoved()
              },
              onFailure: (message) => toast(`Couldn’t remove ${name}. ${message}`)
            })
          }
        }
      ])
  }
}
