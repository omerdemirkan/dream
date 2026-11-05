/**
 * Running an action atom from a tap: a busy flag for the button, and a toast
 * when it fails. Opening Google's consent screen for an access request.
 */
import type { AccessMessage, MessageId } from "@dream/domain"
import { useAtomSet } from "@effect/atom-react"
import { Cause, Exit, Option } from "effect"
import type { Atom } from "effect/reactivity"
import * as WebBrowser from "expo-web-browser"
import { useCallback, useRef, useState } from "react"
import { describeError } from "../data/errors.ts"
import { startGoogleAccessFn } from "../state/atoms.ts"
import { appConfig } from "../state/runtime.ts"
import { toastAtom } from "../state/ui.ts"

export function useToast() {
  const set = useAtomSet(toastAtom)
  return useCallback(
    (message: string, undo?: MessageId) => set(Option.some({ message, undo, at: Date.now() })),
    [set]
  )
}

export interface Action<Arg, A> {
  readonly busy: boolean
  readonly run: (
    arg: Arg,
    handlers?: { readonly onSuccess?: (value: A) => void; readonly onFailure?: (message: string) => void }
  ) => void
}

/** Runs `fn` and reports failures as a toast (unless `onFailure` handles them). */
export function useAction<Arg, A, E>(fn: Atom.AtomResultFn<Arg, A, E>): Action<Arg, A> {
  const run = useAtomSet(fn, { mode: "promiseExit" })
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(0)
  return {
    busy,
    run: (arg, handlers) => {
      inFlight.current += 1
      setBusy(true)
      void run(arg).then((exit) => {
        inFlight.current -= 1
        if (inFlight.current === 0) setBusy(false)
        if (Exit.isSuccess(exit)) return handlers?.onSuccess?.(exit.value)
        if (Cause.hasInterruptsOnly(exit.cause)) return
        const message = describeError(Option.getOrUndefined(Cause.findErrorOption(exit.cause)))
        if (handlers?.onFailure) handlers.onFailure(message)
        else toast(message)
      })
    }
  }
}

/** The redirect the API sends the browser to after Google's consent screen. */
export const googleRedirect = "dream://oauth/google"

/**
 * Starts Google OAuth for an access request in an auth session. The access
 * message turns "connected" over the live stream once the API has the tokens.
 */
export function useGoogleAccess(message: AccessMessage) {
  const start = useAction(startGoogleAccessFn)
  const toast = useToast()
  const [opening, setOpening] = useState(false)
  return {
    busy: opening || start.busy,
    start: () => {
      setOpening(true)
      start.run(
        { projectId: message.projectId, messageId: message.id },
        {
          onSuccess: ({ authorizeUrl }) => {
            if (appConfig.backend === "fixtures") {
              // The fake finishes the sign-in by itself, as if they had approved it.
              setTimeout(() => setOpening(false), 1500)
              return
            }
            void WebBrowser.openAuthSessionAsync(authorizeUrl, googleRedirect).then((result) => {
              setOpening(false)
              if (result.type !== "success") return
              const url = new URL(result.url)
              if (url.searchParams.get("status") === "error") {
                toast(`Google didn't connect: ${url.searchParams.get("error") ?? "try again"}.`)
              }
            })
          },
          onFailure: (failure) => {
            setOpening(false)
            toast(failure)
          }
        }
      )
    }
  }
}
