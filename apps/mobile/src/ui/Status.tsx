/**
 * The Status card opened over Chat: the "now" sentence large, the amber need, the screenshots and recordings with
 * their captions, each milestone as one line, and the published app.
 */
import { type AppLink, linkHost, type Milestone, type Project } from "@dream/domain"
import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import * as WebBrowser from "expo-web-browser"
import { useRef } from "react"
import { type HostInstance, Pressable, Text, View } from "react-native"
import { milestoneDate } from "../data/format.ts"
import type { ProjectState } from "../data/projectState.ts"
import { linksAtom } from "../state/atoms.ts"
import { useOpenLink } from "./AppLinks.tsx"
import { useNow, useOpenMessage } from "./hooks.ts"
import { Dot, Icon, Tile } from "./kit.tsx"
import { LinkTile } from "./LinkTile.tsx"
import { MediaStrip } from "./Media.tsx"
import { cardOf, type NeedView } from "./statusView.ts"
import { color } from "./theme.ts"

/** The amber line, opening the ask it stands for. */
export function NeedLine(props: {
  readonly need: NeedView
  readonly size: "card" | "open"
  readonly chevron?: boolean
}) {
  const ref = useRef<HostInstance>(null)
  const open = useOpenMessage()
  const { need } = props
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityHint="Opens it"
      onPress={() => open({ projectId: need.ask.projectId, messageId: need.ask.id, message: need.ask, from: ref })}
      hitSlop={{ top: 8, bottom: 8 }}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 11, opacity: pressed ? 0.6 : 1 })}
    >
      <Dot kind="need" />
      <Text
        numberOfLines={props.size === "open" ? 2 : 1}
        style={{ flex: 1, fontSize: props.size === "open" ? 16.5 : 16, letterSpacing: -0.2, color: color.need }}
      >
        {need.text}
      </Text>
      {need.more > 0 ? (
        <Text style={{ fontSize: 13.5, color: color.need, opacity: 0.7 }}>{`+${need.more}`}</Text>
      ) : null}
      {props.chevron ? <Icon name="chev" size={15} color={color.need} weight="semibold" /> : null}
    </Pressable>
  )
}

function Marker(props: { readonly state: Milestone["state"] }) {
  const box = { width: 21, height: 21, borderRadius: 10.5, alignItems: "center", justifyContent: "center" } as const
  if (props.state === "done")
    return (
      <View style={[box, { backgroundColor: color.t1 }]}>
        <Icon name="check" size={11} color={color.black} weight="bold" />
      </View>
    )
  if (props.state === "current")
    return (
      <View style={[box, { borderWidth: 2, borderColor: color.t1 }]}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color.t1 }} />
      </View>
    )
  return <View style={[box, { borderWidth: 1.5, borderStyle: "dashed", borderColor: "rgba(255,255,255,0.3)" }]} />
}

function MilestoneLine(props: { readonly milestone: Milestone }) {
  const now = useNow()
  const m = props.milestone
  const when = m.state === "current" ? "Now" : m.date ? milestoneDate(m.date, now) : undefined
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 13, minHeight: 32 }}>
      <Marker state={m.state} />
      <Text
        numberOfLines={1}
        style={{ flex: 1, fontSize: 16, letterSpacing: -0.2, color: m.state === "upcoming" ? color.t3 : color.t1 }}
      >
        {m.title}
      </Text>
      {when ? <Text style={{ fontSize: 13, color: color.t3 }}>{when}</Text> : null}
    </View>
  )
}

/** The project's app link for its published URL (else any of its links), for its icon and name. */
const appLinkOf = (project: Project, links: ReadonlyArray<AppLink>) => {
  const own = links.filter((l) => l.projectId === project.id && l.removedAt === undefined)
  const host = linkHost(project.publicUrl)
  return own.find((l) => linkHost(l.url) === host) ?? own[0]
}

function PublishedApp(props: { readonly project: Project }) {
  const links = Option.getOrElse(AsyncResult.value(useAtomValue(linksAtom)), (): ReadonlyArray<AppLink> => [])
  const openLink = useOpenLink()
  const { project } = props
  const link = appLinkOf(project, links)
  const host = linkHost(project.publicUrl)
  const open = () =>
    link && linkHost(link.url) === host
      ? openLink(link)
      : void WebBrowser.openBrowserAsync(project.publicUrl, {
          presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
          controlsColor: color.t1,
          toolbarColor: color.bg,
          dismissButtonStyle: "done"
        })
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
      {link ? <LinkTile look={link} size={40} /> : <Tile icon={project.icon} size="md" />}
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "600", color: color.t1 }}>
          {link?.title ?? project.title}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 13, color: color.t3, marginTop: 2 }}>
          {host}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${link?.title ?? project.title}`}
        onPress={open}
        style={({ pressed }) => ({
          height: 32,
          paddingHorizontal: 16,
          borderRadius: 16,
          justifyContent: "center",
          backgroundColor: pressed ? color.line2 : color.s3
        })}
      >
        <Text style={{ fontSize: 14, fontWeight: "600", color: color.t1 }}>Open</Text>
      </Pressable>
    </View>
  )
}

const Rule = () => <View style={{ height: 1, backgroundColor: color.line, marginVertical: 18 }} />

/** Everything the Status card holds, shown when they open it over Chat. Tapping the sentence folds it. */
export function StatusRoadmap(props: { readonly state: ProjectState; readonly onClose: () => void }) {
  const now = useNow()
  const { state } = props
  const view = cardOf(state, now)
  const { status, project } = state
  const published = project.publishedPort !== undefined
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Folds the card"
        onPress={props.onClose}
        style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}
      >
        <Text
          style={
            view.stand === "now"
              ? {
                  flex: 1,
                  fontSize: 21,
                  lineHeight: 27,
                  fontWeight: "600",
                  letterSpacing: -0.4,
                  color: view.paused ? color.t2 : color.t1
                }
              : { flex: 1, fontSize: 16, lineHeight: 22, letterSpacing: -0.15, color: color.t2 }
          }
        >
          {view.text}
        </Text>
        <Icon
          name="chevDown"
          size={14}
          color={color.t3}
          weight="semibold"
          style={{ marginTop: 6, transform: [{ rotate: "180deg" }] }}
        />
      </Pressable>
      {view.need ? (
        <View style={{ marginTop: 16 }}>
          <NeedLine need={view.need} size="open" chevron />
        </View>
      ) : null}
      <MediaStrip media={status.media} inset={0} tile={{ width: 108, height: 190 }} />
      {status.milestones.length > 0 ? (
        <>
          <Rule />
          <View style={{ gap: 4 }}>
            {status.milestones.map((milestone, i) => (
              <MilestoneLine key={`${milestone.title}-${i}`} milestone={milestone} />
            ))}
          </View>
        </>
      ) : null}
      {published ? (
        <>
          <Rule />
          <PublishedApp project={project} />
        </>
      ) : null}
    </View>
  )
}
