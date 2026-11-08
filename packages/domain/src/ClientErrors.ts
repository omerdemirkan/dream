/**
 * Crash and error reports from the iPhone app: what broke, where in its code, on which screen, and which build and
 * update ran it, so the next crash comes with a stack trace. POSTed to `Routes.clientErrors` (no session needed: an
 * app that crashed while signing in still reports) and kept in D1 for operators. They carry no message text, names
 * or ids beyond the route's; the app reports the error, not what the person wrote.
 */
import { Schema } from "effect"

/** What a report may hold; the app cuts longer text to fit before sending. */
export const ClientErrorLimits = {
  message: 1000,
  stack: 12000,
  batch: 10
} as const

/** How it surfaced: an uncaught exception that ends the app, one that doesn't, a promise nobody caught, a screen that failed to render. */
export const ClientErrorKind = Schema.Literals(["fatal", "error", "rejection", "render"])
export type ClientErrorKind = typeof ClientErrorKind.Type

/** The build and update that ran into it. */
export const ClientBuild = Schema.Struct({
  /** The app's version and build number, e.g. "1.0.0" and "26858598". */
  version: Schema.String.check(Schema.isMaxLength(40)),
  build: Schema.String.check(Schema.isMaxLength(40)),
  /** The over-the-air update running, absent for the bundle the build shipped with. */
  updateId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  runtimeVersion: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  channel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))),
  /** "ios 26.1". */
  os: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40)))
})
export type ClientBuild = typeof ClientBuild.Type

export const ClientErrorReport = Schema.Struct({
  kind: ClientErrorKind,
  /** The error's name and message, e.g. "TypeError: undefined is not a function". */
  message: Schema.String.check(Schema.isMaxLength(ClientErrorLimits.message)),
  stack: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(ClientErrorLimits.stack))),
  /** React's component stack, for a screen that failed to render. */
  componentStack: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(ClientErrorLimits.stack))),
  /** The route it happened on, without its query, e.g. "/project/prj_…". */
  screen: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  build: ClientBuild,
  occurredAt: Schema.DateTimeUtc
})
export type ClientErrorReport = typeof ClientErrorReport.Type

/** One POST to `Routes.clientErrors`: a few reports at once (the app sends what it kept from a crash with a new one). */
export const ClientErrorBatch = Schema.Struct({
  reports: Schema.Array(ClientErrorReport).check(Schema.isMaxLength(ClientErrorLimits.batch))
})
export type ClientErrorBatch = typeof ClientErrorBatch.Type
