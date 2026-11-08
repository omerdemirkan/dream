/**
 * Error boundaries: a screen (or a layer over the screens) that fails to render is reported (`platform/errorReporting.ts`)
 * and replaced, instead of React unmounting the whole app, which in a release build ends it.
 *
 * - `ScreenBoundary` wraps the navigator: what failed gives way to "Something went wrong", with a way back to Home.
 * - `LayerBoundary` wraps what floats above it (the expanded message, a thread, the viewers, the sheets): it closes
 *   that layer, so the screen underneath carries on, and is ready again for the next time it opens.
 */
import { useAtomSet } from "@effect/atom-react"
import { Option } from "effect"
import type { Atom } from "effect/reactivity"
import { router, usePathname } from "expo-router"
import { Component, type ErrorInfo, type ReactNode, useEffect } from "react"
import { Text, View } from "react-native"
import { reportError, setReportedScreen } from "../platform/errorReporting.ts"
import { Button } from "./kit.tsx"
import { color, gutter } from "./theme.ts"

class Boundary extends Component<
  {
    readonly children: ReactNode
    readonly fallback: (reset: () => void) => ReactNode
    /** Resets once this changes (the layer reopening, another screen). */
    readonly resetKey?: unknown
  },
  { readonly failed: boolean; readonly key: unknown }
> {
  override state = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: { readonly resetKey?: unknown }, state: { failed: boolean; key: unknown }) {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    void reportError("render", error, { componentStack: info.componentStack ?? undefined })
  }

  reset = () => this.setState({ failed: false })

  override render() {
    return this.state.failed ? this.props.fallback(this.reset) : this.props.children
  }
}

export function ScreenBoundary(props: { readonly children: ReactNode }) {
  const pathname = usePathname()
  return (
    <Boundary
      resetKey={pathname}
      fallback={(reset) => (
        <View
          style={{ flex: 1, backgroundColor: color.bg, justifyContent: "center", paddingHorizontal: gutter, gap: 12 }}
        >
          <Text style={{ fontSize: 24, fontWeight: "700", color: color.t1, letterSpacing: -0.4 }}>
            Something went wrong
          </Text>
          <Text style={{ fontSize: 16, lineHeight: 22, color: color.t2, marginBottom: 12 }}>
            This screen hit a problem. Dream has been told about it.
          </Text>
          <Button
            title="Back to Home"
            onPress={() => {
              reset()
              if (router.canDismiss()) router.dismissAll()
              router.replace("/")
            }}
          />
        </View>
      )}
    >
      {props.children}
    </Boundary>
  )
}

/** Closes the layer that failed (sets the atom it shows to none), then shows it again once it's closed. */
export function LayerBoundary(props: {
  readonly children: ReactNode
  readonly closes: Atom.Writable<Option.Option<any>>
}) {
  const close = useAtomSet(props.closes)
  return (
    <Boundary fallback={(reset) => <Closing close={() => close(Option.none())} reset={reset} />}>
      {props.children}
    </Boundary>
  )
}

function Closing(props: { readonly close: () => void; readonly reset: () => void }) {
  const { close, reset } = props
  useEffect(() => {
    close()
    reset()
  }, [close, reset])
  return null
}

/** Keeps the reporter told which route is on screen. */
export function ScreenTracker() {
  const pathname = usePathname()
  useEffect(() => setReportedScreen(pathname), [pathname])
  return null
}
