/**
 * Sign in: Google, or (on development deployments) an email plus the
 * deployment's dev secret. In fixtures mode the dev path signs in as the
 * sample person.
 */
import { useState } from "react"
import { KeyboardAvoidingView, Text, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { googleSignInAvailable } from "../platform/google.ts"
import { devSignInFn, signInWithGoogleFn } from "../state/atoms.ts"
import { appConfig } from "../state/runtime.ts"
import { useAction } from "../ui/actions.ts"
import { Button, GoogleButton, LinkButton } from "../ui/kit.tsx"
import { color, gutter } from "../ui/theme.ts"

const fixtures = appConfig.backend === "fixtures"

export default function SignIn() {
  const insets = useSafeAreaInsets()
  const google = useAction(signInWithGoogleFn)
  const dev = useAction(devSignInFn)
  const [showDev, setShowDev] = useState(fixtures || !googleSignInAvailable)
  const [email, setEmail] = useState(fixtures ? "ada@example.com" : "")
  const [secret, setSecret] = useState(fixtures ? "fixtures" : "")
  const [error, setError] = useState<string | undefined>(undefined)

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: color.bg }}>
      <View style={{ flex: 1, paddingTop: insets.top + 80, paddingHorizontal: gutter + 4 }}>
        <View
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            experimental_backgroundImage: "radial-gradient(circle at 36% 30%, #fff2dc, #FFB35C 50%, #e0457b)",
            boxShadow: "0 0 40px rgba(255,150,100,0.45)"
          }}
        />
        <Text style={{ marginTop: 34, fontSize: 46, fontWeight: "700", letterSpacing: -1.84, color: color.t1 }}>
          Dream
        </Text>
        <Text style={{ marginTop: 12, fontSize: 17, lineHeight: 24.5, color: color.t2, maxWidth: 330 }}>
          Say what you want to exist. An agent builds it in its own computer, for hours or weeks, and only asks when it
          must.
        </Text>
      </View>
      <View style={{ paddingHorizontal: gutter, paddingBottom: Math.max(insets.bottom, 12) + 10, gap: 10 }}>
        {error ? (
          <Text style={{ color: color.need, fontSize: 14, lineHeight: 20, marginBottom: 4 }}>{error}</Text>
        ) : null}
        {showDev ? (
          <>
            <Field value={email} onChange={setEmail} placeholder="Email" keyboard="email-address" />
            {fixtures ? null : <Field value={secret} onChange={setSecret} placeholder="Dev secret" secure />}
            <Button
              title={fixtures ? "Continue with the sample projects" : "Sign in"}
              busy={dev.busy}
              disabled={!email.trim() || !secret.trim()}
              onPress={() => {
                setError(undefined)
                dev.run({ email: email.trim(), secret: secret.trim() }, { onFailure: setError })
              }}
            />
          </>
        ) : null}
        {googleSignInAvailable ? (
          <GoogleButton
            busy={google.busy}
            title="Sign in with Google"
            onPress={() => {
              setError(undefined)
              google.run(undefined, { onFailure: setError })
            }}
          />
        ) : null}
        {!showDev ? <LinkButton title="Use a dev secret instead" onPress={() => setShowDev(true)} /> : null}
      </View>
    </KeyboardAvoidingView>
  )
}

function Field(props: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder: string
  readonly secure?: boolean
  readonly keyboard?: "email-address"
}) {
  return (
    <TextInput
      value={props.value}
      onChangeText={props.onChange}
      placeholder={props.placeholder}
      placeholderTextColor={color.t3}
      secureTextEntry={props.secure === true}
      keyboardType={props.keyboard ?? "default"}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardAppearance="dark"
      style={{
        height: 54,
        paddingHorizontal: 18,
        borderRadius: 18,
        backgroundColor: color.s1,
        borderWidth: 1,
        borderColor: color.line2,
        color: color.t1,
        fontSize: 16
      }}
    />
  )
}
