import { Data, Duration, Effect } from "effect"

/**
 * A write (an answer, a message, a new idea, a decline) that didn't complete in
 * time. On a weak connection a request can hang rather than fail; without a
 * limit the person would never learn their answer didn't go out.
 */
export class RequestTimedOut extends Data.TaggedError("RequestTimedOut")<{}> {}

/** Long enough for a slow cellular round trip and a project starting up; short enough that they're still looking. */
export const writeTimeout = Duration.seconds(25)

/**
 * Fails with `RequestTimedOut` if the write doesn't finish within `writeTimeout`.
 * Every write the phone may retry carries a request id or is idempotent on the
 * API, so retrying after a timeout can't post anything twice.
 */
export const withWriteTimeout = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E | RequestTimedOut, R> =>
  Effect.timeoutOrElse(self, { duration: writeTimeout, orElse: () => Effect.fail(new RequestTimedOut()) })

/**
 * One line, in plain words, for any failure the API or the transport can
 * report. Shown in toasts and under forms.
 */
export const describeError = (error: unknown): string => {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return "Something went wrong. Try again."
  const field = (key: string) => {
    const value: unknown = Reflect.get(error, key)
    return typeof value === "string" ? value : undefined
  }
  switch (error._tag) {
    case "InvalidRequest":
    case "NoModelConnection":
      return field("message") ?? "That didn't work."
    case "NotFound":
      return "That isn't there anymore."
    case "Unauthorized":
      return "You've been signed out. Sign in again."
    case "NotInvited":
      return `${field("email") ?? "That account"} isn't on Dream's invite list yet.`
    case "UpstreamFailure":
      return `${field("service") ?? "A service Dream uses"} didn't respond. Try again in a moment.`
    case "RpcClientError":
      return "Can't reach Dream right now. Check your connection and try again."
    case "RequestTimedOut":
      return "That didn't go through — the connection is slow. Try again."
    default:
      return "Something went wrong. Try again."
  }
}
