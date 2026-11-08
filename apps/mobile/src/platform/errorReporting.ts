/**
 * Crash and error reporting: React Native's global error handler, unhandled promise rejections, and the screens'
 * error boundaries (`ui/ErrorBoundary.tsx`) all end here, and each report is POSTed to the Worker
 * (`Routes.clientErrors`), which keeps it in D1 for operators (GET /admin/client-errors). A fatal error kills the
 * app before a request can finish, so it's written to disk first and sent on the next launch if this one doesn't
 * make it. Live builds only: fixtures builds (the Simulator, screenshots) log instead.
 *
 * This is the edge where the runtime calls us with errors, so it uses plain callbacks and Promises, and never throws:
 * a reporter that fails must not take the app down with it.
 */
import { type ClientBuild, type ClientErrorKind, type ClientErrorReport, Routes } from "@dream/domain"
import { DateTime } from "effect"
import * as Application from "expo-application"
import { File, Paths } from "expo-file-system"
import * as SecureStore from "expo-secure-store"
import * as Updates from "expo-updates"
import { Platform } from "react-native"
import { decodeBatch, encodeBatch, errorReport, makeReportGate } from "../data/errorReports.ts"
import { sessionTokenKey } from "../data/Session.ts"

interface ErrorUtilsShape {
  readonly getGlobalHandler: () => (error: unknown, isFatal?: boolean) => void
  readonly setGlobalHandler: (handler: (error: unknown, isFatal?: boolean) => void) => void
}

declare const ErrorUtils: ErrorUtilsShape | undefined
declare const HermesInternal:
  | {
      readonly enablePromiseRejectionTracker?: (options: {
        readonly allRejections: boolean
        readonly onUnhandled: (id: number, rejection: unknown) => void
        readonly onHandled: (id: number) => void
      }) => void
    }
  | undefined

let screen: string | undefined
/** The route on screen, kept by `ScreenTracker` in the root layout. */
export const setReportedScreen = (pathname: string) => {
  screen = pathname
}

const quietly = <A>(f: () => A): A | undefined => {
  try {
    return f()
  } catch {
    return undefined
  }
}

const build = (): ClientBuild => {
  const os = `${Platform.OS} ${String(Platform.Version)}`
  const updateId = Updates.isEnabled && !Updates.isEmbeddedLaunch ? Updates.updateId : null
  return {
    version: Application.nativeApplicationVersion ?? "unknown",
    build: Application.nativeBuildVersion ?? "unknown",
    ...(updateId ? { updateId } : {}),
    ...(Updates.runtimeVersion ? { runtimeVersion: Updates.runtimeVersion } : {}),
    ...(Updates.channel ? { channel: Updates.channel } : {}),
    os
  }
}

const pendingFile = () => new File(Paths.document, "error-reports.json")
const readPending = () =>
  quietly(() => {
    const file = pendingFile()
    return file.exists ? decodeBatch(file.textSync()) : []
  }) ?? []
const writePending = (reports: ReadonlyArray<ClientErrorReport>) =>
  quietly(() => {
    const file = pendingFile()
    if (reports.length === 0) {
      if (file.exists) file.delete()
    } else file.writeSync(encodeBatch(reports))
  })

const gate = makeReportGate()
let target: { readonly url: string } | undefined

const send = (reports: ReadonlyArray<ClientErrorReport>): Promise<boolean> => {
  if (target === undefined || reports.length === 0) return Promise.resolve(false)
  const token = quietly(() =>
    SecureStore.getItem(sessionTokenKey, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK })
  )
  return fetch(target.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: encodeBatch(reports)
  }).then(
    // A refused report (malformed, rate-limited) won't do better next launch, so only a failed request keeps it.
    () => true,
    () => false
  )
}

/** Reports an error that didn't end the app (a failed render, a stray rejection, or a caught one worth knowing). */
export const reportError = (
  kind: ClientErrorKind,
  thrown: unknown,
  extra: { readonly componentStack?: string | undefined } = {}
): Promise<void> => {
  const report = quietly(() =>
    errorReport({
      kind,
      thrown,
      componentStack: extra.componentStack,
      screen,
      build: build(),
      now: DateTime.nowUnsafe()
    })
  )
  if (report === undefined || !gate(report, Date.now())) return Promise.resolve()
  if (target === undefined) {
    console.warn(`[error report] ${report.kind}: ${report.message}`, report.componentStack ?? report.stack ?? "")
    return Promise.resolve()
  }
  const kept = report.kind === "fatal" ? [...readPending(), report] : undefined
  if (kept) writePending(kept)
  return send(kept ?? [report]).then((sent) => {
    if (sent && kept) writePending([])
  })
}

/**
 * Installs the handlers, once, at startup. `apiUrl` is where reports go; without it (fixtures builds) they're only
 * logged. What a crash left on disk last time goes now.
 */
export const installErrorReporting = (options: { readonly apiUrl: string | undefined }) => {
  if (options.apiUrl !== undefined) target = { url: `${options.apiUrl}${Routes.clientErrors}` }
  const pending = readPending()
  if (pending.length > 0)
    void send(pending).then((sent) => {
      if (sent) writePending([])
    })

  if (typeof ErrorUtils !== "undefined") {
    const previous = ErrorUtils.getGlobalHandler()
    ErrorUtils.setGlobalHandler((error, isFatal) => {
      if (!isFatal) {
        void reportError("error", error)
        return previous(error, isFatal)
      }
      // Give the report a moment to leave before React Native ends the app (it's on disk either way).
      let done = false
      const finish = () => {
        if (done) return
        done = true
        previous(error, isFatal)
      }
      void reportError("fatal", error).then(finish)
      setTimeout(finish, 1500)
    })
  }

  // React Native tracks rejections only in development builds; release builds get ours.
  if (!__DEV__ && typeof HermesInternal !== "undefined")
    HermesInternal.enablePromiseRejectionTracker?.({
      allRejections: true,
      onUnhandled: (_id, rejection) => void reportError("rejection", rejection),
      onHandled: () => {}
    })
}
