/**
 * Chat holds only what the agent deliberately sends, plus what they send.
 * Three kinds: text (with media), a question, and an access request.
 * Questions and access requests open into the expanded view and also appear on
 * Home while they are open.
 */
import { Schema } from "effect"
import { AppId, IntegrationId, MessageId, NotificationId, ProjectId, WorkstreamId } from "./Ids.ts"
import { LinkColor, LinkIcon } from "./Links.ts"
import { Attachment, MediaRef } from "./Media.ts"

const MessageFields = {
  id: MessageId,
  projectId: ProjectId,
  createdAt: Schema.DateTimeUtc,
  /** Set when this message was also sent as a push notification. */
  notificationId: Schema.optionalKey(NotificationId),
  /**
   * The workstream it belongs to (`Workstream.ts`): the agent's `--work`, their reply into one, or the agent filing
   * their message (`dream work route`). Added in November 2026; older apps ignore it.
   */
  workstream: Schema.optionalKey(WorkstreamId)
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
  media: Schema.Array(MediaRef),
  /**
   * Their messages only: photos and files they attached. Their text may be empty when there are some. Added in
   * November 2026; older apps ignore it.
   */
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  /** Their messages only: when Dream began delivering it to the agent's machine (the receipt under it reads "Seen"). */
  seenAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type TextMessage = typeof TextMessage.Type

// ---------------------------------------------------------------------------
// Question
// ---------------------------------------------------------------------------

/**
 * They picked one of the options, or wrote their own ("Something else…", typed or dictated). On a question with
 * previews, writing their own is how they say none of the options is it, and what's missing.
 */
export const QuestionAnswer = Schema.TaggedUnion({
  Choice: {
    option: Schema.String,
    /**
     * What they added to their pick, often what to take from another option ("B, but with A's calendar"). Added in
     * November 2026: older apps and dreamds ignore it.
     */
    note: Schema.optionalKey(Schema.NonEmptyString)
  },
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

/** How many previews a question can carry: media per option, and in all. */
export const QuestionPreviewLimits = { perOption: 8, total: 24 } as const

/**
 * What one option looks or sounds like, so they can pick from what they see and hear: screenshots at any size
 * (a phone's, a desktop's), screen recordings, clips, or audio such as voices and jingles, in the order to show them.
 */
export const QuestionPreview = Schema.Struct({
  /** One of the question's `options`, exactly. */
  option: Schema.NonEmptyString,
  media: Schema.NonEmptyArray(MediaRef)
})
export type QuestionPreview = typeof QuestionPreview.Type

/**
 * Why `previews` can't go with `options`, or `undefined` if they can: each names one of the options, at most once,
 * within `QuestionPreviewLimits`.
 */
export const questionPreviewsProblem = (
  options: ReadonlyArray<string>,
  previews: ReadonlyArray<{ readonly option: string; readonly media: ReadonlyArray<unknown> }>
): string | undefined => {
  const seen = new Set<string>()
  let total = 0
  for (const preview of previews) {
    if (!options.includes(preview.option)) {
      return `"${preview.option}" isn't one of the options (${options.map((o) => `"${o}"`).join(", ")}).`
    }
    if (seen.has(preview.option)) return `"${preview.option}" has more than one preview; list its files together.`
    seen.add(preview.option)
    if (preview.media.length > QuestionPreviewLimits.perOption) {
      return `"${preview.option}" has ${preview.media.length} files; an option shows at most ${QuestionPreviewLimits.perOption}.`
    }
    total += preview.media.length
  }
  return total > QuestionPreviewLimits.total
    ? `That's ${total} files; a question shows at most ${QuestionPreviewLimits.total}.`
    : undefined
}

export const QuestionMessage = Schema.TaggedStruct("Question", {
  ...MessageFields,
  /** The decision itself, shown as the card's heading in large type. Agents sometimes write more here anyway. */
  question: Schema.NonEmptyString,
  options: Schema.Array(Schema.NonEmptyString),
  /** The one-line reason shown under the question (the TL;DR). */
  why: Schema.optionalKey(Schema.String),
  /**
   * What they need to know to decide, when it takes more than a line (the options and their trade-offs), in
   * markdown at body size under the question: a few lines on the card, all of it expanded. Added after the
   * first release: older apps ignore it and show the question alone.
   */
  context: Schema.optionalKey(Schema.String),
  /** What the agent keeps doing while it waits. */
  meanwhile: Schema.optionalKey(Schema.String),
  /**
   * What some or all of the options look or sound like (`dream ask --show`), in the order of `options`. The card
   * shows a thumbnail of each, and they open full screen to compare and pick, with a note if they like. Added in
   * November 2026: older apps ignore it and show the options as buttons, which answer the same way.
   */
  previews: Schema.optionalKey(Schema.Array(QuestionPreview)),
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
  },
  /**
   * Let one of the project's apps notify them under its own name (`dream notify setup`). The card says what it will
   * tell them (the message's `why`) and how `often`, with the app's tile. "Allow" makes it `Allowed`; until then
   * nothing the app sends reaches their phone. Added in November 2026: older apps show a card they can't display.
   */
  Notifications: {
    app: AppId,
    name: Schema.NonEmptyString,
    often: Schema.NonEmptyString,
    icon: Schema.optionalKey(LinkIcon),
    color: Schema.optionalKey(LinkColor)
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

/**
 * Why they declined an access request, in their words or one of the app's one-tap reasons ("I'd rather not share
 * this"). Optional: declining without one is still one tap.
 */
export const DeclineReason = Schema.NonEmptyString.check(Schema.isMaxLength(500))
export type DeclineReason = typeof DeclineReason.Type

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
  /** `reason` was added later: older apps ignore it, and older ones decline without one. */
  Declined: { declinedAt: Schema.DateTimeUtc, reason: Schema.optionalKey(DeclineReason) },
  /**
   * It was connected, and the connection is gone. Like `Declined`, they can still connect it from the card. Added
   * after the first release: older apps show the card as one they can't display.
   */
  Disconnected: { integrationId: IntegrationId, disconnectedAt: Schema.DateTimeUtc, reason: DisconnectReason },
  /** A `Notifications` request they allowed (there's nothing to connect). Added in November 2026. */
  Allowed: { allowedAt: Schema.DateTimeUtc }
})
export type AccessState = typeof AccessState.Type

/**
 * They asked Dream to email them a link to finish an access request on a computer (`EmailAccessLink`): when, to
 * which address (the one on file from their sign-in), and when the link was first opened. Added in November 2026:
 * older apps ignore it.
 */
export const AccessDesktop = Schema.Struct({
  sentAt: Schema.DateTimeUtc,
  to: Schema.String,
  openedAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type AccessDesktop = typeof AccessDesktop.Type

export const AccessMessage = Schema.TaggedStruct("Access", {
  ...MessageFields,
  request: AccessRequest,
  /**
   * The request in the agent's words, read first and often alone (Home, the lock screen); the heading, e.g.
   * "Connect Gmail so I can read your newsletters." See `accessHeading` for one that doesn't name the service.
   */
  why: Schema.NonEmptyString,
  /**
   * How to get it, in markdown, for a key they make themselves: a link to the exact page and what to tap there.
   * Shown on the card and above the paste field. Added after the first release: older apps don't show it.
   */
  context: Schema.optionalKey(Schema.String),
  /** Roughly when it's needed, if not now, e.g. "around Thursday". Absent means now. */
  when: Schema.optionalKey(Schema.String),
  state: AccessState,
  /** The latest link they had emailed to finish this on a computer, if they asked for one. */
  desktop: Schema.optionalKey(AccessDesktop)
})
export type AccessMessage = typeof AccessMessage.Type

/**
 * Whether an access request can be emailed to finish on a computer: one still waiting to be connected (open, or
 * connected once and gone), for anything but app notifications, which need no typing. The emailed link stops
 * working as soon as this is false.
 */
export const canFinishOnDesktop = (message: Pick<AccessMessage, "request" | "state">): boolean =>
  message.request._tag !== "Notifications" && (message.state._tag === "Open" || message.state._tag === "Disconnected")

const googleProducts: ReadonlyArray<readonly [string, string]> = [
  ["gmail", "Gmail"],
  ["calendar", "Google Calendar"],
  ["drive", "Google Drive"],
  ["spreadsheets", "Google Sheets"],
  ["sheets", "Google Sheets"],
  ["documents", "Google Docs"],
  ["docs", "Google Docs"],
  ["youtube", "YouTube"],
  ["photos", "Google Photos"],
  ["contacts", "Google Contacts"],
  ["tasks", "Google Tasks"]
]

/** The Google product the scopes are for ("Gmail"), or "Google" when they span several or none. */
export const googleProduct = (scopes: ReadonlyArray<string>): string => {
  const products = new Set<string>()
  for (const scope of scopes) {
    const product = googleProducts.find(([prefix]) => scope.toLowerCase().startsWith(prefix))
    if (product) products.add(product[1])
  }
  return products.size === 1 ? (Array.from(products)[0] ?? "Google") : "Google"
}

/** The service an access request is for, as they know it: "Gmail", "Stripe", "Apple Developer", "Spotify". */
export const accessService = (request: AccessRequest): string => {
  switch (request._tag) {
    case "Google":
      return googleProduct(request.scopes)
    case "Key":
    case "File":
      return request.service
    case "Apple":
      return "Apple Developer"
    case "OAuth":
      // The API always fills in `service`; the provider id stands in otherwise.
      return request.service ?? request.provider.charAt(0).toUpperCase() + request.provider.slice(1)
    case "Notifications":
      return request.name
  }
}

/**
 * The heading of an access card, which they read first and often alone. The agent's `why` is the heading when it
 * names the service ("Connect Gmail so I can read your newsletters."). When it doesn't ("Take payments"), the
 * heading says what's asked ("Add your Stripe key") and the agent's words become the `reason` under it.
 */
export const accessHeading = (message: Pick<AccessMessage, "request" | "why">): { title: string; reason?: string } => {
  const request = message.request
  if (request._tag === "Notifications") return { title: `Let ${request.name} notify you`, reason: message.why.trim() }
  const service = accessService(request)
  const names = [
    service,
    ...(request._tag === "Google" ? ["Google"] : request._tag === "Apple" ? ["App Store", "Apple"] : [])
  ]
  const why = message.why.trim()
  if (names.some((name) => why.toLowerCase().includes(name.toLowerCase()))) return { title: why }
  const title =
    request._tag === "Apple"
      ? "Add your App Store Connect key"
      : request._tag === "Key" || request._tag === "File"
        ? `Add your ${service} key`
        : `Connect ${service}`
  return { title, reason: why }
}

// ---------------------------------------------------------------------------

export const Message = Schema.Union([TextMessage, QuestionMessage, AccessMessage]).pipe(Schema.toTaggedUnion("_tag"))
export type Message = typeof Message.Type

/** A question or access request: the messages that can need them. */
export const AskMessage = Schema.Union([QuestionMessage, AccessMessage]).pipe(Schema.toTaggedUnion("_tag"))
export type AskMessage = typeof AskMessage.Type

/** Whether a question or access request is still waiting on them. */
export const isOpenAsk = (message: Message): message is AskMessage =>
  message._tag !== "Text" && message.state._tag === "Open"

/** An ask's heading on one line, for a notification or the Live Activity: "Add your Stripe key: Take payments". */
export const askHeadline = (message: AskMessage): string => {
  if (message._tag === "Question") return message.question
  const heading = accessHeading(message)
  return heading.reason === undefined ? heading.title : `${heading.title}: ${heading.reason}`
}
