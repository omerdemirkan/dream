/**
 * Archived projects, from Settings (direction B): each keeps everything and comes back as it was with Restore;
 * swiping one left offers Delete, which asks first (VoiceOver has it as an action on the row).
 */
import type { ArchivedProject } from "@dream/domain"
import { useAtomValue } from "@effect/atom-react"
import { DateTime, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ActivityIndicator, Pressable, Text, View } from "react-native"
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable"
import { dayLabel } from "../data/format.ts"
import { archivedProjectsAtom, restoreProjectFn } from "../state/atoms.ts"
import { useAction, useToast } from "../ui/actions.ts"
import { DetailScreen } from "../ui/DetailScreen.tsx"
import { GroupFooter } from "../ui/Group.tsx"
import { Tile } from "../ui/kit.tsx"
import { useProjectActions } from "../ui/ProjectMenu.tsx"
import { color } from "../ui/theme.ts"

export default function Archived() {
  const result = useAtomValue(archivedProjectsAtom)
  const archived = Option.getOrElse(AsyncResult.value(result), (): ReadonlyArray<ArchivedProject> => [])
  return (
    <DetailScreen title="Archived">
      {AsyncResult.isInitial(result) ? (
        <ActivityIndicator color={color.t3} style={{ marginTop: 40 }} />
      ) : archived.length === 0 ? (
        <Text style={{ fontSize: 15, lineHeight: 21.5, color: color.t2 }}>
          Nothing archived. Hold a project on Home to archive it.
        </Text>
      ) : (
        <>
          <Text style={{ fontSize: 15, lineHeight: 21.5, color: color.t2 }}>
            Archived projects keep everything and come back exactly as they were.
          </Text>
          <View
            style={{
              marginTop: 18,
              backgroundColor: color.s1,
              borderRadius: 20,
              borderCurve: "continuous",
              borderWidth: 1,
              borderColor: color.line,
              overflow: "hidden"
            }}
          >
            {archived.map((row, i) => (
              <View key={row.project.id}>
                {i > 0 ? <View style={{ height: 1, backgroundColor: color.line, marginLeft: 54 }} /> : null}
                <ArchivedRow archived={row} />
              </View>
            ))}
          </View>
          <GroupFooter>Swipe one left to delete it for good.</GroupFooter>
        </>
      )}
    </DetailScreen>
  )
}

function ArchivedRow(props: { readonly archived: ArchivedProject }) {
  const { project, archivedAt } = props.archived
  const restore = useAction(restoreProjectFn)
  const { confirmDelete, deleting } = useProjectActions(project)
  const toast = useToast()
  const day = dayLabel(archivedAt, DateTime.nowUnsafe())
  const busy = restore.busy || deleting
  const onRestore = () =>
    restore.run(project.id, { onSuccess: () => toast(`${project.title} is back on Home`, { done: true }) })
  return (
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      renderRightActions={(_progress, _translation, methods) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete ${project.title}`}
          onPress={() => {
            methods.close()
            confirmDelete()
          }}
          style={({ pressed }) => ({
            width: 88,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: pressed ? color.s2 : color.s3
          })}
        >
          <Text style={{ fontSize: 15, fontWeight: "600", color: color.t1 }}>Delete</Text>
        </Pressable>
      )}
    >
      <View
        accessible
        accessibilityLabel={`${project.title}, archived ${day}`}
        accessibilityActions={[
          { name: "restore", label: "Restore" },
          { name: "delete", label: "Delete" }
        ]}
        onAccessibilityAction={(e) => (e.nativeEvent.actionName === "delete" ? confirmDelete() : onRestore())}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          minHeight: 62,
          paddingHorizontal: 14,
          backgroundColor: color.s1
        }}
      >
        <Tile icon={project.icon} size="sm" />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: "500", letterSpacing: -0.16, color: color.t1 }}>
            {project.title}
          </Text>
          <Text style={{ fontSize: 13.5, color: color.t2, marginTop: 1 }}>
            {`Archived ${day === "Today" || day === "Yesterday" ? day.toLowerCase() : day}`}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Restore ${project.title}`}
          disabled={busy}
          onPress={onRestore}
          style={({ pressed }) => ({
            height: 34,
            paddingHorizontal: 14,
            borderRadius: 17,
            justifyContent: "center",
            backgroundColor: pressed ? color.s3 : color.s2,
            borderWidth: 1,
            borderColor: color.line,
            opacity: busy ? 0.5 : 1
          })}
        >
          <Text style={{ fontSize: 14, fontWeight: "600", color: color.t1 }}>Restore</Text>
        </Pressable>
      </View>
    </ReanimatedSwipeable>
  )
}
