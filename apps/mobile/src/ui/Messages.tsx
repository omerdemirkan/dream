/**
 * The three kinds of message Dream sends, as they sit in Chat: text (with
 * media), a question, and an access request, plus their resolved rows.
 * Questions and access requests open into the expanded view when tapped.
 */
import type { AccessMessage, MediaRef, QuestionMessage, TextMessage } from "@dream/domain"
import * as Clipboard from "expo-clipboard"
import { forwardRef, type ReactNode, useState } from "react"
import { type HostInstance, Pressable, Text, View, useWindowDimensions } from "react-native"
import { answerNowFn, submitKeyAccessFn } from "../state/atoms.ts"
import { accessExplainer, accessLabel, accessScope, isOAuth, whenTag } from "./describe.ts"
import { useAction, useGoogleAccess } from "./actions.ts"
import { GoogleButton, Choices, Icon } from "./kit.tsx"
import { Markdown } from "./Markdown.tsx"
import { MediaTile } from "./Media.tsx"
import { color, gutter, needGlow } from "./theme.ts"

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export function UserBubble(props: { readonly message: TextMessage; readonly time: string | undefined }) {
  return (
    <View style={{ alignSelf: "flex-end", alignItems: "flex-end", maxWidth: "82%" }}>
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
      {props.time ? <Time text={props.time} /> : null}
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
  return (
    <View style={{ maxWidth: "94%" }}>
      <Markdown source={props.message.text} />
      <Attachments media={props.message.media} />
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
            ? { padding: 14, backgroundColor: color.s1, borderWidth: 1, borderStyle: "dashed", borderColor: color.line2 }
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

function CardHead(props: { readonly label: string; readonly later?: boolean; readonly tag?: string | undefined }) {
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

function CardTitle(props: { readonly children: string }) {
  return (
    <Text style={{ fontSize: 19, lineHeight: 23, fontWeight: "600", letterSpacing: -0.48, color: color.t1, paddingHorizontal: 2 }}>
      {props.children}
    </Text>
  )
}

function CardText(props: { readonly children: string }) {
  return (
    <Text style={{ fontSize: 14, lineHeight: 20, color: color.t2, marginTop: 6, marginHorizontal: 2 }}>{props.children}</Text>
  )
}

/** A resolved question or access request: a quiet row in place (`.msg.done`). */
function ResolvedRow(props: {
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
        <Icon name={props.check ? "check" : "close"} size={11} color={props.check ? color.black : color.t2} weight="bold" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 11, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: color.t3 }}>
          {props.label}
        </Text>
        <Text
          numberOfLines={2}
          style={
            props.strong
              ? { fontSize: 15.5, lineHeight: 20, fontWeight: "600", color: color.t1, marginTop: 3 }
              : { fontSize: 14.5, lineHeight: 20, color: color.t2, marginTop: 3 }
          }
        >
          {props.title}
        </Text>
        <Text style={{ fontSize: 14.5, color: color.t2, marginTop: 5 }}>{props.detail}</Text>
      </View>
      <Icon name="chev" size={14} color={color.t3} style={{ marginTop: 1 }} />
    </>
  )
}

export const answerText = (message: QuestionMessage) =>
  message.state._tag === "Answered"
    ? message.state.answer._tag === "Choice"
      ? message.state.answer.option
      : message.state.answer.text
    : undefined

export const QuestionCard = forwardRef<HostInstance, { readonly message: QuestionMessage; readonly onOpen: () => void }>(
  function QuestionCard(props, ref) {
    const m = props.message
    const answer = useAction(answerNowFn)
    const [picked, setPicked] = useState<string | undefined>(undefined)
    if (m.state._tag === "Answered") {
      const said = m.state.answer._tag === "Choice" ? "You chose" : "You said"
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
              </>
            }
          />
        </Card>
      )
    }
    if (m.state._tag === "Withdrawn") {
      return (
        <Card ref={ref} tone="done" onOpen={props.onOpen}>
          <ResolvedRow label="Question · no longer needed" title={m.question} check={false} detail="Dream doesn’t need this anymore." />
        </Card>
      )
    }
    return (
      <Card ref={ref} tone="need" onOpen={props.onOpen}>
        <CardHead label="Question" />
        <CardTitle>{m.question}</CardTitle>
        {m.why ? <CardText>{m.why}</CardText> : null}
        <Choices
          options={m.options}
          selected={picked}
          size="sm"
          style={{ marginTop: 14 }}
          onPick={(option) => {
            setPicked(option)
            answer.run(
              { projectId: m.projectId, messageId: m.id, answer: { _tag: "Choice", option } },
              { onFailure: () => setPicked(undefined) }
            )
          }}
        />
      </Card>
    )
  }
)

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
      <Text style={key ? { flex: 1, color: color.t1, letterSpacing: 2, fontSize: 14 } : { flex: 1, color: color.t3, fontSize: 15 }}>
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
          {key ? "Save to vault" : "Paste"}
        </Text>
      </Pressable>
    </View>
  )
}

function OpenAccessBody(props: { readonly message: AccessMessage; readonly onOpen: () => void }) {
  const m = props.message
  const google = useGoogleAccess(m)
  switch (m.request._tag) {
    case "Google":
      return <GoogleButton compact busy={google.busy} onPress={google.start} />
    case "Key":
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
  }
}

export const AccessCard = forwardRef<HostInstance, { readonly message: AccessMessage; readonly onOpen: () => void }>(
  function AccessCard(props, ref) {
    const m = props.message
    const label = accessLabel(m.request)
    const scope = accessScope(m.request)
    if (m.state._tag === "Connected") {
      return (
        <Card ref={ref} tone="done" onOpen={props.onOpen}>
          <ResolvedRow
            label="Access · connected"
            title={m.request._tag === "Apple" ? "Apple Developer key saved" : `${label} connected`}
            strong
            check
            detail={`${scope ? `${scope} ` : ""}Shared with all your projects`}
          />
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
            detail="You said not now. Tap to connect it anyway."
          />
        </Card>
      )
    }
    const later = m.when !== undefined
    return (
      <Card ref={ref} tone={later ? "later" : "need"} onOpen={props.onOpen}>
        <CardHead label={later ? "Access · later" : "Access"} later={later} tag={m.when ? whenTag(m.when) : undefined} />
        <CardTitle>{m.why}</CardTitle>
        <CardText>{accessExplainer(m)}</CardText>
        <OpenAccessBody message={m} onOpen={props.onOpen} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 13, marginHorizontal: 2 }}>
          <Icon name="layers" size={14} color={color.t2} />
          <Text style={{ fontSize: 13, color: color.t2 }}>
            {isOAuth(m.request) ? "Connect once — every project can use it." : "Add it once — every project can use it."}
          </Text>
        </View>
      </Card>
    )
  }
)
