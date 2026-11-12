/**
 * A project: Chat (only what Dream chose to send) with the Status card pinned
 * under the header, which opens over Chat into the whole roadmap.
 *
 * `?tab=status` opens the roadmap and `?tab=chat` folds it; `?focus=<messageId>`
 * opens that question or access request expanded (deep links and notifications
 * use these). `?sheet=usage` opens the usage sheet, as tapping the ring in the header does (`?sheet=costs` with
 * what Dream paid opened, `?sheet=adjust` at its Adjust page, `?sheet=plan` there asking to move the project to
 * their other plan), and
 * `?sheet=notifications` the Notifications sheet, as the bell does (shown once one of its apps has asked to notify
 * them). `?work=<workstream id>` writes to that workstream, as tapping its row on the card does.
 * `?options=<messageId>&option=<n>` opens a question's option previews full screen at option n.
 * `?thread=<messageId>` opens that message's thread (`&compose=1` gives its composer the keyboard), and
 * `?hold=<messageId>` holds that message, bringing up its menu.
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
import { DateTime, Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Keyboard, Text, type TextInputInstance, View } from "react-native"
import { KeyboardStickyView } from "react-native-keyboard-controller"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { dotOf, headerLine, presenceOf } from "../../data/presence.ts"
import type { ProjectState } from "../../data/projectState.ts"
import { draftKey } from "../../data/Replies.ts"
import { useViewingProject } from "../../platform/viewing.ts"
import {
  clearDraftFn,
  draftAtom,
  projectConnectionAtom,
  projectsAtom,
  reconnectProjectsFn,
  sendMessageFn
} from "../../state/atoms.ts"
import {
  appNotificationsSheetAtom,
  declineAtom,
  focusAtom,
  heldAtom,
  holdRequestAtom,
  landingAtom,
  threadOpenAtom
} from "../../state/ui.ts"
import { useAction } from "../../ui/actions.ts"
import { AppNotificationsSheet, useOpenAppNotifications } from "../../ui/AppNotifications.tsx"
import { ChatTab } from "../../ui/Chat.tsx"
import { samplesFor } from "../../ui/attachmentSamples.ts"
import { useStagedAttachments } from "../../ui/Attachments.tsx"
import { ChatComposer } from "../../ui/Composer.tsx"
import { HoldMenu } from "../../ui/HoldMenu.tsx"
import { ThreadView } from "../../ui/Thread.tsx"
import { LayerBoundary } from "../../ui/ErrorBoundary.tsx"
import { useKeyboardShown, useOpenMessage, usePlanMissing, useProject, useRequestId } from "../../ui/hooks.ts"
import { useOpenOptions } from "../../ui/Options.tsx"
import { hideKeyboard, IconButton } from "../../ui/kit.tsx"
import { PresenceTile, StateLineText, useTickingNow } from "../../ui/Presence.tsx"
import { RoadmapSheet, StatusCardPin } from "../../ui/StatusCard.tsx"
import { labelsOf } from "../../ui/statusView.ts"
import { UsageBadge } from "../../ui/Usage.tsx"
import { UsageSheet, type UsageSheetStart } from "../../ui/UsageSheet.tsx"
import { WaitingCard, WaitingLine } from "../../ui/Waiting.tsx"
import { color, gutter } from "../../ui/theme.ts"

const decodeProjectId = Schema.decodeUnknownOption(ProjectId)
const decodeMessageId = Schema.decodeUnknownOption(MessageId)

/** The back button, icon and title row. */
const header = 48
/** Between the header and the card, and between the card and Chat's first message. */
const gap = 8
/** `?sheet=` values that open the usage sheet, and where. */
const usageStarts: Readonly<Record<string, UsageSheetStart>> = {
  usage: "summary",
  costs: "costs",
  adjust: "adjust",
  plan: "move"
}

export default function ProjectScreen() {
  const params = useLocalSearchParams<{
    id: string
    tab?: string
    focus?: string
    land?: string
    decline?: string
    sheet?: string
    work?: string
    options?: string
    option?: string
    thread?: string
    compose?: string
    hold?: string
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
      options={params.options}
      option={params.option}
      thread={params.thread}
      compose={params.compose}
      hold={params.hold}
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
  readonly options: string | undefined
  readonly option: string | undefined
  readonly thread: string | undefined
  readonly compose: string | undefined
  readonly hold: string | undefined
  readonly attach: string | undefined
}) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const open = useOpenMessage()
  // While this screen is in front, its own notifications stay quiet: what they'd say arrives here anyway.
  useViewingProject(props.projectId)
  // What it showed last this session, at once, until the live connection's snapshot replaces it.
  const state = useProject(props.projectId)
  const connection = Option.getOrElse(
    AsyncResult.value(useAtomValue(projectConnectionAtom(props.projectId))),
    () => "connecting" as const
  )
  const retry = useAtomSet(reconnectProjectsFn)
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

  // `?options=<messageId>&option=<n>`: that question's option previews full screen, at option n (from 0).
  const openOptions = useOpenOptions()
  useEffect(() => {
    const messageId = Option.getOrUndefined(decodeMessageId(props.options))
    const message = messageId ? state?.messages.find((m) => m.id === messageId) : undefined
    if (message?._tag !== "Question") return
    openOptions(message, Number(props.option ?? 0) || 0)
    router.setParams({ options: undefined, option: undefined })
  }, [props.options, props.option, state, router, openOptions])

  // A message's thread, over Chat: from its folded line, Reply, a swipe, a notification about a reply, `?thread=`.
  const threadOpen = Option.getOrUndefined(useAtomValue(threadOpenAtom))
  const setThread = useAtomSet(threadOpenAtom)
  const thread = threadOpen?.projectId === props.projectId ? threadOpen : undefined
  useEffect(() => {
    const messageId = Option.getOrUndefined(decodeMessageId(props.thread))
    if (!messageId) return
    setThread(Option.some({ projectId: props.projectId, messageId, compose: props.compose === "1", at: Date.now() }))
    router.setParams({ thread: undefined, compose: undefined })
  }, [props.thread, props.compose, props.projectId, router, setThread])
  const setHoldRequest = useAtomSet(holdRequestAtom)
  useEffect(() => {
    const messageId = Option.getOrUndefined(decodeMessageId(props.hold))
    if (!messageId) return
    setHoldRequest(Option.some(messageId))
    router.setParams({ hold: undefined })
  }, [props.hold, router, setHoldRequest])
  // Leaving the project closes its thread and any held message.
  const setHeld = useAtomSet(heldAtom)
  useFocusEffect(
    useCallback(
      () => () => {
        setHeld(Option.none())
        setThread((open) => (Option.isSome(open) && open.value.projectId === props.projectId ? Option.none() : open))
      },
      [setHeld, setThread, props.projectId]
    )
  )

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
  const [usageStart, setUsageStart] = useState<UsageSheetStart>("summary")
  const openNotifications = useOpenAppNotifications()
  useEffect(() => {
    const start = usageStarts[props.sheet ?? ""]
    if (start) {
      setUsageStart(start)
      setUsage(true)
    } else if (props.sheet === "notifications") openNotifications(props.projectId)
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
  const typing = useKeyboardShown()
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

  // Writing to one workstream: from its row on the card, or `?work=`. Only while the card shows rows, and only to one
  // that's still active. (Replying to one of its messages goes in that message's thread, and so into it too.)
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
          />
          <KeyboardStickyView
            offset={{ opened: keyboardOffset }}
            style={{ paddingHorizontal: 16, paddingBottom: composerBottom, paddingTop: 10 }}
          >
            <WaitingLine connection={connection} onRetry={() => retry()} />
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
          {typing ? (
            // While they type, the keyboard's way down takes the place of the bell and the ring.
            <IconButton
              icon="keyboardDown"
              size={38}
              label="Hide the keyboard"
              onPressIn={hideKeyboard}
              onPress={hideKeyboard}
            />
          ) : (
            <>
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
              <UsageBadge
                projectId={props.projectId}
                pausedBy={pausedByLimit(state, summary)}
                onPress={() => setUsage(true)}
              />
            </>
          )}
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
        ) : (
          <View style={{ marginTop: gap }}>
            <WaitingCard connection={connection} title={project?.title} onRetry={() => retry()} />
          </View>
        )}
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
        project={project}
        open={usage}
        start={usageStart}
        onClose={() => {
          setUsage(false)
          setUsageStart("summary")
        }}
      />
      <AppNotificationsSheet projectId={props.projectId} title={project?.title ?? ""} />
      {state && thread ? (
        <LayerBoundary closes={threadOpenAtom}>
          <ThreadView
            key={thread.messageId}
            state={state}
            open={thread}
            label={labelOf(state.messages, thread.messageId, labels)}
            onClose={() => setThread(Option.none())}
          />
        </LayerBoundary>
      ) : null}
      <HoldMenu projectId={props.projectId} />
    </View>
  )
}

/** The workstream label of a thread's first message, while the card shows rows. */
const labelOf = (
  messages: ReadonlyArray<Message>,
  messageId: MessageId,
  labels: ReadonlyMap<WorkstreamId, string> | undefined
): string | undefined => {
  const workstream = messages.find((m) => m.id === messageId)?.workstream
  return workstream === undefined ? undefined : labels?.get(workstream)
}

/** The limit they set that holds the project now, from the live state, else Home's row. */
const pausedByLimit = (state: ProjectState | undefined, summary: ProjectSummary | undefined) => {
  const until = state ? state.status.pausedUntil : summary?.pausedUntil
  if (until === undefined || !DateTime.isGreaterThan(until, DateTime.nowUnsafe())) return undefined
  return state ? state.status.pausedBy : summary?.pausedBy
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
  const missing = usePlanMissing(project?.harness)
  const presence = presenceOf({
    activity,
    working: state?.working ?? false,
    pausedUntil: state ? state.status.pausedUntil : summary?.pausedUntil,
    planMissing: missing,
    pausedBy: state ? state.status.pausedBy : summary?.pausedBy,
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
