/**
 * Archiving and deleting a project: Home's long-press menu (iOS's own context
 * menu, through expo-router's `Link.Menu`), and the actions Settings' archived
 * list shares with it.
 */
import type { Project } from "@dream/domain"
import * as Haptics from "expo-haptics"
import { Link } from "expo-router"
import type { ReactNode } from "react"
import { Alert } from "react-native"
import { archiveProjectFn, deleteProjectFn } from "../state/atoms.ts"
import { useAction, useToast } from "./actions.ts"

export function useProjectActions(project: Pick<Project, "id" | "title">) {
  const archive = useAction(archiveProjectFn)
  const remove = useAction(deleteProjectFn)
  const toast = useToast()
  return {
    deleting: remove.busy,
    /** Leaves Home at once, with Undo in the toast. */
    archive: () => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      toast(`Archived ${project.title}`, { restore: project.id, done: true })
      archive.run(project.id, { onFailure: (message) => toast(`Couldn’t archive ${project.title}. ${message}`) })
    },
    /** Asks first: there's no undoing it. */
    confirmDelete: () =>
      Alert.alert(
        `Delete ${project.title}?`,
        "Its code and app, its chat and status, its published link and any keys only it used are deleted for good. Services your other projects use stay connected.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
              remove.run(project.id, {
                onSuccess: () => toast(`Deleted ${project.title}`, { done: true }),
                onFailure: (message) => toast(`Couldn’t delete ${project.title}. ${message}`)
              })
            }
          }
        ]
      )
  }
}

/** A Home row: a tap opens the project; holding it brings up Archive and Delete. */
export function ProjectLink(props: { readonly project: Project; readonly children: ReactNode }) {
  const { archive, confirmDelete } = useProjectActions(props.project)
  return (
    <Link href={{ pathname: "/project/[id]", params: { id: props.project.id } }} asChild>
      <Link.Trigger>{props.children}</Link.Trigger>
      <Link.Menu>
        <Link.MenuAction title="Archive" icon="archivebox" onPress={archive} />
        <Link.MenuAction title="Delete" icon="trash" destructive onPress={confirmDelete} />
      </Link.Menu>
    </Link>
  )
}
