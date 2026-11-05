/**
 * The expanded message: a question or access request, full screen. Same
 * eyebrow and title as the card in Chat; more room, more context, and the
 * fastest ways to answer. "Something else…" (typed or dictated) lives only here.
 */
import type { AccessMessage, Project, QuestionMessage } from "@dream/domain"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import * as Clipboard from "expo-clipboard"
import * as DocumentPicker from "expo-document-picker"
import { File } from "expo-file-system"
import { type ReactNode, useEffect, useState } from "react"
import { Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native"
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming
} from "react-native-reanimated"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { draftKey } from "../data/Replies.ts"
import {
  answerNowFn,
  clearDraftFn,
  declineAccessFn,
  draftAtom,
  disconnectIntegrationFn,
  submitAppleAccessFn,
  submitKeyAccessFn
} from "../state/atoms.ts"
import { useAction, useSignInAccess, useToast } from "./actions.ts"
import { ElseComposer } from "./Composer.tsx"
import {
  accessExplainer,
  accessLabel,
  accessReach,
  accessScope,
  disconnectedNote,
  isKeyFile,
  isOAuth,
  whenTag
} from "./describe.ts"
import { BackPill, Button, Choices, Dot, GoogleButton, Icon, Lab, LinkButton, SignInButton, Tile } from "./kit.tsx"
import { answerText } from "./Messages.tsx"
import { color, gutter } from "./theme.ts"

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function Shell(props: {
  readonly project: Pick<Project, "title" | "icon"> | undefined
  readonly onBack: () => void
  readonly eyebrow: ReactNode
  readonly title: string
  readonly titleSize?: number
  readonly body?: ReactNode
  readonly bottom: ReactNode
}) {
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, paddingTop: insets.top + 4 }}>
      <View style={{ height: 44, justifyContent: "center", paddingHorizontal: gutter }}>
        <BackPill title={`${props.project?.title ?? "Project"} · Chat`} onPress={props.onBack} />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: gutter, paddingTop: 18, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Tile icon={props.project?.icon} size="sm" />
          <Text style={{ fontSize: 14, fontWeight: "600", color: color.t1 }}>{props.project?.title}</Text>
          {props.eyebrow}
        </View>
        <Text
          style={{
            fontSize: props.titleSize ?? 32,
            lineHeight: (props.titleSize ?? 32) * 1.08,
            fontWeight: "700",
            letterSpacing: -0.04 * (props.titleSize ?? 32),
            color: color.t1,
            marginTop: 22,
            marginBottom: 14
          }}
        >
          {props.title}
        </Text>
        {props.body}
      </ScrollView>
      <View style={{ paddingHorizontal: gutter, paddingBottom: Math.max(insets.bottom, 12) + 6 }}>{props.bottom}</View>
    </View>
  )
}

const Eyebrow = (props: { readonly text: string; readonly need?: boolean }) => (
  <Text style={{ fontSize: 14, fontWeight: props.need ? "600" : "500", color: props.need ? color.need : color.t3 }}>
    {props.text}
  </Text>
)

const Lead = (props: { readonly children: ReactNode; readonly style?: object }) => (
  <Text style={[{ fontSize: 17, lineHeight: 24, letterSpacing: -0.085, color: color.t2 }, props.style]}>
    {props.children}
  </Text>
)

// ---------------------------------------------------------------------------
// Question
// ---------------------------------------------------------------------------

export function ExpandedQuestion(props: {
  readonly message: QuestionMessage
  readonly project: Pick<Project, "title" | "icon"> | undefined
  readonly onBack: () => void
}) {
  const m = props.message
  const answer = useAction(answerNowFn)
  const toast = useToast()
  const [changing, setChanging] = useState(false)
  const [picked, setPicked] = useState<string | undefined>(undefined)
  useEffect(() => setChanging(false), [m.state._tag])
  // An answer typed into the notification that didn't send waits in "Something else…".
  const target = { _tag: "Answer", projectId: m.projectId, messageId: m.id } as const
  const draft = Option.getOrUndefined(Option.flatten(AsyncResult.value(useAtomValue(draftAtom(draftKey(target))))))
  const clearDraft = useAtomSet(clearDraftFn)
  // The API ignores an answer the question already has, so retrying after a failure can't answer twice.
  const send = (
    input: { readonly _tag: "Choice"; readonly option: string } | { readonly _tag: "Freeform"; readonly text: string },
    sent?: () => void
  ) => {
    if (input._tag === "Choice") setPicked(input.option)
    answer.run(
      { projectId: m.projectId, messageId: m.id, answer: input },
      {
        onSuccess: () => {
          setChanging(false)
          if (draft) clearDraft(target)
          sent?.()
        },
        onFailure: (message) => {
          setPicked(undefined)
          toast(message)
        }
      }
    )
  }

  if (m.state._tag === "Withdrawn") {
    return (
      <Shell
        project={props.project}
        onBack={props.onBack}
        eyebrow={<Eyebrow text="Question · no longer needed" />}
        title={m.question}
        body={<Lead>Dream worked this out on its own, so it doesn’t need an answer anymore.</Lead>}
        bottom={<Button title="Back to chat" onPress={props.onBack} />}
      />
    )
  }

  if (m.state._tag === "Answered" && !changing) {
    const said = m.state.answer._tag === "Choice" ? "You chose" : "You said"
    return (
      <Shell
        project={props.project}
        onBack={props.onBack}
        eyebrow={<Eyebrow text="Question · answered" />}
        title={m.question}
        body={
          <>
            <View style={{ marginTop: 8 }}>
              <Lab>{said}</Lab>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  marginTop: 10,
                  minHeight: 54,
                  paddingVertical: 12,
                  paddingLeft: 16,
                  paddingRight: 22,
                  borderRadius: 27,
                  backgroundColor: color.t1,
                  alignSelf: "flex-start",
                  maxWidth: "100%"
                }}
              >
                <Icon name="check" size={17} color={color.black} weight="bold" />
                <Text
                  style={{ fontSize: 18, fontWeight: "600", letterSpacing: -0.36, color: color.black, flexShrink: 1 }}
                >
                  {answerText(m)}
                </Text>
              </View>
            </View>
            <Lead style={{ marginTop: 22 }}>
              {m.meanwhile ? `Sent. ${m.meanwhile}` : `Sent. ${props.project?.title ?? "Dream"} takes it from here.`}
            </Lead>
          </>
        }
        bottom={
          <>
            <Button title="Back to chat" onPress={props.onBack} />
            <LinkButton title="Change answer" onPress={() => setChanging(true)} />
          </>
        }
      />
    )
  }

  return (
    <Shell
      project={props.project}
      onBack={props.onBack}
      eyebrow={<Eyebrow text={changing ? "Question · changing your answer" : "Question"} need />}
      title={m.question}
      body={
        <>
          {m.why ? <Lead>{m.why}</Lead> : null}
          {m.meanwhile ? (
            <View
              style={{
                marginTop: 22,
                padding: 13,
                paddingHorizontal: 14,
                borderRadius: 16,
                backgroundColor: color.s1,
                borderWidth: 1,
                borderColor: color.line,
                flexDirection: "row",
                gap: 11
              }}
            >
              <Dot kind="soft" style={{ marginTop: 6 }} />
              <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: color.t2 }}>
                <Text style={{ color: color.t1, fontWeight: "600" }}>Meanwhile</Text> · {m.meanwhile}
              </Text>
            </View>
          ) : null}
        </>
      }
      bottom={
        <>
          <Choices
            options={m.options}
            selected={picked ?? (changing ? answerText(m) : undefined)}
            size="lg"
            onPick={(option) => send({ _tag: "Choice", option })}
          />
          <View style={{ height: 10 }} />
          <ElseComposer
            large
            busy={answer.busy}
            draft={draft?.text}
            onSend={(text, sent) => send({ _tag: "Freeform", text }, sent)}
          />
        </>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** Dream's vault → temporary access → the agent's computer, with a dot that travels. */
function Vault() {
  const x = useSharedValue(0)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    x.value = withRepeat(withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.ease) }), -1)
    return () => cancelAnimation(x)
  }, [x])
  const dot = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value * Math.max(0, width - 6) }],
    opacity: x.value < 0.15 ? x.value / 0.15 : x.value > 0.85 ? (1 - x.value) / 0.15 : 1
  }))
  const node = (icon: "lock" | "cpu", label: string) => (
    <View style={{ width: 112, alignItems: "center", gap: 8 }}>
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: color.s2,
          borderWidth: 1,
          borderColor: color.line2,
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        <Icon name={icon} size={22} />
      </View>
      <Text style={{ fontSize: 12, color: color.t2 }}>{label}</Text>
    </View>
  )
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", marginTop: 34, paddingHorizontal: 4, gap: 8 }}>
      {node("lock", "Dream’s vault")}
      <View style={{ flex: 1, marginTop: 25 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <View style={{ height: 2, borderTopWidth: 2, borderStyle: "dashed", borderColor: "rgba(255,255,255,0.28)" }} />
        <Animated.View
          style={[
            { position: "absolute", top: -2, width: 6, height: 6, borderRadius: 3, backgroundColor: color.t1 },
            dot
          ]}
        />
        <Text style={{ marginTop: 12, textAlign: "center", fontSize: 12, color: color.t3 }}>temporary access</Text>
      </View>
      {node("cpu", "Agent’s computer")}
    </View>
  )
}

function Fine(props: { readonly scope: string | undefined; readonly keyFile?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 10, marginTop: 16, marginHorizontal: 4 }}>
      <Icon name="lock" size={15} style={{ marginTop: 2 }} />
      <Text style={{ flex: 1, fontSize: 13.5, lineHeight: 19.5, color: color.t2 }}>
        {props.keyFile
          ? "Only this project gets it, and it never appears in Chat. Removing it deletes the file."
          : `${props.scope ? `${props.scope} ` : ""}The key stays in Dream’s vault; the agent’s computer only gets temporary access.`}
      </Text>
    </View>
  )
}

/** What a key file means, said before they enter it: the card's warning, in full. */
function KeyFileWarning() {
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 12,
        alignItems: "flex-start",
        marginTop: 20,
        padding: 14,
        borderRadius: 18,
        backgroundColor: color.needBg,
        borderWidth: 1,
        borderColor: color.needLine
      }}
    >
      <Icon name="warn" size={18} color={color.need} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontWeight: "700", color: color.t1 }}>Last resort</Text>
        <Text style={{ fontSize: 13.5, lineHeight: 19.5, color: color.t1, marginTop: 3 }}>
          This key will live in a file on this project’s computer. Any code that runs there can read it, including code
          the agent writes or installs. Other keys stay in Dream’s vault.
        </Text>
      </View>
    </View>
  )
}

function Shared(props: { readonly oauth: boolean }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 9, marginTop: 20 }}>
      <Icon name="layers" size={17} color={color.t2} />
      <Text style={{ fontSize: 14, fontWeight: "600", color: color.t1 }}>
        {props.oauth ? "Connect once — every project can use it." : "Add it once — every project can use it."}
      </Text>
    </View>
  )
}

/** `.secure`: a paste-first secret field. */
export function SecretField(props: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder: string
  readonly multiline?: boolean
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        minHeight: 58,
        paddingLeft: 16,
        paddingRight: 8,
        borderRadius: 18,
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: color.line2,
        marginBottom: 12
      }}
    >
      <Icon name="key" size={19} color={color.t2} />
      <TextInput
        value={props.value}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColor={color.t3}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        keyboardAppearance="dark"
        style={{ flex: 1, color: color.t1, fontSize: 17, height: 56 }}
      />
      {props.value ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={() => void Clipboard.getStringAsync().then((text) => text.trim() && props.onChange(text.trim()))}
          style={({ pressed }) => ({
            height: 42,
            paddingHorizontal: 16,
            borderRadius: 21,
            backgroundColor: color.s3,
            justifyContent: "center",
            opacity: pressed ? 0.8 : 1
          })}
        >
          <Text style={{ fontSize: 15, fontWeight: "600", color: color.t1 }}>Paste</Text>
        </Pressable>
      )}
    </View>
  )
}

function PlainField(props: { readonly label: string; readonly value: string; readonly onChange: (v: string) => void }) {
  return (
    <TextInput
      value={props.value}
      onChangeText={props.onChange}
      placeholder={props.label}
      placeholderTextColor={color.t3}
      autoCapitalize="characters"
      autoCorrect={false}
      keyboardAppearance="dark"
      style={{
        height: 52,
        paddingHorizontal: 16,
        borderRadius: 16,
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: color.line2,
        color: color.t1,
        fontSize: 16,
        marginBottom: 10
      }}
    />
  )
}

function KeyForm(props: { readonly message: AccessMessage; readonly onBack: () => void }) {
  const m = props.message
  const [key, setKey] = useState("")
  const submit = useAction(submitKeyAccessFn)
  const decline = useAction(declineAccessFn)
  return (
    <>
      <SecretField value={key} onChange={setKey} placeholder="Paste key" />
      <Button
        title={isKeyFile(m.request) ? "Save to this project" : "Save to vault"}
        disabled={!key}
        busy={submit.busy}
        onPress={() => submit.run({ projectId: m.projectId, messageId: m.id, key })}
      />
      <NotNow
        message={m}
        onBack={props.onBack}
        decline={() => decline.run({ projectId: m.projectId, messageId: m.id })}
      />
    </>
  )
}

function AppleForm(props: { readonly message: AccessMessage; readonly onBack: () => void }) {
  const m = props.message
  const [issuerId, setIssuer] = useState("")
  const [keyId, setKeyId] = useState("")
  const [privateKey, setPrivateKey] = useState("")
  const [fileName, setFileName] = useState<string | undefined>(undefined)
  const submit = useAction(submitAppleAccessFn)
  const decline = useAction(declineAccessFn)
  const toast = useToast()
  const pick = () =>
    void DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }).then(async (result) => {
      const asset = result.canceled ? undefined : result.assets[0]
      if (!asset) return
      const text = await new File(asset.uri).text()
      if (!text.includes("PRIVATE KEY")) return toast("That file isn’t an App Store Connect key (.p8).")
      setPrivateKey(text.trim())
      setFileName(asset.name)
      const match = /AuthKey_([A-Z0-9]+)\.p8/i.exec(asset.name)
      if (match?.[1] && !keyId) setKeyId(match[1].toUpperCase())
    })
  return (
    <>
      <PlainField label="Issuer ID" value={issuerId} onChange={setIssuer} />
      <PlainField label="Key ID" value={keyId} onChange={setKeyId} />
      <Pressable
        accessibilityRole="button"
        onPress={pick}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          height: 52,
          paddingHorizontal: 16,
          borderRadius: 16,
          backgroundColor: pressed ? color.s2 : color.s1,
          borderWidth: 1,
          borderStyle: privateKey ? "solid" : "dashed",
          borderColor: color.line2,
          marginBottom: 12
        })}
      >
        <Icon name={privateKey ? "check" : "doc"} size={18} color={privateKey ? color.t1 : color.t2} />
        <Text style={{ flex: 1, fontSize: 16, color: privateKey ? color.t1 : color.t3 }} numberOfLines={1}>
          {fileName ?? "Choose the .p8 key file"}
        </Text>
      </Pressable>
      <Button
        title="Save to vault"
        disabled={!issuerId.trim() || !keyId.trim() || !privateKey}
        busy={submit.busy}
        onPress={() =>
          submit.run({
            projectId: m.projectId,
            messageId: m.id,
            issuerId: issuerId.trim(),
            keyId: keyId.trim(),
            privateKey
          })
        }
      />
      <NotNow
        message={m}
        onBack={props.onBack}
        decline={() => decline.run({ projectId: m.projectId, messageId: m.id })}
      />
    </>
  )
}

function NotNow(props: { readonly message: AccessMessage; readonly onBack: () => void; readonly decline: () => void }) {
  return props.message.when ||
    props.message.state._tag === "Declined" ||
    props.message.state._tag === "Disconnected" ? (
    <LinkButton title="Not yet" onPress={props.onBack} />
  ) : (
    <LinkButton title="Don’t connect" onPress={props.decline} />
  )
}

export function ExpandedAccess(props: {
  readonly message: AccessMessage
  readonly project: Pick<Project, "title" | "icon"> | undefined
  readonly onBack: () => void
}) {
  const m = props.message
  const oauth = isOAuth(m.request)
  const keyFile = isKeyFile(m.request)
  const label = accessLabel(m.request)
  const scope = accessScope(m.request)
  const signIn = useSignInAccess(m)
  const disconnect = useAction(disconnectIntegrationFn)
  const titleSize = oauth ? 32 : 30

  if (m.state._tag === "Connected") {
    const integrationId = m.state.integrationId
    return (
      <Shell
        project={props.project}
        onBack={props.onBack}
        eyebrow={<Eyebrow text="Access · connected" />}
        title={m.why}
        titleSize={titleSize}
        body={
          <>
            <View
              style={{
                flexDirection: "row",
                gap: 12,
                alignItems: "flex-start",
                marginTop: 8,
                padding: 14,
                borderRadius: 18,
                backgroundColor: color.s1,
                borderWidth: 1,
                borderColor: color.line
              }}
            >
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  backgroundColor: color.t1,
                  alignItems: "center",
                  justifyContent: "center"
                }}
              >
                <Icon name="check" size={12} color={color.black} weight="bold" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 16, fontWeight: "700", color: color.t1 }}>
                  {m.request._tag === "Apple"
                    ? "Apple Developer key saved"
                    : isKeyFile(m.request)
                      ? `${label} key saved`
                      : `${label} connected`}
                </Text>
                <Text style={{ fontSize: 13.5, color: color.t2, marginTop: 2 }}>
                  {scope ? `${scope} ` : ""}
                  {accessReach(m.request)}
                </Text>
              </View>
            </View>
            <Lead style={{ marginTop: 18 }}>
              {m.when
                ? `I’ll use it ${m.when}.`
                : keyFile
                  ? `It’s in a file on this project’s computer, where any code running there can read it.`
                  : `Every project can use ${label} now, without asking again.`}
            </Lead>
            {keyFile ? null : <Vault />}
          </>
        }
        bottom={
          <>
            <Button title="Back to chat" onPress={props.onBack} />
            <LinkButton
              title={disconnect.busy ? (keyFile ? "Removing…" : "Disconnecting…") : keyFile ? "Remove" : "Disconnect"}
              onPress={() => disconnect.run(integrationId)}
            />
            <Fine scope={scope} keyFile={keyFile} />
          </>
        }
      />
    )
  }

  const later = m.when !== undefined && m.state._tag === "Open"
  const gone = disconnectedNote(m)
  return (
    <Shell
      project={props.project}
      onBack={props.onBack}
      eyebrow={
        <>
          <Eyebrow
            text={
              gone
                ? gone.eyebrow
                : m.state._tag === "Declined"
                  ? "Access · not connected"
                  : later
                    ? "Access · later"
                    : "Access"
            }
            need={!later && m.state._tag === "Open"}
          />
          {m.when ? (
            <Text
              numberOfLines={1}
              style={{
                marginLeft: "auto",
                flexShrink: 1,
                fontSize: 12.5,
                color: color.t2,
                paddingVertical: 4,
                paddingHorizontal: 10,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: color.line2,
                overflow: "hidden"
              }}
            >
              {whenTag(m.when)}
            </Text>
          ) : null}
        </>
      }
      title={m.why}
      titleSize={titleSize}
      body={
        <>
          {gone ? <Lead style={{ marginBottom: 12 }}>{gone.lead}</Lead> : null}
          <Lead>{accessExplainer(m)}</Lead>
          {keyFile ? <KeyFileWarning /> : <Shared oauth={oauth} />}
          {oauth ? <Vault /> : null}
          {m.request._tag === "Apple" ? (
            <Text
              accessibilityRole="link"
              onPress={() =>
                void Linking.openURL(
                  "https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api"
                )
              }
              style={{ marginTop: 18, fontSize: 15, color: color.t2, textDecorationLine: "underline" }}
            >
              Where to find these in App Store Connect
            </Text>
          ) : null}
        </>
      }
      bottom={
        <>
          {m.request._tag === "Google" ? (
            <GoogleButton busy={signIn.busy} onPress={signIn.start} />
          ) : m.request._tag === "OAuth" ? (
            <SignInButton service={signIn.service} busy={signIn.busy} onPress={signIn.start} />
          ) : m.request._tag === "Key" || m.request._tag === "File" ? (
            <KeyForm message={m} onBack={props.onBack} />
          ) : (
            <AppleForm message={m} onBack={props.onBack} />
          )}
          <Fine scope={scope} keyFile={keyFile} />
        </>
      }
    />
  )
}
