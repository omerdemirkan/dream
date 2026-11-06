/**
 * Connect Claude or ChatGPT, once per person. Each runs its own sign-in in a
 * short-lived sandbox and Dream relays it: a code to paste back for Claude, a
 * device code to enter for ChatGPT.
 */
import type { ModelConnection, ModelConnectFlow, ModelProvider } from "@dream/domain"
import * as Clipboard from "expo-clipboard"
import { useRouter } from "expo-router"
import * as WebBrowser from "expo-web-browser"
import { useState } from "react"
import { Pressable, ScrollView, Text, TextInput, View } from "react-native"
import { KeyboardAvoidingView } from "react-native-keyboard-controller"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { awaitModelConnectionFn, completeModelConnectionFn, startModelConnectionFn } from "../state/atoms.ts"
import { useAction, useToast } from "../ui/actions.ts"
import { Button, Dot, Icon, IconButton, LinkButton } from "../ui/kit.tsx"
import { color, gutter } from "../ui/theme.ts"

type Step =
  | { readonly _tag: "Choose" }
  | {
      readonly _tag: "Flow"
      readonly provider: ModelProvider
      readonly connection: ModelConnection
      readonly flow: ModelConnectFlow
    }
  | { readonly _tag: "Done"; readonly provider: ModelProvider }

const plans: ReadonlyArray<{
  readonly provider: ModelProvider
  readonly name: string
  readonly plan: string
  readonly runs: string
}> = [
  { provider: "chatgpt", name: "ChatGPT", plan: "Plus or Pro", runs: "Projects run on Codex." },
  { provider: "claude", name: "Claude", plan: "Pro or Max", runs: "Projects run on Claude Code." }
]

export default function Connect() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [step, setStep] = useState<Step>({ _tag: "Choose" })
  const start = useAction(startModelConnectionFn)
  const toast = useToast()
  const [starting, setStarting] = useState<ModelProvider | undefined>(undefined)

  const choose = (provider: ModelProvider) => {
    setStarting(provider)
    start.run(provider, {
      onSuccess: ({ connection, flow }) => {
        setStarting(undefined)
        setStep({ _tag: "Flow", provider, connection, flow })
      },
      onFailure: (message) => {
        setStarting(undefined)
        toast(message)
      }
    })
  }

  const finish = () => (router.canGoBack() ? router.back() : router.replace("/"))

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: color.bg }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 4,
          paddingHorizontal: gutter,
          paddingBottom: insets.bottom + 30,
          flexGrow: 1
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ height: 44, justifyContent: "center" }}>
          {router.canGoBack() || step._tag === "Flow" ? (
            <IconButton
              icon="back"
              label="Back"
              onPress={() => (step._tag === "Flow" ? setStep({ _tag: "Choose" }) : router.back())}
            />
          ) : null}
        </View>
        {step._tag === "Choose" ? (
          <>
            <Title>Which plan should Dream use?</Title>
            <Lead>
              Dream works on your own subscription. Connect it once; every project uses it, and you can see how much is
              left.
            </Lead>
            <View style={{ gap: 12, marginTop: 30 }}>
              {plans.map((p) => (
                <Pressable
                  key={p.provider}
                  accessibilityRole="button"
                  disabled={starting !== undefined}
                  onPress={() => choose(p.provider)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 14,
                    padding: 18,
                    borderRadius: 22,
                    backgroundColor: pressed ? color.s2 : color.s1,
                    borderWidth: 1,
                    borderColor: color.line2
                  })}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 19, fontWeight: "700", letterSpacing: -0.4, color: color.t1 }}>
                      {p.name} <Text style={{ color: color.t3, fontWeight: "500" }}>{p.plan}</Text>
                    </Text>
                    <Text style={{ fontSize: 14, color: color.t2, marginTop: 3 }}>
                      {starting === p.provider ? "Starting a secure sign-in…" : p.runs}
                    </Text>
                  </View>
                  {starting === p.provider ? <Dot kind="live" /> : <Icon name="chev" size={16} color={color.t3} />}
                </Pressable>
              ))}
            </View>
          </>
        ) : step._tag === "Flow" ? (
          step.flow._tag === "DeviceCode" ? (
            <DeviceCode
              connection={step.connection}
              flow={step.flow}
              onDone={() => setStep({ _tag: "Done", provider: step.provider })}
              onRestart={() => setStep({ _tag: "Choose" })}
            />
          ) : (
            <PasteCode
              connection={step.connection}
              authorizeUrl={step.flow.authorizeUrl}
              onDone={() => setStep({ _tag: "Done", provider: step.provider })}
            />
          )
        ) : (
          <View style={{ flex: 1, justifyContent: "center", paddingBottom: 60 }}>
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: color.t1,
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 26
              }}
            >
              <Icon name="check" size={28} color={color.black} weight="bold" />
            </View>
            <Title>{`${step.provider === "chatgpt" ? "ChatGPT" : "Claude"} is connected.`}</Title>
            <Lead>Every project runs on it. Describe an idea whenever you’re ready.</Lead>
            <Button title="Continue" onPress={finish} style={{ marginTop: 30 }} />
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function Title(props: { readonly children: string }) {
  return (
    <Text
      style={{ marginTop: 18, fontSize: 32, lineHeight: 35, fontWeight: "700", letterSpacing: -1.28, color: color.t1 }}
    >
      {props.children}
    </Text>
  )
}

function Lead(props: { readonly children: string }) {
  return <Text style={{ marginTop: 12, fontSize: 17, lineHeight: 24.5, color: color.t2 }}>{props.children}</Text>
}

function DeviceCode(props: {
  readonly connection: ModelConnection
  readonly flow: Extract<ModelConnectFlow, { _tag: "DeviceCode" }>
  readonly onDone: () => void
  readonly onRestart: () => void
}) {
  const wait = useAction(awaitModelConnectionFn)
  const toast = useToast()
  const [waiting, setWaiting] = useState(false)
  const begin = () => {
    void WebBrowser.openBrowserAsync(props.flow.verificationUrl)
    if (waiting) return
    setWaiting(true)
    wait.run(props.connection.id, {
      onSuccess: (connection) => {
        setWaiting(false)
        if (connection.status === "connected") props.onDone()
        else toast("That sign-in didn’t finish. Start again to get a new code.")
      },
      onFailure: (message) => {
        setWaiting(false)
        toast(message)
      }
    })
  }
  return (
    <>
      <Title>Enter this code at OpenAI</Title>
      <Lead>
        Sign in to ChatGPT on OpenAI’s page and enter the code. Dream keeps the sign-in and refreshes it for you.
      </Lead>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Copy code"
        onPress={() =>
          void Clipboard.setStringAsync(props.flow.userCode).then(() => toast("Code copied", { done: true }))
        }
        style={{
          marginTop: 30,
          paddingVertical: 22,
          borderRadius: 22,
          backgroundColor: color.s1,
          borderWidth: 1,
          borderColor: color.line2,
          alignItems: "center",
          gap: 8
        }}
      >
        <Text
          style={{ fontSize: 34, fontWeight: "700", letterSpacing: 4, color: color.t1, fontVariant: ["tabular-nums"] }}
        >
          {props.flow.userCode}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="copy" size={13} color={color.t3} />
          <Text style={{ fontSize: 13, color: color.t3 }}>Tap to copy</Text>
        </View>
      </Pressable>
      <Button title="Open OpenAI" trailing="arrowOut" onPress={begin} style={{ marginTop: 22 }} />
      {waiting ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 20, justifyContent: "center" }}>
          <Dot kind="soft" />
          <Text style={{ fontSize: 14, color: color.t2 }}>Waiting for you to finish on OpenAI’s page…</Text>
        </View>
      ) : (
        <LinkButton title="Get a new code" onPress={props.onRestart} />
      )}
    </>
  )
}

function PasteCode(props: {
  readonly connection: ModelConnection
  readonly authorizeUrl: string
  readonly onDone: () => void
}) {
  const complete = useAction(completeModelConnectionFn)
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | undefined>(undefined)
  return (
    <>
      <Title>Authorize Claude, then paste the code</Title>
      <Lead>Anthropic’s page shows a code after you tap Authorize. Copy it and paste it here.</Lead>
      <Button
        title="Open Anthropic"
        trailing="arrowOut"
        variant="ghost"
        onPress={() => void WebBrowser.openBrowserAsync(props.authorizeUrl)}
        style={{ marginTop: 30 }}
      />
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          height: 58,
          marginTop: 14,
          paddingLeft: 16,
          paddingRight: 8,
          borderRadius: 18,
          backgroundColor: color.s1,
          borderWidth: 1,
          borderColor: color.line2
        }}
      >
        <Icon name="key" size={19} color={color.t2} />
        <TextInput
          value={code}
          onChangeText={setCode}
          placeholder="Paste the code"
          placeholderTextColor={color.t3}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          keyboardAppearance="dark"
          style={{ flex: 1, color: color.t1, fontSize: 17, height: 56 }}
        />
        {code ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={() => void Clipboard.getStringAsync().then((text) => setCode(text.trim()))}
            style={{
              height: 42,
              paddingHorizontal: 16,
              borderRadius: 21,
              backgroundColor: color.s3,
              justifyContent: "center"
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: "600", color: color.t1 }}>Paste</Text>
          </Pressable>
        )}
      </View>
      {error ? <Text style={{ marginTop: 12, fontSize: 14, color: color.need }}>{error}</Text> : null}
      <Button
        title="Connect"
        disabled={!code.trim()}
        busy={complete.busy}
        style={{ marginTop: 14 }}
        onPress={() => {
          setError(undefined)
          complete.run(
            { connectionId: props.connection.id, code: code.trim() },
            {
              onSuccess: (connection) =>
                connection.status === "connected"
                  ? props.onDone()
                  : setError("That code didn’t work. Try authorizing again."),
              onFailure: setError
            }
          )
        }}
      />
    </>
  )
}
