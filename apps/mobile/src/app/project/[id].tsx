/**
 * A project: Status (the live roadmap) and Chat (only what Dream chose to send).
 *
 * `?tab=chat` opens Chat; `?focus=<messageId>` opens that question or access
 * request expanded (deep links and notifications use both).
 */
import { type Message, MessageId, type Project as ProjectRecord, ProjectId, type ProjectSummary } from "@dream/domain"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useLocalSearchParams, useRouter } from "expo-router"
import { useEffect } from "react"
import { Pressable, ScrollView, Text, View } from "react-native"
import { KeyboardStickyView } from "react-native-keyboard-controller"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { dotOf, headerLine, presenceOf } from "../../data/presence.ts"
import type { ProjectState } from "../../data/projectState.ts"
import { draftKey } from "../../data/Replies.ts"
import { clearDraftFn, draftAtom, projectsAtom, sendMessageFn } from "../../state/atoms.ts"
import { landingAtom } from "../../state/ui.ts"
import { useAction } from "../../ui/actions.ts"
import { ChatTab } from "../../ui/Chat.tsx"
import { ChatComposer } from "../../ui/Composer.tsx"
import { useOpenMessage, useProject, useRequestId } from "../../ui/hooks.ts"
import { Dot, IconButton } from "../../ui/kit.tsx"
import { PresenceTile, StateLineText, useTickingNow } from "../../ui/Presence.tsx"
import { StatusTab } from "../../ui/Status.tsx"
import { color, gutter } from "../../ui/theme.ts"

const decodeProjectId = Schema.decodeUnknownOption(ProjectId)
const decodeMessageId = Schema.decodeUnknownOption(MessageId)

const header = 124

export default function ProjectScreen() {
  const params = useLocalSearchParams<{ id: string; tab?: string; focus?: string; land?: string }>()
  const projectId = Option.getOrUndefined(decodeProjectId(params.id))
  if (!projectId) return null
  return (
    <Project
      projectId={projectId}
      tab={params.tab === "chat" ? "chat" : "status"}
      focus={params.focus}
      land={params.land}
    />
  )
}

function Project(props: {
  readonly projectId: ProjectId
  readonly tab: "status" | "chat"
  readonly focus: string | undefined
  readonly land: string | undefined
}) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const open = useOpenMessage()
  const state = useProject(props.projectId)
  const summaries = Option.getOrUndefined(AsyncResult.value(useAtomValue(projectsAtom)))
  const project = state?.project ?? summaries?.find((s) => s.project.id === props.projectId)?.project
  const send = useAction(sendMessageFn)
  const requestId = useRequestId()
  // A reply typed into a notification that didn't send waits here, with the request id it was sent with.
  const chat = { _tag: "Chat", projectId: props.projectId } as const
  const draft = Option.getOrUndefined(Option.flatten(AsyncResult.value(useAtomValue(draftAtom(draftKey(chat))))))
  const clearDraft = useAtomSet(clearDraftFn)
  useEffect(() => {
    if (draft?.requestId) requestId.adopt(draft.text, draft.requestId)
  }, [draft])
  const setLanding = useAtomSet(landingAtom)

  useEffect(() => {
    const messageId = Option.getOrUndefined(decodeMessageId(props.focus))
    if (!messageId) return
    open({ projectId: props.projectId, messageId })
    router.setParams({ focus: undefined })
  }, [props.focus, props.projectId, open, router])

  // `?land=<messageId>`: scroll Chat to it and highlight it, as after Back from the expanded view.
  useEffect(() => {
    const messageId = Option.getOrUndefined(decodeMessageId(props.land))
    if (!messageId) return
    setLanding(Option.some({ projectId: props.projectId, messageId, highlight: true, at: Date.now() }))
    router.setParams({ land: undefined })
  }, [props.land, props.projectId, router, setLanding])

  const needsYou = state?.messages.some(needsThem)
  const top = insets.top + 4
  // The composer sits this far above the home indicator, and 10 pt above the keyboard, riding it as it moves.
  const composerBottom = Math.max(insets.bottom, 12) + 2
  const keyboardOffset = composerBottom - 10

  const summary = summaries?.find((s) => s.project.id === props.projectId)

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      {state ? (
        props.tab === "chat" ? (
          <View style={{ flex: 1 }}>
            <ChatTab state={state} topInset={top + header} bottomInset={24} keyboardOffset={keyboardOffset} />
            <KeyboardStickyView
              offset={{ opened: keyboardOffset }}
              style={{ paddingHorizontal: 16, paddingBottom: composerBottom, paddingTop: 10 }}
            >
              <ChatComposer
                busy={send.busy}
                draft={draft?.text}
                onSend={(text, sent) =>
                  send.run(
                    { projectId: props.projectId, text, requestId: requestId.for(text) },
                    {
                      onSuccess: () => {
                        requestId.done()
                        if (draft) clearDraft(chat)
                        sent()
                      }
                    }
                  )
                }
              />
            </KeyboardStickyView>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={{
              paddingTop: top + header,
              paddingHorizontal: gutter,
              paddingBottom: insets.bottom + 40
            }}
            showsVerticalScrollIndicator={false}
          >
            <StatusTab state={state} />
          </ScrollView>
        )
      ) : null}
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          paddingTop: top,
          paddingHorizontal: gutter,
          backgroundColor: color.bg
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, height: 48, marginLeft: -2 }}>
          <IconButton
            icon="back"
            size={38}
            label="Back"
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          />
          <Identity project={project} state={state} summary={summary} />
        </View>
        <View style={{ flexDirection: "row", gap: 28, marginTop: 6, borderBottomWidth: 1, borderColor: color.line }}>
          <Tab title="Status" on={props.tab === "status"} onPress={() => router.setParams({ tab: "status" })} />
          <Tab
            title="Chat"
            on={props.tab === "chat"}
            need={needsYou === true}
            onPress={() => router.setParams({ tab: "chat" })}
          />
        </View>
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: -18,
            height: 18,
            experimental_backgroundImage: `linear-gradient(${color.bg}, rgba(10,10,12,0))`
          }}
        />
      </View>
    </View>
  )
}

/**
 * The tile with its presence dot, the title, and the state line (B), from the live state, else Home's row until
 * the snapshot arrives. Its own component, so the elapsed time ticking each second redraws only this.
 */
function Identity(props: {
  readonly project: ProjectRecord | undefined
  readonly state: ProjectState | undefined
  readonly summary: ProjectSummary | undefined
}) {
  const { project, state, summary } = props
  const activity = state ? state.activity : summary?.activity
  const now = useTickingNow(activity?.state === "working" || state?.working === true)
  const presence = presenceOf({
    activity,
    working: state?.working ?? false,
    pausedUntil: state ? state.status.pausedUntil : summary?.pausedUntil,
    now
  })
  const line = project
    ? headerLine(presence, {
        now,
        harness: project.harness,
        openAsks: state ? state.messages.filter(needsThem).length : (summary?.openAsks ?? 0),
        messages: state?.messages ?? []
      })
    : undefined
  return (
    <>
      <PresenceTile icon={project?.icon} size="md" dot={dotOf(presence)} />
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          style={{ fontSize: 20, fontWeight: "700", letterSpacing: -0.7, lineHeight: 22, color: color.t1 }}
        >
          {project?.title ?? ""}
        </Text>
        {line ? (
          <StateLineText line={line} style={{ fontSize: 13, marginTop: 1 }} />
        ) : project?.kind ? (
          <Text style={{ fontSize: 13, color: color.t3, marginTop: 1 }}>{project.kind}</Text>
        ) : null}
      </View>
    </>
  )
}

const needsThem = (m: Message) => m._tag !== "Text" && m.state._tag === "Open" && !(m._tag === "Access" && m.when)

function Tab(props: {
  readonly title: string
  readonly on: boolean
  readonly need?: boolean
  readonly onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: props.on }}
      onPress={props.onPress}
      style={{ paddingTop: 10, paddingBottom: 12, flexDirection: "row", alignItems: "center", gap: 7 }}
    >
      <Text style={{ fontSize: 16, fontWeight: "600", letterSpacing: -0.16, color: props.on ? color.t1 : color.t3 }}>
        {props.title}
      </Text>
      {props.need ? <Dot kind="need" /> : null}
      {props.on ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: -1,
            height: 2,
            borderRadius: 1,
            backgroundColor: color.t1
          }}
        />
      ) : null}
    </Pressable>
  )
}
