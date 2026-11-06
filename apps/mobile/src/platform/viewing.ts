/**
 * Which project's screen is in front, for the notification handler, which runs outside React
 * (see `showsWhileOpen`).
 */
import type { ProjectId } from "@dream/domain"
import { useFocusEffect } from "expo-router"
import { useCallback } from "react"

let viewing: ProjectId | undefined

export const viewingProject = () => viewing

/** Marks `projectId` as in front while the calling screen is focused. */
export function useViewingProject(projectId: ProjectId) {
  useFocusEffect(
    useCallback(() => {
      viewing = projectId
      return () => {
        if (viewing === projectId) viewing = undefined
      }
    }, [projectId])
  )
}
