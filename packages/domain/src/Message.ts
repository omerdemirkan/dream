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

/** What the agent asks to be connected. Mirrors `dream access google|key|apple`. */
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
  /** An App Store Connect API key (issuer id, key id, .p8), which TestFlight uploads need. */
  Apple: {}
})
export type AccessRequest = typeof AccessRequest.Type

export const AccessState = Schema.TaggedUnion({
  Open: {},
  Connected: { integrationId: IntegrationId, connectedAt: Schema.DateTimeUtc },
  Declined: { declinedAt: Schema.DateTimeUtc }
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
