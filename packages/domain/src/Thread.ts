/**
 * Threads: the replies to one message, gathered under it. Any message can start one, theirs or the agent's, a
 * question or an access request included. A reply carries the id of the thread's first message (`replyTo` on every
 * message), and a reply to a reply goes into the same thread, so threads are one level deep.
 *
 * In Chat a thread folds into one line under its first message, and opens into a view of that message with the
 * replies under it, where a question or access request can still be answered. A reply goes into the workstream of
 * the message it answers, so a thread on a labeled message is also writing into that workstream. Added in November
 * 2026; older apps show replies in Chat where they fall.
 */
import { Schema } from "effect"
import { MessageId } from "./Ids.ts"
import { accessHeading, type Message, MessageAuthor } from "./Message.ts"

export const ThreadKind = Schema.Literals(["text", "question", "access"])
export type ThreadKind = typeof ThreadKind.Type

/** A thread's first message as an event names it, with enough of it to make sense of a reply. */
export const ThreadRef = Schema.Struct({
  messageId: MessageId,
  from: MessageAuthor,
  kind: ThreadKind,
  /** The start of the text (`threadExcerpt`), or the question or access request's heading. */
  excerpt: Schema.String,
  /** A question or access request still waiting on them. */
  open: Schema.optionalKey(Schema.Boolean)
})
export type ThreadRef = typeof ThreadRef.Type

/** How much of a message an event quotes. */
export const ThreadExcerptLength = 280

/** Who sent a message: only text comes from them. */
export const messageAuthor = (message: Message): MessageAuthor => (message._tag === "Text" ? message.from : "agent")

/** The first message of the thread a reply to `message` goes into. */
export const threadRootId = (message: Message): MessageId => message.replyTo ?? message.id

/**
 * The start of a message, on one line and cut at a word with "…" past `max` characters: its text, the question, or
 * the access request's heading. Their photos and files stand in for an empty text.
 */
export const threadExcerpt = (message: Message, max: number = ThreadExcerptLength): string => {
  const whole =
    message._tag === "Text"
      ? message.text.trim() === "" && (message.attachments?.length ?? 0) > 0
        ? `(${message.attachments?.length === 1 ? "an attachment" : `${message.attachments?.length} attachments`})`
        : message.text
      : message._tag === "Question"
        ? message.question
        : accessHeading(message).title
  const line = whole.replace(/\s+/g, " ").trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`
}

/** How an event names a thread's first message. */
export const threadRefOf = (root: Message): ThreadRef => ({
  messageId: root.id,
  from: messageAuthor(root),
  kind: root._tag === "Text" ? "text" : root._tag === "Question" ? "question" : "access",
  excerpt: threadExcerpt(root),
  ...(root._tag === "Text" ? {} : { open: root.state._tag === "Open" })
})

/** Each thread's replies, oldest first, by the id of its first message, from messages oldest first. */
export const repliesByRoot = (messages: ReadonlyArray<Message>): ReadonlyMap<MessageId, ReadonlyArray<Message>> => {
  const threads = new Map<MessageId, Array<Message>>()
  for (const message of messages) {
    if (message.replyTo === undefined) continue
    const replies = threads.get(message.replyTo)
    if (replies) replies.push(message)
    else threads.set(message.replyTo, [message])
  }
  return threads
}
