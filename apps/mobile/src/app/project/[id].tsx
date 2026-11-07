/**
 * A project: Chat (only what Dream chose to send) with the Status card pinned
 * under the header, which opens over Chat into the whole roadmap.
 *
 * `?tab=status` opens the roadmap and `?tab=chat` folds it; `?focus=<messageId>`
 * opens that question or access request expanded (deep links and notifications
 * use these). `?sheet=usage` opens the usage sheet, as tapping the ring in the header does, and
 * `?sheet=notifications` the Notifications sheet, as the bell does (shown once one of its apps has asked to notify
 * them). `?work=<workstream id>` writes to that workstream, as tapping its row on the card does.
 */
import {
  type Message,
  MessageId,
  type Project as ProjectRecord,
  ProjectId,
  type ProjectSummary,
  type WorkstreamId
} from "@dream/domain"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Keyboard, Text, type TextInputInstance, View } from "react-native"
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { dotOf, headerLine, presenceOf } from "../../data/presence.ts"
import type { ProjectState } from "../../data/projectState.ts"
import { draftKey } from "../../data/Replies.ts"
import { useViewingProject } from "../../platform/viewing.ts"
import { clearDraftFn, draftAtom, projectsAtom, sendMessageFn } from "../../state/atoms.ts"
import { appNotificationsSheetAtom, declineAtom, focusAtom, landingAtom } from "../../state/ui.ts"
import { useAction } from "../../ui/actions.ts"
import { AppNotificationsSheet, useOpenAppNotifications } from "../../ui/AppNotifications.tsx"
import { ChatTab } from "../../ui/Chat.tsx"
import { samplesFor } from "../../ui/attachmentSamples.ts"
import { useStagedAttachments } from "../../ui/Attachments.tsx"
import { ChatComposer } from "../../ui/Composer.tsx"
import { useOpenMessage, useProject, useRequestId } from "../../ui/hooks.ts"
import { IconButton } from "../../ui/kit.tsx"
import { PresenceTile, StateLineText, useTickingNow } from "../../ui/Presence.tsx"
import { RoadmapSheet, StatusCardPin } from "../../ui/StatusCard.tsx"
import { labelsOf } from "../../ui/statusView.ts"
import { UsageBadge, UsageSheet } from "../../ui/Usage.tsx"
import { color, gutter } from "../../ui/theme.ts"

const decodeProjectId = Schema.decodeUnknownOption(ProjectId)
const decodeMessageId = Schema.decodeUnknownOption(MessageId)

/** The back button, icon and title row. */
const header = 48
/** Between the header and the card, and between the card and Chat's first message. */
const gap = 8

export default function ProjectScreen() {
  const params = useLocalSearchParams<{
    id: string
    tab?: string
    focus?: string
    land?: string
    decline?: string
    sheet?: string
    work?: string
    /** Fixtures: `sample` stages sample attachments in the composer. */
    attach?: string
  }>()
  const projectId = Option.getOrUndefined(decodeProjectId(params.id))
  if (!projectId) return null
  return (
    <Project
      projectId={projectId}
      tab={params.tab === "chat" || params.tab === "status" ? params.tab : undefined}
      focus={params.focus}
      land={params.land}
      decline={params.decline}
      sheet={params.sheet}
      work={params.work}
      attach={params.attach}
    />
  )
}

function Project(props: {
  readonly projectId: ProjectId
  readonly tab: "status" | "chat" | undefined
  readonly focus: string | undefined
  readonly land: string | undefined
  readonly decline: string | undefined
  readonly sheet: string | undefined
  readonly work: string | undefined
  readonly attach: string | undefined
}) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const open = useOpenMessage()
  // While this screen is in front, its own notifications stay quiet: what they'd say arrives here anyway.
  useViewingProject(props.projectId)
  const state = useProject(props.projectId)
  const summaries = Option.getOrUndefined(AsyncResult.value(useAtomValue(projectsAtom)))
  const project = state?.project ?? summaries?.find((s) => s.project.id === props.projectId)?.project
  const send = useAction(sendMessageFn)
  const attachments = useStagedAttachments(samplesFor(props.attach))
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

  // `?decline=<messageId>`: the "Why not?" sheet for that access request, once the project has it.
  const setDecline = useAtomSet(declineAtom)
  useEffect(() => {
    const messageId = Option.getOrUndefined(decodeMessageId(props.decline))
    const message = messageId ? state?.messages.find((m) => m.id === messageId) : undefined
    if (message?._tag !== "Access") return
    setDecline(Option.some(message))
    router.setParams({ decline: undefined })
  }, [props.decline, state, router, setDecline])

  // The roadmap opens over Chat (`?tab=status`) and folds back (`?tab=chat`, or an ask expanding from anywhere,
  // so Back from the expanded view returns to Chat).
  const [roadmap, setRoadmap] = useState(false)
  useEffect(() => {
    if (!props.tab) return
    setRoadmap(props.tab === "status")
    router.setParams({ tab: undefined })
  }, [props.tab, router])
  const focus = Option.getOrUndefined(useAtomValue(focusAtom))
  const expanded = focus?.projectId === props.projectId
  useEffect(() => {
    if (expanded) setRoadmap(false)
  }, [expanded])
  const openRoadmap = useCallback(() => {
    Keyboard.dismiss()
    setRoadmap(true)
  }, [])

  const [usage, setUsage] = useState(false)
  const openNotifications = useOpenAppNotifications()
  useEffect(() => {
    if (props.sheet === "usage") setUsage(true)
    else if (props.sheet === "notifications") openNotifications(props.projectId)
    else return
    router.setParams({ sheet: undefined })
  }, [props.sheet, props.projectId, router, openNotifications])
  // The bell, once one of its apps has asked to notify them.
  const notifies = state?.messages.some((m) => m._tag === "Access" && m.request._tag === "Notifications") === true
  // A modal sheet shows over whatever is in front, so it closes when this screen stops being it (a link or a
  // notification opening another screen).
  const setNotificationsSheet = useAtomSet(appNotificationsSheetAtom)
  useFocusEffect(
    useCallback(
      () => () => {
        setUsage(false)
        // Only this project's: the screen a link opens over this one may have just opened its own.
        setNotificationsSheet((shown) => (Option.contains(shown, props.projectId) ? Option.none() : shown))
      },
      [setNotificationsSheet, props.projectId]
    )
  )

  // The card folds to one line while they read back through Chat, or type.
  const [away, setAway] = useState(false)
  const typing = useKeyboardState((k) => k.isVisible)
  const [cardHeight, setCardHeight] = useState(0)
  const onCardHeight = useCallback(
    (height: number) => setCardHeight((h) => (Math.abs(h - height) > 1 ? height : h)),
    []
  )

  const top = insets.top + 4
  // Messages scrolling up fade out before they reach the Status card, so a line never sits flush against it.
  // Chat starts just below the fade, so its first message isn't dimmed at rest.
  const fade = 28
  const cardTop = top + header + gap
  // The composer sits this far above the home indicator, and 10 pt above the keyboard, riding it as it moves.
  const composerBottom = Math.max(insets.bottom, 12) + 2
  const keyboardOffset = composerBottom - 10

  const summary = summaries?.find((s) => s.project.id === props.projectId)

  // Writing to one workstream: from its row on the card, a swipe on one of its messages, or `?work=`. Only while the
  // card shows rows, and only to one that's still active.
  const status = state?.status
  const labels = useMemo(() => (status ? labelsOf(status) : undefined), [status])
  const [scopeId, setScopeId] = useState<WorkstreamId | undefined>(undefined)
  useEffect(() => {
    if (props.work === undefined) return
    setScopeId(props.work as WorkstreamId)
    router.setParams({ work: undefined })
  }, [props.work, router])
  const scoped = scopeId === undefined ? undefined : status?.workstreams?.find((w) => w.id === scopeId)
  const scope = labels !== undefined && scoped?.state === "active" ? scoped : undefined
  const input = useRef<TextInputInstance>(null)
  const writeTo = useCallback((id: WorkstreamId) => {
    setScopeId(id)
    input.current?.focus()
  }, [])

  return (
    <View style={{ flex: 1, backgroundColor: color.bg }}>
      {state ? (
        <View style={{ flex: 1 }}>
          <ChatTab
            state={state}
            topInset={cardTop + (cardHeight || 150) + fade}
            bottomInset={24}
            keyboardOffset={keyboardOffset}
            onAway={setAway}
            labels={labels}
            scope={scope?.id}
            onReply={writeTo}
          />
          <KeyboardStickyView
            offset={{ opened: keyboardOffset }}
            style={{ paddingHorizontal: 16, paddingBottom: composerBottom, paddingTop: 10 }}
          >
            <ChatComposer
              busy={send.busy}
              draft={draft?.text}
              inputRef={input}
              scope={scope ? { title: scope.title, onClear: () => setScopeId(undefined) } : undefined}
              attachments={attachments}
              onSend={(text, sent, attached) =>
                send.run(
                  {
                    projectId: props.projectId,
                    text,
                    // The same text with other attachments is another message.
                    requestId: requestId.for(attached.length === 0 ? text : `${text}\n${attached.join(",")}`),
                    ...(scope ? { workstream: scope.id } : {}),
                    ...(attached.length === 0 ? {} : { attachments: attached })
                  },
                  {
                    onSuccess: () => {
                      requestId.done()
                      if (draft) clearDraft(chat)
                      setScopeId(undefined)
                      sent()
                    }
                  }
                )
              }
            />
          </KeyboardStickyView>
        </View>
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
          {notifies ? (
            <IconButton
              icon="bell"
              size={38}
              label="Notifications"
              onPress={() => {
                Keyboard.dismiss()
                openNotifications(props.projectId)
              }}
            />
          ) : null}
          <UsageBadge projectId={props.projectId} onPress={() => setUsage(true)} />
        </View>
        {state ? (
          <View style={{ marginTop: gap }}>
            <StatusCardPin
              state={state}
              compact={away || typing}
              onRoadmap={openRoadmap}
              onHeight={onCardHeight}
              scope={scope?.id}
              onScope={writeTo}
            />
          </View>
        ) : null}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: -fade,
            height: fade,
            experimental_backgroundImage: `linear-gradient(${color.bg} 12%, rgba(10,10,12,0))`
          }}
        />
      </View>
      {state ? (
        <RoadmapSheet
          state={state}
          open={roadmap}
          onClose={() => setRoadmap(false)}
          top={cardTop}
          from={away || typing ? 48 : cardHeight}
        />
      ) : null}
      <UsageSheet
        projectId={props.projectId}
        title={project?.title ?? ""}
        open={usage}
        onClose={() => setUsage(false)}
      />
      <AppNotificationsSheet projectId={props.projectId} title={project?.title ?? ""} />
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
