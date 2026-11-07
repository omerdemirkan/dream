/**
 * Threads in Chat (`Thread.ts` in the domain). Chat shows the messages that start no thread of their own, each
 * followed by its thread folded into one line ("2 replies · Dream: …"); the replies themselves are in the thread.
 *
 * A reply of the agent's that lands after other messages would otherwise go unseen, folded under a message far up
 * Chat, so it also shows where it falls, as a line naming the message it answers. Theirs never do: they wrote it in
 * the thread, and know.
 */
import { type Message, type MessageId, repliesByRoot, threadExcerpt } from "@dream/domain"

export interface ThreadSummary {
  readonly count: number
  readonly latest: Message
}

export type ChatItem =
  | { readonly _tag: "Message"; readonly message: Message; readonly thread: ThreadSummary | undefined }
  /** An agent's reply in a thread, where it falls: `root` is undefined while Chat hasn't loaded that far back. */
  | { readonly _tag: "Echo"; readonly reply: Message; readonly root: Message | undefined }

/** Chat's rows, from messages oldest first. */
export const chatItems = (messages: ReadonlyArray<Message>): ReadonlyArray<ChatItem> => {
  const threads = repliesByRoot(messages)
  const loaded = new Map(messages.map((m) => [m.id, m]))
  const items: Array<ChatItem> = []
  let lastTop: MessageId | undefined
  for (const message of messages) {
    if (message.replyTo === undefined) {
      const replies = threads.get(message.id)
      const latest = replies?.at(-1)
      items.push({
        _tag: "Message",
        message,
        thread: replies === undefined || latest === undefined ? undefined : { count: replies.length, latest }
      })
      lastTop = message.id
      continue
    }
    const fromAgent = message._tag !== "Text" || message.from === "agent"
    if (fromAgent && message.replyTo !== lastTop) {
      items.push({ _tag: "Echo", reply: message, root: loaded.get(message.replyTo) })
    }
  }
  return items
}

/** The messages Chat shows on their own (no replies), for the receipt and the activity row. */
export const topLevel = (messages: ReadonlyArray<Message>): ReadonlyArray<Message> =>
  messages.filter((m) => m.replyTo === undefined)

/** A thread's first message and its replies, oldest first, merging what was fetched with what's live. */
export const threadOf = (
  messages: ReadonlyArray<Message>,
  rootId: MessageId,
  fetched?: { readonly root: Message; readonly replies: ReadonlyArray<Message> } | undefined
): { readonly root: Message | undefined; readonly replies: ReadonlyArray<Message> } => {
  const live = new Map(messages.map((m) => [m.id, m]))
  const root = live.get(rootId) ?? fetched?.root
  const byId = new Map<MessageId, Message>()
  for (const reply of fetched?.replies ?? []) byId.set(reply.id, live.get(reply.id) ?? reply)
  for (const message of messages) if (message.replyTo === rootId) byId.set(message.id, message)
  const replies = [...byId.values()].sort((a, b) => a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds)
  return { root, replies }
}

/** Who sent a message, as a thread line names them. */
export const senderName = (message: Message): string =>
  message._tag === "Text" && message.from === "user" ? "You" : "Dream"

/** The line a thread folds into: "2 replies" and "Dream: It does now…". */
export const foldLine = (summary: ThreadSummary): { readonly count: string; readonly latest: string } => ({
  count: summary.count === 1 ? "1 reply" : `${summary.count} replies`,
  latest: `${senderName(summary.latest)}: ${threadExcerpt(summary.latest, 120)}`
})

/** What Copy puts on the clipboard: the text, or a card's heading (with a question's options). */
export const copyText = (message: Message): string => {
  switch (message._tag) {
    case "Text":
      return message.text
    case "Question":
      return [message.question, ...message.options.map((o) => `• ${o}`)].join("\n")
    case "Access":
      return threadExcerpt(message, 10_000)
  }
}
