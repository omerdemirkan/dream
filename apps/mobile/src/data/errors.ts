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
    default:
      return "Something went wrong. Try again."
  }
}
