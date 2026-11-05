/**
 * Dictation into a text field: speech becomes text, nothing is sent until the
 * person taps send. Uses iOS speech recognition through expo-speech-recognition
 * (no API key), on-device when the phone supports it.
 *
 * Without the native module (Expo Go, tests) dictation is unavailable, except
 * in fixtures mode, where it types a canned phrase so the flow can be seen.
 */
import { requireOptionalNativeModule } from "expo"
import * as Device from "expo-device"
import { getLocales } from "expo-localization"
import { useCallback, useEffect, useRef, useState } from "react"
import { Alert, Linking } from "react-native"
import { addResult, emptyTranscript, type Transcript, transcriptText } from "../data/transcript.ts"
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

/** The Simulator has no microphone worth using: fixtures there simulate dictation instead. */
const simulate = appConfig.backend === "fixtures" && !Device.isDevice
const speech = simulate ? null : requireOptionalNativeModule<SpeechModule>("ExpoSpeechRecognition")

export const dictationAvailable = speech !== null || appConfig.backend === "fixtures"

export interface Dictation {
  readonly available: boolean
  readonly listening: boolean
  /** What has been heard so far in this take. */
  readonly heard: string
  /** The same, split into finished segments and the one still being recognized. */
  readonly transcript: Transcript
  readonly toggle: () => void
  readonly stop: () => void
  /** Stops listening and drops the take, for when its text was already used. */
  readonly cancel: () => void
}

/**
 * `onText` receives the final text of each take, to put in the field.
 * `sample` is what simulated dictation "hears" in fixtures mode.
 */
export function useDictation(onText: (text: string) => void, sample = "Can it also convert cups to grams?"): Dictation {
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState<Transcript>(emptyTranscript)
  const heardRef = useRef("")
  const transcript = useRef<Transcript>(emptyTranscript)
  const hear = useCallback((next: Transcript) => {
    transcript.current = next
    heardRef.current = transcriptText(next)
    setHeard(next)
  }, [])
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
    hear(emptyTranscript)
    setListening(false)
    if (text) onTextRef.current(text)
  }, [cleanUp, hear])

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
          // iOS starts each segment over after a pause, so the take is the kept segments plus this one.
          hear(addResult(transcript.current, { text: event.results[0]?.transcript ?? "", isFinal: event.isFinal }))
        }),
        module.addListener("error", (event) => {
          if (event.error !== "aborted" && event.error !== "no-speech") {
            Alert.alert("Dictation stopped", event.message)
          }
        }),
        module.addListener("end", finish)
      ]
      hear(emptyTranscript)
      setListening(true)
      module.start({
        lang: getLocales()[0]?.languageTag ?? "en-US",
        interimResults: true,
        continuous: true,
        addsPunctuation: true,
        requiresOnDeviceRecognition: module.supportsOnDeviceRecognition()
      })
    },
    [cleanUp, finish, hear]
  )

  const startSimulated = useCallback(() => {
    cleanUp()
    hear(emptyTranscript)
    setListening(true)
    // Like iOS: each sentence is heard a word at a time, comes final at its end, and the next starts over.
    let at = 500
    for (const sentence of sample.match(/[^.?!]+[.?!]*/g) ?? []) {
      const words = sentence.trim().split(" ")
      words.forEach((_, i) => {
        const isFinal = i === words.length - 1
        timers.current.push(
          setTimeout(() => hear(addResult(transcript.current, { text: words.slice(0, i + 1).join(" "), isFinal })), at)
        )
        at += 180
      })
      at += 700
    }
    timers.current.push(setTimeout(finish, at))
  }, [cleanUp, finish, hear, sample])

  const stop = useCallback(() => {
    if (!listening) return
    if (speech) speech.stop()
    else finish()
  }, [finish, listening])

  const cancel = useCallback(() => {
    cleanUp()
    speech?.abort()
    hear(emptyTranscript)
    setListening(false)
  }, [cleanUp, hear])

  const toggle = useCallback(() => {
    if (listening) return stop()
    if (speech) void startNative(speech)
    else if (appConfig.backend === "fixtures") startSimulated()
  }, [listening, startNative, startSimulated, stop])

  return {
    available: dictationAvailable,
    listening,
    heard: transcriptText(heard),
    transcript: heard,
    toggle,
    stop,
    cancel
  }
}
