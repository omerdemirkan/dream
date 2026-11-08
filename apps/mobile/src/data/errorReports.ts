/**
 * Crash and error reports, as the app sends them to the Worker (`ClientErrorReport`, `Routes.clientErrors`): the
 * error's name, message and stack, the screen's route, and the build and update that ran it. Never what the person
 * wrote or was shown. `platform/errorReporting.ts` catches the errors; this shapes them, keeps a launch from sending
 * the same one over and over, and keeps a fatal one on disk for the next launch, since the app dies before a
 * request can finish.
 */
import {
  type ClientBuild,
  ClientErrorBatch,
  type ClientErrorKind,
  ClientErrorLimits,
  type ClientErrorReport
} from "@dream/domain"
import { type DateTime, Option, Schema } from "effect"

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** The route without its query or fragment, which can carry ids and drafts: "/project/prj_x?thread=…" → "/project/prj_x". */
export const screenOf = (pathname: string | undefined): string | undefined => {
  if (!pathname) return undefined
  const path = pathname.split(/[?#]/)[0] ?? ""
  return path === "" ? undefined : cut(path, 200)
}

/** "TypeError: x is not a function" from whatever was thrown (an Error, a string, anything). */
export const describeThrown = (thrown: unknown): { readonly message: string; readonly stack: string | undefined } => {
  if (thrown instanceof Error) {
    const name = thrown.name || "Error"
    return {
      message: thrown.message ? `${name}: ${thrown.message}` : name,
      stack: typeof thrown.stack === "string" && thrown.stack !== "" ? thrown.stack : undefined
    }
  }
  if (typeof thrown === "string") return { message: thrown, stack: undefined }
  try {
    return { message: `Non-error thrown: ${JSON.stringify(thrown) ?? String(thrown)}`, stack: undefined }
  } catch {
    return { message: `Non-error thrown: ${String(thrown)}`, stack: undefined }
  }
}

export const errorReport = (input: {
  readonly kind: ClientErrorKind
  readonly thrown: unknown
  readonly componentStack?: string | undefined
  readonly screen?: string | undefined
  readonly build: ClientBuild
  readonly now: DateTime.Utc
}): ClientErrorReport => {
  const { message, stack } = describeThrown(input.thrown)
  const screen = screenOf(input.screen)
  return {
    kind: input.kind,
    message: cut(message, ClientErrorLimits.message),
    ...(stack === undefined ? {} : { stack: cut(stack, ClientErrorLimits.stack) }),
    ...(input.componentStack ? { componentStack: cut(input.componentStack, ClientErrorLimits.stack) } : {}),
    ...(screen === undefined ? {} : { screen }),
    build: input.build,
    occurredAt: input.now
  }
}

/**
 * Whether to send a report: not the same error again within a minute (an error in a render loop, a handler that
 * fails on every frame), and no more than `perLaunch` in all. Fatal ones always go.
 */
export const makeReportGate = (perLaunch = 20, quietMs = 60_000) => {
  const last = new Map<string, number>()
  let sent = 0
  return (report: ClientErrorReport, nowMs: number): boolean => {
    if (report.kind === "fatal") return true
    const key = `${report.kind}\n${report.message}`
    const at = last.get(key)
    if (sent >= perLaunch || (at !== undefined && nowMs - at < quietMs)) return false
    last.set(key, nowMs)
    sent++
    return true
  }
}

const BatchJson = Schema.fromJsonString(Schema.toCodecJson(ClientErrorBatch))

/** The body of a POST to `Routes.clientErrors`, and what's kept on disk for the next launch. */
export const encodeBatch = (reports: ReadonlyArray<ClientErrorReport>): string =>
  Schema.encodeSync(BatchJson)({ reports: reports.slice(-ClientErrorLimits.batch) })

/** What was kept on disk; nothing if it's unreadable (an older shape, a write cut short by the crash). */
export const decodeBatch = (text: string): ReadonlyArray<ClientErrorReport> =>
  Option.match(Schema.decodeUnknownOption(BatchJson)(text), { onNone: () => [], onSome: (batch) => batch.reports })
