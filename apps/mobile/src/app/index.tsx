/**
 * Home: the row of app links, then their projects, each saying whether it's
 * waiting for them (questions and access requests live in the project). The
 * composer at the bottom starts a new idea.
 *
 * `/?sheet=add`, `/?sheet=icon&link=<id>` and `/?sheet=home-screen&link=<id>` open the app link sheets.
 */
import type { LinkId, ModelConnection, ProjectSummary } from "@dream/domain"
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Redirect, useLocalSearchParams, useRouter } from "expo-router"
import { useEffect } from "react"
import { Pressable, ScrollView, Text, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { phaseLabel, providerName } from "../data/format.ts"
import { profileHint } from "../data/usage.ts"
import { dotOf, homeLine, presenceOf } from "../data/presence.ts"
import { hiddenProjectsAtom, modelConnectionsAtom, projectsAtom } from "../state/atoms.ts"
import { linkSheetAtom } from "../state/ui.ts"
import { AppLinksRow } from "../ui/AppLinks.tsx"
import { EmptyInvite } from "../ui/EmptyInvite.tsx"
import { LinkSheets } from "../ui/LinkSheets.tsx"
import { Dot, Icon, IconButton, LinkButton, Orb } from "../ui/kit.tsx"
import { plainText } from "../ui/markdownParse.ts"
import { PresenceTile, StateLineText, useTickingNow } from "../ui/Presence.tsx"
import { ProjectLink } from "../ui/ProjectMenu.tsx"
import { color, gutter } from "../ui/theme.ts"

const listOf = <A,>(result: AsyncResult.AsyncResult<ReadonlyArray<A>, unknown>) =>
  Option.getOrElse(AsyncResult.value(result), (): ReadonlyArray<A> => [])

export default function Home() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const projectsResult = useAtomValue(projectsAtom)
  // Archived or deleted here: gone from Home at once, before the API's lists say so.
  const hidden = Option.getOrElse(
    AsyncResult.value(useAtomValue(hiddenProjectsAtom)),
    (): ReadonlySet<string> => new Set()
  )
  const projects = listOf(projectsResult).filter((summary) => !hidden.has(summary.project.id))
  const refreshProjects = useAtomRefresh(projectsAtom)
  const connectionsResult = useAtomValue(modelConnectionsAtom)
  const connections = listOf(connectionsResult)
  const needs = projects.some((s) => s.openAsks > 0)
  const hint = profileHint(connections)
  // Nothing to show and the last try failed (offline, the API down): say so rather than look empty.
  const unreachable = projects.length === 0 && AsyncResult.isFailure(projectsResult) && !projectsResult.waiting
  // No projects yet: the words and the drawn arrow lead to the input, and nothing else fills the space.
  const empty = projects.length === 0 && AsyncResult.isSuccess(projectsResult)

  // While an agent is starting or working, Home checks back every so often, so its row moves on by itself.
  const busy = projects.some((s) => s.activity?.state === "starting" || s.activity?.state === "working")
  useEffect(() => {
    if (!busy) return
    const id = setInterval(refreshProjects, 15_000)
    return () => clearInterval(id)
  }, [busy, refreshProjects])

  const params = useLocalSearchParams<{ sheet?: string; link?: string }>()
  const setSheet = useAtomSet(linkSheetAtom)
  useEffect(() => {
    if (params.sheet === "add") setSheet(Option.some({ kind: "add" }))
    else if ((params.sheet === "icon" || params.sheet === "home-screen") && params.link)
      setSheet(Option.some({ kind: params.sheet, linkId: params.link as LinkId }))
  }, [params.sheet, params.link, setSheet])

  // Nothing runs without a subscription: a new person connects one first.
  if (AsyncResult.isSuccess(connectionsResult) && connections.length === 0) return <Redirect href="/connect" />

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + 4,
          paddingHorizontal: gutter,
          // Ends just above the docked input.
          paddingBottom: Math.max(insets.bottom, 12) + 2 + 56 + 22
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, height: 38 }}>
          <Orb need={needs} />
          <Text style={{ fontSize: 17, fontWeight: "700", letterSpacing: -0.34, color: color.t1, flex: 1 }}>Dream</Text>
          <View>
            <IconButton
              icon="person"
              size={34}
              label={hint ? "Settings: your subscription is nearly used up this week" : "Settings"}
              onPress={() => router.push("/settings")}
            />
            {/* Only near the limit: their plan's usage lives in Settings. */}
            {hint ? (
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  right: -2,
                  top: -2,
                  width: 11,
                  height: 11,
                  borderRadius: 5.5,
                  backgroundColor: color.need,
                  borderWidth: 2.5,
                  borderColor: color.bg
                }}
              />
            ) : null}
          </View>
        </View>
        <AppLinksRow projects={projects} />
        {/* Each project's row says whether it waits for them; Home has no summary section above the list. */}
        <View style={{ height: 12 }} />
        {unreachable ? <Unreachable onRetry={refreshProjects} /> : null}
        <ConnectionBanner connections={connections} />
        {projects.length > 0 ? (
          <Text style={{ fontSize: 13, fontWeight: "600", color: color.t3, marginBottom: 2 }}>Projects</Text>
        ) : null}
        {projects.map((summary, i) => (
          <ProjectRow key={summary.project.id} summary={summary} first={i === 0} open={summary.openAsks} />
        ))}
        {empty ? (
          <>
            {/* Puts the words and the arrow just above the input. */}
            <View style={{ flex: 1 }} />
            <EmptyInvite />
          </>
        ) : null}
      </ScrollView>
      {/* Keeps the clock readable over a long project list. */}
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: insets.top + 8,
          experimental_backgroundImage: `linear-gradient(to bottom, ${color.bg} 70%, rgba(10,10,12,0))`
        }}
      />
      <Dock />
      <LinkSheets projects={projects} />
    </View>
  )
}

function Unreachable(props: { readonly onRetry: () => void }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: color.line,
        borderRadius: 28,
        paddingTop: 22,
        paddingHorizontal: 22,
        paddingBottom: 16,
        backgroundColor: color.s1,
        marginBottom: 26
      }}
    >
      <Text style={{ fontSize: 20, fontWeight: "700", letterSpacing: -0.5, color: color.t1, marginBottom: 6 }}>
        Can’t reach Dream
      </Text>
      <Text style={{ fontSize: 15, lineHeight: 21.75, color: color.t2 }}>
        Your projects keep running. Check your connection and try again.
      </Text>
      <LinkButton title="Try again" onPress={props.onRetry} />
    </View>
  )
}

function ConnectionBanner(props: { readonly connections: ReadonlyArray<ModelConnection> }) {
  const router = useRouter()
  const broken = props.connections.find((c) => c.status === "expired" || c.status === "failed")
  if (!broken || props.connections.some((c) => c.status === "connected")) return null
  return (
    <Pressable
      onPress={() => router.push("/connect")}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 14,
        borderRadius: 20,
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: color.needLine,
        marginBottom: 22
      }}
    >
      <Dot kind="need" />
      <Text style={{ flex: 1, fontSize: 15, color: color.t1 }}>
        Your {providerName(broken.provider)} sign-in {broken.status === "expired" ? "expired" : "stopped working"}.
        Projects are waiting.
      </Text>
      <Icon name="chev" size={15} color={color.t3} />
    </Pressable>
  )
}

function Progress(props: { readonly done: number; readonly total: number; readonly current: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 3 }}>
      {Array.from({ length: Math.min(props.total, 8) }, (_, i) => (
        <View
          key={i}
          style={{
            width: 13,
            height: 3,
            borderRadius: 2,
            backgroundColor: i < props.done ? color.t1 : "rgba(255,255,255,0.14)",
            experimental_backgroundImage:
              i === props.done && props.current
                ? "linear-gradient(90deg, #F5F5F7 50%, rgba(255,255,255,0.14) 50%)"
                : undefined
          }}
        />
      ))}
    </View>
  )
}

function ProjectRow(props: { readonly summary: ProjectSummary; readonly first: boolean; readonly open: number }) {
  const { project, progress } = props.summary
  const { open } = props
  // The Status card's now line, as plain text: markdown and any lines after the first don't fit here.
  const headline = project.headline ? plainText(project.headline).split("\n")[0] || undefined : undefined
  const now = useTickingNow(props.summary.activity?.state === "working")
  const presence = presenceOf({
    activity: props.summary.activity,
    working: false,
    pausedUntil: props.summary.pausedUntil,
    now
  })
  const line = homeLine(presence, {
    now,
    harness: project.harness,
    openAsks: open,
    headline
  })
  const sub = headline ?? phaseLabel(project.phase)
  return (
    <ProjectLink project={project}>
      {/* Link's Slot drops a function style, so the pressed look lives on a View inside. */}
      <Pressable accessibilityRole="button">
        {({ pressed }) => (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 14,
              paddingVertical: 13,
              borderTopWidth: props.first ? 0 : 1,
              borderColor: color.line,
              opacity: pressed ? 0.6 : 1
            }}
          >
            <PresenceTile icon={project.icon} dot={dotOf(presence)} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 17, fontWeight: "600", letterSpacing: -0.25, color: color.t1 }}>
                {project.title}
              </Text>
              {line ? (
                <StateLineText line={line} style={{ fontSize: 14, marginTop: 2 }} />
              ) : (
                <Text numberOfLines={1} style={{ fontSize: 14, color: color.t2, marginTop: 2 }}>
                  {sub}
                </Text>
              )}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {open > 0 ? (
                <Dot kind="need" />
              ) : project.phase === "live" ? (
                <Text style={{ fontSize: 13, color: color.t3 }}>Live</Text>
              ) : progress && progress.total > 0 && project.phase === "building" ? (
                <Progress done={progress.done} total={progress.total} current={project.phase === "building"} />
              ) : null}
            </View>
          </View>
        )}
      </Pressable>
    </ProjectLink>
  )
}

function Dock() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        paddingTop: 34,
        paddingHorizontal: 16,
        paddingBottom: Math.max(insets.bottom, 12) + 2,
        experimental_backgroundImage: `linear-gradient(to top, ${color.bg} 58%, rgba(10,10,12,0))`
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Describe an idea"
        onPress={() => router.push("/new")}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          height: 56,
          paddingLeft: 20,
          paddingRight: 8,
          borderRadius: 28,
          backgroundColor: color.s2,
          borderWidth: 1,
          borderColor: color.line2,
          boxShadow: "0 10px 34px rgba(0,0,0,0.55)"
        }}
      >
        <Text style={{ flex: 1, fontSize: 16, color: color.t2 }}>Describe an idea…</Text>
        <IconButton icon="mic" tone="white" label="Dictate an idea" onPress={() => router.push("/new?dictate=1")} />
      </Pressable>
    </View>
  )
}
