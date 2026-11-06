/**
 * Which ask comes next once they've answered one: in a project's Chat, or across Home's deck.
 */
import type { AskMessage, Message, MessageId } from "@dream/domain"

/** A question or access request still waiting on them (an access request for later doesn't count). */
export const needsThem = (m: Message): m is AskMessage =>
  m._tag !== "Text" && m.state._tag === "Open" && !(m._tag === "Access" && m.when)

/**
 * The next open ask after `current`, in order, skipping the ones in `passed` (answered on the way, which a list
 * that hasn't caught up may still show as open). `wrap` goes back to the start for one earlier in the list.
 */
export const nextOpenAsk = (
  messages: ReadonlyArray<Message>,
  current: MessageId,
  options: { readonly passed?: ReadonlyArray<MessageId>; readonly wrap: boolean }
): AskMessage | undefined => {
  const fresh = (m: Message): m is AskMessage => needsThem(m) && m.id !== current && !options.passed?.includes(m.id)
  const at = messages.findIndex((m) => m.id === current)
  const after = messages.slice(at + 1).find(fresh)
  return after ?? (options.wrap && at > 0 ? messages.slice(0, at).find(fresh) : undefined)
}
