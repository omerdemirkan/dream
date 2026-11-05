/**
 * Chat holds only what the agent deliberately sends, plus what they send.
 * Three kinds: text (with media), a question, and an access request.
 * Questions and access requests open into the expanded view and also appear on
 * Home while they are open.
 */
import { Schema } from "effect"
import { IntegrationId, MessageId, NotificationId, ProjectId } from "./Ids.ts"
import { MediaRef } from "./Media.ts"

const MessageFields = {
  id: MessageId,
  projectId: ProjectId,
  createdAt: Schema.DateTimeUtc,
  /** Set when this message was also sent as a push notification. */
  notificationId: Schema.optionalKey(NotificationId)
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export const MessageAuthor = Schema.Literals(["agent", "user"])
export type MessageAuthor = typeof MessageAuthor.Type

export const TextMessage = Schema.TaggedStruct("Text", {
  ...MessageFields,
  from: MessageAuthor,
  /** Markdown from the agent; plain text from them. */
  text: Schema.String,
  media: Schema.Array(MediaRef)
})
export type TextMessage = typeof TextMessage.Type

// ---------------------------------------------------------------------------
// Question
// ---------------------------------------------------------------------------

/** They picked one of the options, or wrote their own ("Something else…", typed or dictated). */
export const QuestionAnswer = Schema.TaggedUnion({
  Choice: { option: Schema.String },
  Freeform: { text: Schema.NonEmptyString }
})
export type QuestionAnswer = typeof QuestionAnswer.Type

export const QuestionState = Schema.TaggedUnion({
  Open: {},
  /** They can change an answer; the latest one wins and the agent hears about the change. */
  Answered: { answer: QuestionAnswer, answeredAt: Schema.DateTimeUtc },
  /** The agent no longer needs an answer. */
  Withdrawn: { withdrawnAt: Schema.DateTimeUtc }
})
export type QuestionState = typeof QuestionState.Type

export const QuestionMessage = Schema.TaggedStruct("Question", {
  ...MessageFields,
  question: Schema.NonEmptyString,
  options: Schema.Array(Schema.NonEmptyString),
  /** The one-line reason shown under the question (the TL;DR). */
  why: Schema.optionalKey(Schema.String),
  /** What the agent keeps doing while it waits. */
  meanwhile: Schema.optionalKey(Schema.String),
  state: QuestionState
})
export type QuestionMessage = typeof QuestionMessage.Type

// ---------------------------------------------------------------------------
// Access request
// ---------------------------------------------------------------------------

/** What the agent asks to be connected. Mirrors `dream access google|key|file|apple|oauth`. */
export const AccessRequest = Schema.TaggedUnion({
  /** Sign in with Google and grant these scopes (short names, e.g. "gmail.readonly"). */
  Google: { scopes: Schema.NonEmptyArray(Schema.NonEmptyString) },
  /** Paste an API key that Dream adds as `header: format` on HTTPS requests to `host`. */
  Key: {
    service: Schema.NonEmptyString,
    host: Schema.NonEmptyString,
    header: Schema.NonEmptyString,
    format: Schema.String.check(Schema.makeFilter((format) => format.includes("{key}") || "format must contain {key}"))
  },
  /**
   * The last resort, for a secret that can't travel in a header (Telegram's bot URLs, Discord's gateway login, SMTP):
   * they enter it in a secure field and Dream writes it into this project's sandbox as the file `name` in
   * `SandboxKeyDir`, readable by any code that runs there. The card says so.
   */
  File: { service: Schema.NonEmptyString, name: Schema.NonEmptyString },
  /** An App Store Connect API key (issuer id, key id, .p8), which TestFlight uploads need. */
  Apple: {},
  /**
   * Sign in to a service Dream connects with OAuth and grant these scopes, in the provider's own names (e.g.
   * "user-read-private" for Spotify). `provider` is the id Dream knows it by ("spotify"). `service` is its display
   * name; the CLI leaves it out and the API fills it in, so cards always carry it. Some providers have no scopes.
   */
  OAuth: {
    provider: Schema.NonEmptyString,
    service: Schema.optionalKey(Schema.String),
    scopes: Schema.Array(Schema.NonEmptyString)
  }
})
export type AccessRequest = typeof AccessRequest.Type

const dnsLabel = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * Why `host` can't be a `Key` request's host, or `undefined` if it can. E2B matches egress rule keys against
 * the DNS name of each HTTPS request, so anything but a bare name like api.stripe.com is a card whose key never
 * reaches a request. Wildcards (`*.example.com`) are refused: they don't match the apex, and they send the key to
 * every subdomain. Checked when a request is made, not when one is decoded, so stored cards keep loading.
 */
export const accessHostProblem = (host: string): string | undefined => {
  const example = "a bare DNS name like api.stripe.com (no scheme, path, port or spaces, at least one dot)"
  if (host.trim().length === 0) return `--host is empty; it should be ${example}.`
  if (/\s/.test(host)) return `--host "${host}" contains spaces; it should be ${example}.`
  if (host.startsWith("*")) {
    return `--host "${host}" is a wildcard; name the exact host the requests go to, like ${host.replace(/^\*\.?/, "api.")}.`
  }
  // Recover the host from a URL or host:port, to suggest it.
  const bare = host
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/[/?#].*$/, "")
    .replace(/^.*@/, "")
    .replace(/:\d*$/, "")
    .replace(/\.$/, "")
  const labels = bare.toLowerCase().split(".")
  const valid =
    bare.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => dnsLabel.test(label)) &&
    !/^\d+$/.test(labels.at(-1) ?? "")
  if (valid && bare === host) return undefined
  if (valid) return `--host "${host}" should be just the hostname: --host ${bare}.`
  if (!bare.includes(".")) {
    return `--host "${host}" isn't a hostname that requests go to; it should be ${example}, the API's real host.`
  }
  return `--host "${host}" isn't a valid hostname; it should be ${example}.`
}

/**
 * Why `name` can't be a `File` request's file name, or `undefined` if it can: lowercase letters, digits, `.`, `_`
 * and `-`, starting with a letter or digit, so it is one path segment that needs no quoting in a shell.
 */
export const keyFileNameProblem = (name: string): string | undefined =>
  /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)
    ? undefined
    : `--name "${name}" should be a short file name like telegram-bot-token: lowercase letters, digits, ".", "_" and "-".`

/** The file name a `File` request uses when the agent doesn't pick one, e.g. "Telegram bot" → "telegram-bot". */
export const keyFileNameFor = (service: string): string =>
  service
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "") || "key"

/** Why a connected access request isn't connected anymore. */
export const DisconnectReason = Schema.Literals([
  /** They removed it in Settings. */
  "removed",
  /** The service stopped accepting it (they revoked it there, or it lapsed). */
  "failed"
])
export type DisconnectReason = typeof DisconnectReason.Type

export const AccessState = Schema.TaggedUnion({
  Open: {},
  Connected: { integrationId: IntegrationId, connectedAt: Schema.DateTimeUtc },
  Declined: { declinedAt: Schema.DateTimeUtc },
  /**
   * It was connected, and the connection is gone. Like `Declined`, they can still connect it from the card. Added
   * after the first release: older apps show the card as one they can't display.
   */
  Disconnected: { integrationId: IntegrationId, disconnectedAt: Schema.DateTimeUtc, reason: DisconnectReason }
})
export type AccessState = typeof AccessState.Type

export const AccessMessage = Schema.TaggedStruct("Access", {
  ...MessageFields,
  request: AccessRequest,
  /** What the access is for, in the agent's words; the heading, e.g. "Connect Gmail so I can read your newsletters." */
  why: Schema.NonEmptyString,
  /** Roughly when it's needed, if not now, e.g. "around Thursday". Absent means now. */
  when: Schema.optionalKey(Schema.String),
  state: AccessState
})
export type AccessMessage = typeof AccessMessage.Type

// ---------------------------------------------------------------------------

export const Message = Schema.Union([TextMessage, QuestionMessage, AccessMessage]).pipe(Schema.toTaggedUnion("_tag"))
export type Message = typeof Message.Type

/** A question or access request: the messages that can need them. */
export const AskMessage = Schema.Union([QuestionMessage, AccessMessage]).pipe(Schema.toTaggedUnion("_tag"))
export type AskMessage = typeof AskMessage.Type

/** Whether a question or access request is still waiting on them. */
export const isOpenAsk = (message: Message): message is AskMessage =>
  message._tag !== "Text" && message.state._tag === "Open"
