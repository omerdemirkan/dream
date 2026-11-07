/**
 * The three kinds of message Dream sends, as they sit in Chat: text (with
 * media), a question, and an access request, plus their resolved rows.
 * Questions and access requests open into the expanded view when tapped.
 */
import { type AccessMessage, accessHeading, type MediaRef, type QuestionMessage, type TextMessage } from "@dream/domain"
import * as Clipboard from "expo-clipboard"
import { forwardRef, type ReactNode, useState } from "react"
import { type HostInstance, Pressable, Text, View, useWindowDimensions } from "react-native"
import { unsupportedText } from "../data/Tolerant.ts"
import { answerNowFn, submitKeyAccessFn } from "../state/atoms.ts"
import {
  accessExplainer,
  accessLabel,
  accessReach,
  accessScope,
  disconnectedNote,
  isKeyFile,
  isOAuth,
  keyFileWarning,
  whenTag
} from "./describe.ts"
import { useAction, useSignInAccess, useToast } from "./actions.ts"
import { FinishOnComputer } from "./Desktop.tsx"
import { useAskPush } from "./hooks.ts"
import { Button, GoogleButton, Choices, Icon, SignInButton } from "./kit.tsx"
import { Markdown, MarkdownText } from "./Markdown.tsx"
import { useDecline } from "./Decline.tsx"
import { SentAttachments } from "./Attachments.tsx"
import { MediaTile } from "./Media.tsx"
import { OptionThumbs, useOpenOptions } from "./Options.tsx"
import { hasPreviews } from "./optionsLayout.ts"
import { Receipt } from "./Presence.tsx"
import { color, gutter, needGlow } from "./theme.ts"

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function UserBubble(props: {
  readonly message: TextMessage
  readonly time: string | undefined
  /** On their latest message: "Sent", then "Seen" once Dream began delivering it to the agent's machine. */
  readonly receipt?: { readonly seen: boolean } | undefined
}) {
  const attachments = props.message.attachments ?? []
  return (
    <View style={{ alignSelf: "flex-end", alignItems: "flex-end", maxWidth: "82%" }}>
      {attachments.length > 0 ? <SentAttachments attachments={attachments} /> : null}
      {props.message.text.trim().length === 0 && attachments.length > 0 ? null : (
        <View
          style={{
            backgroundColor: color.s2,
            paddingVertical: 10,
            paddingHorizontal: 15,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            borderBottomRightRadius: 6,
            borderBottomLeftRadius: 20,
            borderWidth: 1,
            borderColor: color.line
          }}
        >
          <Text selectable style={{ fontSize: 16, lineHeight: 22.7, letterSpacing: -0.16, color: color.t1 }}>
            {props.message.text}
          </Text>
        </View>
      )}
      {props.receipt ? (
        <Receipt seen={props.receipt.seen} sentAt={props.message.createdAt} showTime={props.time !== undefined} />
      ) : props.time ? (
        <Time text={props.time} />
      ) : null}
    </View>
  )
}

function Time(props: { readonly text: string }) {
  return <Text style={{ fontSize: 12, color: color.t3, marginTop: 6 }}>{props.text}</Text>
}

function Attachments(props: { readonly media: ReadonlyArray<MediaRef> }) {
  const { width } = useWindowDimensions()
  const media = props.media
  if (media.length === 0) return null
  if (media.length === 1) {
    const only = media[0]
    if (!only) return null
    const landscape = (only.width ?? 9) > (only.height ?? 16)
    const w = landscape ? Math.min(width - gutter * 2, 320) : 136
    const h = only.width && only.height ? Math.round((w * only.height) / only.width) : 240
    return <MediaTile media={only} width={w} height={Math.min(h, 320)} style={{ marginTop: 12 }} />
  }
  const columns = Math.min(3, media.length)
  const tileWidth = Math.floor((width - gutter * 2 - (columns - 1) * 10) / columns)
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16 }}>
      {media.map((m) => (
        <MediaTile key={m.id} media={m} width={tileWidth} height={Math.round(tileWidth * 1.1)} />
      ))}
    </View>
  )
}

export function AgentText(props: { readonly message: TextMessage; readonly time: string | undefined }) {
  if (props.message.text === unsupportedText) return <Unsupported time={props.time} />
  return (
    <View style={{ maxWidth: "94%" }}>
      <Markdown source={props.message.text} />
      <Attachments media={props.message.media} />
      {props.time ? <Time text={props.time} /> : null}
    </View>
  )
}

/** Stands in for a message this build can't decode (`Tolerant`): a notice from the app, not the agent's words. */
function Unsupported(props: { readonly time: string | undefined }) {
  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingVertical: 12,
          paddingHorizontal: 14,
          borderRadius: 16,
          borderWidth: 1,
          borderStyle: "dashed",
          borderColor: color.line2
        }}
      >
        <Icon name="doc" size={16} color={color.t3} />
        <Text style={{ flex: 1, fontSize: 14.5, lineHeight: 20, color: color.t2 }}>
          {unsupportedText.replace(/^_|_$/g, "")}
        </Text>
      </View>
      {props.time ? <Time text={props.time} /> : null}
    </View>
  )
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

type CardProps = { readonly onOpen: () => void; readonly children: ReactNode; readonly tone: "need" | "later" | "done" }

/** `.msg`: the tappable card that expands. */
export const Card = forwardRef<HostInstance, CardProps>(function Card(props, ref) {
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityHint="Opens it full screen"
      onPress={props.onOpen}
      style={({ pressed }) => [
        { borderRadius: 24, opacity: pressed ? 0.92 : 1 },
        props.tone === "need"
          ? {
              padding: 14,
              backgroundColor: color.s1,
              experimental_backgroundImage: needGlow,
              borderWidth: 1,
              borderColor: color.needLine
            }
          : props.tone === "later"
            ? {
                padding: 14,
                backgroundColor: color.s1,
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: color.line2
              }
            : {
                flexDirection: "row",
                gap: 12,
                alignItems: "flex-start",
                paddingVertical: 13,
                paddingHorizontal: 14,
                backgroundColor: color.s1,
                borderWidth: 1,
                borderColor: color.line
              }
      ]}
    >
      {props.children}
    </Pressable>
  )
})

export function CardHead(props: {
  readonly label: string
  readonly later?: boolean
  readonly tag?: string | undefined
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 9 }}>
      <Text
        style={{
          fontSize: 11,
          fontWeight: "600",
          letterSpacing: 1,
          textTransform: "uppercase",
          color: props.later ? color.t2 : color.need
        }}
      >
        {props.label}
      </Text>
      {props.tag ? (
        <Text
          style={{
            fontSize: 12,
            color: color.t2,
            paddingVertical: 2,
            paddingHorizontal: 9,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: color.line2,
            overflow: "hidden"
          }}
        >
          {props.tag}
        </Text>
      ) : null}
      <View style={{ flex: 1 }} />
      <Icon name="expand" size={14} color={color.t3} />
    </View>
  )
}

type Clamp = { readonly lines?: number; readonly onClamp?: (clamped: boolean) => void }

/** The heading, in the agent's markdown; a question that runs long is clamped (`ReadMore` opens the rest). */
function CardTitle(props: { readonly children: string } & Clamp) {
  return (
    <MarkdownText
      source={props.children}
      numberOfLines={props.lines}
      onClamp={props.onClamp}
      style={{
        fontSize: 19,
        lineHeight: 23,
        fontWeight: "600",
        letterSpacing: -0.48,
        color: color.t1,
        paddingHorizontal: 2
      }}
    />
  )
}

function CardText(props: { readonly children: string } & Clamp) {
  return (
    <MarkdownText
      source={props.children}
      numberOfLines={props.lines}
      onClamp={props.onClamp}
      style={{ fontSize: 14, lineHeight: 20, color: color.t2, marginTop: 6, marginHorizontal: 2 }}
    />
  )
}

/** A question's context, at body size: its first few lines, the rest when expanded. */
function CardContext(props: { readonly children: string } & Clamp) {
  return (
    <MarkdownText
      source={props.children}
      numberOfLines={props.lines}
      onClamp={props.onClamp}
      style={{ fontSize: 15, lineHeight: 21, letterSpacing: -0.1, color: color.t1, marginTop: 10, marginHorizontal: 2 }}
    />
  )
}

/** Which parts of a card were cut short, so it can say there's more. */
function useClamps() {
  const [cut, setCut] = useState<ReadonlySet<string>>(new Set())
  const track = (part: string) => (clamped: boolean) =>
    setCut((parts) => {
      if (parts.has(part) === clamped) return parts
      const next = new Set(parts)
      if (clamped) next.add(part)
      else next.delete(part)
      return next
    })
  return { clamped: cut.size > 0, track }
}

/** Under a clamped card: the way to the rest, which the expanded view shows. */
export function ReadMore(props: { readonly onOpen: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onOpen}
      hitSlop={8}
      style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 8, marginHorizontal: 2 }}
    >
      <Text style={{ fontSize: 14, fontWeight: "600", color: color.t1 }}>Read all</Text>
      <Icon name="chev" size={12} color={color.t2} />
    </Pressable>
  )
}

/** A resolved question or access request: a quiet row in place (`.msg.done`). */
export function ResolvedRow(props: {
  readonly label: string
  readonly title: string
  readonly strong?: boolean
  readonly detail: ReactNode
  readonly check: boolean
}) {
  return (
    <>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          marginTop: 1,
          backgroundColor: props.check ? color.t1 : color.s3,
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        <Icon
          name={props.check ? "check" : "close"}
          size={11}
          color={props.check ? color.black : color.t2}
          weight="bold"
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text
          style={{ fontSize: 11, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: color.t3 }}
        >
          {props.label}
        </Text>
        <MarkdownText
          source={props.title}
          numberOfLines={2}
          style={
            props.strong
              ? { fontSize: 15.5, lineHeight: 20, fontWeight: "600", color: color.t1, marginTop: 3 }
              : { fontSize: 14.5, lineHeight: 20, color: color.t2, marginTop: 3 }
          }
        />
        <Text style={{ fontSize: 14.5, color: color.t2, marginTop: 5 }}>{props.detail}</Text>
      </View>
      <Icon name="chev" size={14} color={color.t3} style={{ marginTop: 1 }} />
    </>
  )
}

/** The note they added to their pick, if any. */
export const noteOf = (message: QuestionMessage): string | undefined =>
  message.state._tag === "Answered" && message.state.answer._tag === "Choice" ? message.state.answer.note : undefined

export const answerText = (message: QuestionMessage) =>
  message.state._tag === "Answered"
    ? message.state.answer._tag === "Choice"
      ? message.state.answer.option
      : message.state.answer.text
    : undefined

export const QuestionCard = forwardRef<
  HostInstance,
  {
    readonly message: QuestionMessage
    readonly onOpen: () => void
    /** The answer went through (Chat then moves on to the next open card). */
    readonly onAnswered?: (() => void) | undefined
  }
>(function QuestionCard(props, ref) {
  const m = props.message
  const answer = useAction(answerNowFn)
  const askPush = useAskPush()
  const toast = useToast()
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const clamps = useClamps()
  const openOptions = useOpenOptions()
  const window = useWindowDimensions()
  const previews = hasPreviews(m)
  if (m.state._tag === "Answered") {
    const said = m.state.answer._tag === "Choice" ? "You chose" : "You said"
    const note = noteOf(m)
    return (
      <Card ref={ref} tone="done" onOpen={props.onOpen}>
        <ResolvedRow
          label="Question · answered"
          title={m.question}
          check
          detail={
            <>
              {`${said} · `}
              <Text style={{ color: color.t1, fontWeight: "600" }}>{answerText(m)}</Text>
              {note ? `\n“${note}”` : null}
            </>
          }
        />
      </Card>
    )
  }
  if (m.state._tag === "Withdrawn") {
    return (
      <Card ref={ref} tone="done" onOpen={props.onOpen}>
        <ResolvedRow
          label="Question · no longer needed"
          title={m.question}
          check={false}
          detail="Dream doesn’t need this anymore."
        />
      </Card>
    )
  }
  return (
    <Card ref={ref} tone="need" onOpen={props.onOpen}>
      <CardHead label="Question" />
      <CardTitle lines={4} onClamp={clamps.track("question")}>
        {m.question}
      </CardTitle>
      {m.why ? (
        <CardText lines={3} onClamp={clamps.track("why")}>
          {m.why}
        </CardText>
      ) : null}
      {m.context ? (
        <CardContext lines={4} onClamp={clamps.track("context")}>
          {m.context}
        </CardContext>
      ) : null}
      {clamps.clamped ? <ReadMore onOpen={props.onOpen} /> : null}
      {previews ? (
        <>
          <OptionThumbs
            message={m}
            inner={window.width - 2 * gutter - 30}
            bleed={gutter + 15}
            style={{ marginTop: 14 }}
          />
          <Button title="Compare full screen" onPress={() => openOptions(m, 0)} style={{ marginTop: 14 }} />
        </>
      ) : (
        <Choices
          options={m.options}
          selected={picked}
          size="sm"
          style={{ marginTop: 14 }}
          onPick={(option) => {
            setPicked(option)
            answer.run(
              { projectId: m.projectId, messageId: m.id, answer: { _tag: "Choice", option } },
              {
                onSuccess: () => {
                  askPush()
                  props.onAnswered?.()
                },
                onFailure: (message) => {
                  setPicked(undefined)
                  toast(message)
                }
              }
            )
          }}
        />
      )}
    </Card>
  )
})

/** The inline paste field on a key request (`.secure.sm`). */
function InlineKey(props: { readonly message: AccessMessage }) {
  const [key, setKey] = useState<string | undefined>(undefined)
  const submit = useAction(submitKeyAccessFn)
  const m = props.message
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        height: 48,
        marginTop: 14,
        paddingLeft: 14,
        paddingRight: 6,
        borderRadius: 15,
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: color.line2
      }}
    >
      <Icon name="key" size={17} color={color.t2} />
      <Text
        style={
          key
            ? { flex: 1, color: color.t1, letterSpacing: 2, fontSize: 14 }
            : { flex: 1, color: color.t3, fontSize: 15 }
        }
      >
        {key ? "••••••••••••" : "Paste key"}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          if (key) submit.run({ projectId: m.projectId, messageId: m.id, key })
          else void Clipboard.getStringAsync().then((text) => text.trim() && setKey(text.trim()))
        }}
        style={({ pressed }) => ({
          height: 36,
          paddingHorizontal: 14,
          borderRadius: 18,
          justifyContent: "center",
          backgroundColor: key ? color.t1 : color.s3,
          opacity: pressed || submit.busy ? 0.8 : 1
        })}
      >
        <Text style={{ fontSize: 14, fontWeight: "600", color: key ? color.black : color.t1 }}>
          {key ? (isKeyFile(m.request) ? "Save" : "Save to vault") : "Paste"}
        </Text>
      </Pressable>
    </View>
  )
}

function OpenAccessBody(props: { readonly message: AccessMessage; readonly onOpen: () => void }) {
  const m = props.message
  const signIn = useSignInAccess(m)
  switch (m.request._tag) {
    case "Google":
      return <GoogleButton compact busy={signIn.busy} onPress={signIn.start} />
    case "OAuth":
      return <SignInButton compact service={signIn.service} busy={signIn.busy} onPress={signIn.start} />
    case "Key":
    case "File":
      return <InlineKey message={m} />
    case "Apple":
      return (
        <Pressable
          accessibilityRole="button"
          onPress={props.onOpen}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            height: 48,
            marginTop: 14,
            paddingHorizontal: 14,
            borderRadius: 15,
            backgroundColor: pressed ? color.s2 : color.s1,
            borderWidth: 1,
            borderColor: color.line2
          })}
        >
          <Icon name="key" size={17} color={color.t2} />
          <Text style={{ flex: 1, color: color.t3, fontSize: 15 }}>Add App Store Connect key</Text>
          <Icon name="chev" size={14} color={color.t3} />
        </Pressable>
      )
    case "Notifications":
      return null
  }
}

/** The card's quiet "Don't connect", which opens the decline sheet. */
function DeclineLink(props: { readonly message: AccessMessage }) {
  const decline = useDecline(props.message)
  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={decline.open}
        hitSlop={8}
        style={({ pressed }) => ({
          alignSelf: "flex-start",
          marginTop: 12,
          marginHorizontal: 2,
          opacity: pressed ? 0.5 : 1
        })}
      >
        <Text style={{ fontSize: 14, color: color.t2 }}>Don’t connect</Text>
      </Pressable>
    </>
  )
}

export const AccessCard = forwardRef<HostInstance, { readonly message: AccessMessage; readonly onOpen: () => void }>(
  function AccessCard(props, ref) {
    const m = props.message
    const label = accessLabel(m.request)
    const scope = accessScope(m.request)
    const clamps = useClamps()
    if (m.state._tag === "Connected") {
      return (
        <Card ref={ref} tone="done" onOpen={props.onOpen}>
          <ResolvedRow
            label="Access · connected"
            title={
              m.request._tag === "Apple"
                ? "Apple Developer key saved"
                : isKeyFile(m.request)
                  ? `${label} key saved`
                  : `${label} connected`
            }
            strong
            check
            detail={`${scope ? `${scope} ` : ""}${accessReach(m.request)}`}
          />
        </Card>
      )
    }
    const gone = disconnectedNote(m)
    if (gone) {
      return (
        <Card ref={ref} tone="done" onOpen={props.onOpen}>
          <ResolvedRow label={gone.eyebrow} title={gone.title} strong check={false} detail={gone.detail} />
        </Card>
      )
    }
    if (m.state._tag === "Declined") {
      return (
        <Card ref={ref} tone="done" onOpen={props.onOpen}>
          <ResolvedRow
            label="Access · not connected"
            title={label}
            strong
            check={false}
            detail={
              m.state.reason ? (
                <>
                  {"You said: "}
                  <Text style={{ color: color.t1 }}>{`“${m.state.reason}”`}</Text>
                  {" · Tap to connect it anyway."}
                </>
              ) : (
                "You said not now. Tap to connect it anyway."
              )
            }
          />
        </Card>
      )
    }
    const later = m.when !== undefined
    const heading = accessHeading(m)
    return (
      <Card ref={ref} tone={later ? "later" : "need"} onOpen={props.onOpen}>
        <CardHead
          label={later ? "Access · later" : "Access"}
          later={later}
          tag={m.when ? whenTag(m.when) : undefined}
        />
        <CardTitle lines={4}>{heading.title}</CardTitle>
        {heading.reason ? (
          <MarkdownText
            source={heading.reason}
            numberOfLines={2}
            style={{ fontSize: 15, lineHeight: 21, color: color.t1, marginTop: 6, marginHorizontal: 2 }}
          />
        ) : null}
        {/* Where to get the key says more than how Dream uses it; the expanded view has both. */}
        {m.context ? (
          <CardContext lines={4} onClamp={clamps.track("context")}>
            {m.context}
          </CardContext>
        ) : (
          <CardText>{accessExplainer(m)}</CardText>
        )}
        {clamps.clamped ? <ReadMore onOpen={props.onOpen} /> : null}
        <OpenAccessBody message={m} onOpen={props.onOpen} />
        {isKeyFile(m.request) ? (
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 13, marginHorizontal: 2 }}>
            <Icon name="warn" size={14} color={color.need} style={{ marginTop: 2 }} />
            <Text style={{ flex: 1, fontSize: 13, lineHeight: 18, color: color.t1 }}>{keyFileWarning}</Text>
          </View>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 13, marginHorizontal: 2 }}>
            <Icon name="layers" size={14} color={color.t2} />
            <Text style={{ fontSize: 13, color: color.t2 }}>
              {isOAuth(m.request)
                ? "Connect once — every project can use it."
                : "Add it once — every project can use it."}
            </Text>
          </View>
        )}
        <FinishOnComputer message={m} />
        {later ? null : <DeclineLink message={m} />}
      </Card>
    )
  }
)
