/**
 * App links on Home (Deck v3, option A "Dock"): a row of app icons under the header, above Projects, with an Add
 * tile at the end; it scrolls sideways past about five. A tap opens the link full screen in Dream. Holding one
 * brings up iOS's context menu (expo-router's `Link.Menu`), headed by who made it and its host.
 */
import { type AppLink, linkHost, linkMenuHeader, type Project, type ProjectSummary } from "@dream/domain"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import * as Clipboard from "expo-clipboard"
import * as Haptics from "expo-haptics"
import { Link } from "expo-router"
import * as WebBrowser from "expo-web-browser"
import { Alert, Pressable, ScrollView, Text, View } from "react-native"
import Svg, { Rect } from "react-native-svg"
import { linksAtom, markLinkOpenedFn, removeLinkFn, updateLinkFn } from "../state/atoms.ts"
import { linkSheetAtom } from "../state/ui.ts"
import { useAction, useToast } from "./actions.ts"
import { Icon } from "./kit.tsx"
import { LinkTile } from "./LinkTile.tsx"
import { color, gutter } from "./theme.ts"

/** Each icon's column: the 60 pt tile centred, its label up to the column's width. */
const column = 76
const tileSize = 60
/** The widest a label gets, leaving 8 pt between neighbours; `linkLabel` in the domain estimates the same. */
const labelWidth = 68

/** Opens a link full screen inside Dream; a new one loses its dot. */
export function useOpenLink() {
  const markOpened = useAtomSet(markLinkOpenedFn)
  return (link: AppLink) => {
    if (link.openedAt === undefined) markOpened(link.id)
    void WebBrowser.openBrowserAsync(link.url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
      controlsColor: color.t1,
      toolbarColor: color.bg,
      dismissButtonStyle: "done"
    })
  }
}

const projectOf = (link: AppLink, projects: ReadonlyArray<ProjectSummary>): Project | undefined =>
  link.projectId === undefined ? undefined : projects.find((s) => s.project.id === link.projectId)?.project

export function AppLinksRow(props: { readonly projects: ReadonlyArray<ProjectSummary> }) {
  const result = useAtomValue(linksAtom)
  const setSheet = useAtomSet(linkSheetAtom)
  // An API from before app links has no list; the row stays away rather than offering to add one.
  if (!AsyncResult.isSuccess(result) && Option.isNone(AsyncResult.value(result))) return null
  const links = Option.getOrElse(AsyncResult.value(result), (): ReadonlyArray<AppLink> => [])
  const add = () => setSheet(Option.some({ kind: "add" }))
  if (links.length === 0) return <EmptyLinks onAdd={add} />
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, marginHorizontal: -gutter, marginTop: 14, marginBottom: 22 }}
      contentContainerStyle={{ paddingHorizontal: gutter - (column - tileSize) / 2 }}
    >
      {links.map((link) => (
        <LinkIcon key={link.id} link={link} project={projectOf(link, props.projects)} />
      ))}
      <AddTile onPress={add} />
    </ScrollView>
  )
}

function Label(props: { readonly text: string; readonly fresh?: boolean; readonly quiet?: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", marginTop: 8, gap: 4 }}>
      {props.fresh ? <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color.t1 }} /> : null}
      <Text
        numberOfLines={1}
        style={{
          maxWidth: labelWidth - (props.fresh ? 9 : 0),
          fontSize: 12,
          letterSpacing: -0.05,
          color: props.quiet ? color.t3 : color.t1,
          textAlign: "center"
        }}
      >
        {props.text}
      </Text>
    </View>
  )
}

function LinkIcon(props: { readonly link: AppLink; readonly project: Project | undefined }) {
  const { link, project } = props
  const open = useOpenLink()
  const setSheet = useAtomSet(linkSheetAtom)
  const update = useAction(updateLinkFn)
  const remove = useAction(removeLinkFn)
  const toast = useToast()
  const header = linkMenuHeader(link, project?.title)
  const agents = link.addedBy === "agent" && project !== undefined

  const rename = () =>
    Alert.prompt(
      "Rename",
      agents ? `${project.title} keeps the name you give it.` : undefined,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save",
          isPreferred: true,
          onPress: (value?: string) => {
            const title = (value ?? "").trim().replace(/\s+/g, " ").slice(0, 24).trim()
            if (title.length === 0 || title === link.title) return
            update.run({ linkId: link.id, title }, { onFailure: (message) => toast(`Couldn’t rename it. ${message}`) })
          }
        }
      ],
      "plain-text",
      link.title
    )

  const confirmRemove = () => {
    if (!agents) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      remove.run(link.id, {
        onSuccess: () => toast(`Removed ${link.title}`, { done: true }),
        onFailure: (message) => toast(`Couldn’t remove it. ${message}`)
      })
      return
    }
    Alert.alert(
      `Remove ${link.title}?`,
      `${project.title} won’t put it back. You can add it again yourself with Add.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () =>
            remove.run(link.id, {
              onSuccess: () => toast(`Removed ${link.title}`, { done: true }),
              onFailure: (message) => toast(`Couldn’t remove it. ${message}`)
            })
        }
      ]
    )
  }

  return (
    <Link
      href={link.url as never}
      asChild
      onPress={(event) => {
        event.preventDefault()
        open(link)
      }}
    >
      <Link.Trigger>
        <Pressable accessibilityRole="link" accessibilityLabel={link.title}>
          {({ pressed }) => (
            <View style={{ width: column, alignItems: "center", opacity: pressed ? 0.7 : 1 }}>
              <LinkTile look={link} size={tileSize} />
              <Label text={link.title} fresh={link.addedBy === "agent" && link.openedAt === undefined} />
            </View>
          )}
        </Pressable>
      </Link.Trigger>
      <Link.Menu title={`${header.title}\n${header.host}`}>
        <Link.Menu displayInline title="">
          <Link.MenuAction title="Open" icon="arrow.up.forward.app" onPress={() => open(link)} />
          <Link.MenuAction
            title="Add to Home Screen"
            icon="plus.app"
            onPress={() => setSheet(Option.some({ kind: "home-screen", linkId: link.id }))}
          />
        </Link.Menu>
        <Link.Menu displayInline title="">
          <Link.MenuAction title="Rename" icon="pencil" onPress={rename} />
          <Link.MenuAction
            title="Change icon"
            icon="photo"
            onPress={() => setSheet(Option.some({ kind: "icon", linkId: link.id }))}
          />
          <Link.MenuAction
            title="Copy link"
            icon="doc.on.doc"
            onPress={() => {
              void Clipboard.setStringAsync(link.url)
              toast(`Copied ${linkHost(link.url)}`, { done: true })
            }}
          />
        </Link.Menu>
        <Link.MenuAction title="Remove" icon="trash" destructive onPress={confirmRemove} />
      </Link.Menu>
    </Link>
  )
}

/** A dashed rounded square, for Add. */
function Dashed(props: { readonly size: number; readonly radius: number }) {
  return (
    <Svg width={props.size} height={props.size} style={{ position: "absolute" }}>
      <Rect
        x={0.75}
        y={0.75}
        width={props.size - 1.5}
        height={props.size - 1.5}
        rx={props.radius}
        fill="none"
        stroke="rgba(255,255,255,0.22)"
        strokeWidth={1.5}
        strokeDasharray="4 4"
      />
    </Svg>
  )
}

function AddTile(props: { readonly onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Add an app" onPress={props.onPress}>
      {({ pressed }) => (
        <View style={{ width: column, alignItems: "center", opacity: pressed ? 0.6 : 1 }}>
          <View style={{ width: tileSize, height: tileSize, alignItems: "center", justifyContent: "center" }}>
            <Dashed size={tileSize} radius={tileSize * 0.225} />
            <Icon name="plus" size={24} color={color.t3} weight="regular" />
          </View>
          <Label text="Add" quiet />
        </View>
      )}
    </Pressable>
  )
}

/** No links yet (A2): one dashed Add tile and a line saying what lands here. */
function EmptyLinks(props: { readonly onAdd: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={props.onAdd} style={{ marginTop: 14, marginBottom: 22 }}>
      {({ pressed }) => (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 16,
            paddingVertical: 16,
            paddingHorizontal: 16,
            borderRadius: 22,
            borderWidth: 1.5,
            borderStyle: "dashed",
            borderColor: "rgba(255,255,255,0.16)",
            opacity: pressed ? 0.7 : 1
          }}
        >
          <View style={{ width: 52, height: 52, alignItems: "center", justifyContent: "center" }}>
            <Dashed size={52} radius={12} />
            <Icon name="plus" size={22} color={color.t2} weight="regular" />
          </View>
          <Text style={{ flex: 1, fontSize: 15, lineHeight: 20, color: color.t2 }}>
            Apps your projects publish show up here.
          </Text>
        </View>
      )}
    </Pressable>
  )
}
