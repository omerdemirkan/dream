/**
 * Dictation into a text field: speech becomes text, nothing is sent until the
 * person taps send. Uses iOS speech recognition through expo-speech-recognition
 * (no API key), on-device when the phone supports it.
 *
 * Without the native module (Expo Go, tests) dictation is unavailable, except
 * in fixtures mode, where it types a canned phrase so the flow can be seen.
 */
import { requireOptionalNativeModule } from "expo"
import { getLocales } from "expo-localization"
import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, Linking } from "react-native"
import { appConfig } from "../state/runtime.ts"

interface SpeechResultEvent {
  readonly isFinal: boolean
  readonly results: ReadonlyArray<{ readonly transcript: string }>
}
interface SpeechErrorEvent {
  readonly error: string
  readonly message: string
}
interface Subscription {
  remove(): void
}
/** The parts of the ExpoSpeechRecognition native module this app uses. */
interface SpeechModule {
  start(options: Record<string, unknown>): void
  stop(): void
  abort(): void
  requestPermissionsAsync(): Promise<{ readonly granted: boolean; readonly canAskAgain: boolean }>
  supportsOnDeviceRecognition(): boolean
  addListener(event: "result", listener: (event: SpeechResultEvent) => void): Subscription
  addListener(event: "error", listener: (event: SpeechErrorEvent) => void): Subscription
  addListener(event: "end", listener: () => void): Subscription
}

const speech = requireOptionalNativeModule<SpeechModule>("ExpoSpeechRecognition")

export const dictationAvailable = speech !== null || appConfig.backend === "fixtures"

export interface Dictation {
  readonly available: boolean
  readonly listening: boolean
  /** What has been heard so far in this take. */
  readonly heard: string
  readonly toggle: () => void
  readonly stop: () => void
}

/**
 * `onText` receives the final text of each take, to append to the field.
 * `sample` is what simulated dictation "hears" in fixtures mode.
 */
export function useDictation(onText: (text: string) => void, sample = "Can it also convert cups to grams?"): Dictation {
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState("")
  const heardRef = useRef("")
  const onTextRef = useRef(onText)
  onTextRef.current = onText
  const subscriptions = useRef<Array<Subscription>>([])
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])

  const cleanUp = useCallback(() => {
    for (const s of subscriptions.current) s.remove()
    subscriptions.current = []
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
  }, [])

  const finish = useCallback(() => {
    cleanUp()
    const text = heardRef.current.trim()
    heardRef.current = ""
    setHeard("")
    setListening(false)
    if (text) onTextRef.current(text)
  }, [cleanUp])

  useEffect(
    () => () => {
      cleanUp()
      speech?.abort()
    },
    [cleanUp]
  )

  const startNative = useCallback(
    async (module: SpeechModule) => {
      const permission = await module.requestPermissionsAsync()
      if (!permission.granted) {
        Alert.alert(
          "Dictation needs the microphone",
          "Allow Microphone and Speech Recognition for Dream in Settings to dictate.",
          [
            { text: "Not now", style: "cancel" },
            { text: "Settings", onPress: () => void Linking.openSettings() }
          ]
        )
        return
      }
      cleanUp()
      subscriptions.current = [
        module.addListener("result", (event) => {
          const text = event.results[0]?.transcript ?? ""
          heardRef.current = text
          setHeard(text)
        }),
        module.addListener("error", (event) => {
          if (event.error !== "aborted" && event.error !== "no-speech") {
            Alert.alert("Dictation stopped", event.message)
          }
        }),
        module.addListener("end", finish)
      ]
      heardRef.current = ""
      setHeard("")
      setListening(true)
      module.start({
        lang: getLocales()[0]?.languageTag ?? "en-US",
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        requiresOnDeviceRecognition: module.supportsOnDeviceRecognition()
      })
    },
    [cleanUp, finish]
  )

  const startSimulated = useCallback(() => {
    cleanUp()
    heardRef.current = ""
    setListening(true)
    const words = sample.split(" ")
    words.forEach((_, i) => {
      timers.current.push(
        setTimeout(
          () => {
            heardRef.current = words.slice(0, i + 1).join(" ")
            setHeard(heardRef.current)
          },
          500 + i * 180
        )
      )
    })
    timers.current.push(setTimeout(finish, 500 + words.length * 180 + 600))
  }, [cleanUp, finish, sample])

  const stop = useCallback(() => {
    if (!listening) return
    if (speech) speech.stop()
    else finish()
  }, [finish, listening])

  const toggle = useCallback(() => {
    if (listening) return stop()
    if (speech) void startNative(speech)
    else if (appConfig.backend === "fixtures") startSimulated()
  }, [listening, startNative, startSimulated, stop])

  return { available: dictationAvailable, listening, heard, toggle, stop }
}
