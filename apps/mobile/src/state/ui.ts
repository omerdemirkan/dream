/**
 * Screen state that isn't data: the expanded message, where Chat should land,
 * the toast, and the media viewer.
 */
import type {
  AccessMessage,
  AskMessage,
  LinkId,
  MediaRef,
  Message,
  MessageId,
  ProjectId,
  QuestionMessage
} from "@dream/domain"
import { Option } from "effect"
import { Atom } from "effect/reactivity"

/** A rectangle in window coordinates. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A question or access request, expanded to full screen. */
export interface Focus {
  readonly projectId: ProjectId
  readonly messageId: MessageId
  /** Where it grows from (the card that was tapped); absent when opened from a notification or link. */
  readonly origin: Rect | undefined
  /** The message as the opener knew it, shown until the project's live state has it. */
  readonly message: AskMessage | undefined
  /** Opened by answering the one before, so it slides in rather than growing. */
  readonly advanced?: boolean
  /** The asks answered on the way here, which a stale list may still show as open. */
  readonly passed?: ReadonlyArray<MessageId>
}

export const focusAtom = Atom.make<Option.Option<Focus>>(Option.none()).pipe(Atom.keepAlive)

/** Chat should scroll to this message, and highlight it briefly once it's in view. */
export interface Landing {
  readonly projectId: ProjectId
  readonly messageId: MessageId
  readonly highlight: boolean
  readonly at: number
}

export const landingAtom = Atom.make<Option.Option<Landing>>(Option.none()).pipe(Atom.keepAlive)

export interface Toast {
  readonly message: string
  /** Offers Undo for archiving this project: it's restored. */
  readonly restore?: ProjectId | undefined
  /** Something they did went through ("Sent to Cabin"); otherwise it's a failure, shown with a warning. */
  readonly done?: boolean
  readonly at: number
}

export const toastAtom = Atom.make<Option.Option<Toast>>(Option.none()).pipe(Atom.keepAlive)

/** Bumped when a moment calls for asking to send notifications (a first idea, a first answer). */
export const askPushAtom = Atom.make(0).pipe(Atom.keepAlive)

/** The project whose Notifications sheet is up (its apps that notify, and what they sent). */
export const appNotificationsSheetAtom = Atom.make<Option.Option<ProjectId>>(Option.none()).pipe(Atom.keepAlive)

/** The access request whose decline sheet is up ("Why not?"). */
export const declineAtom = Atom.make<Option.Option<AccessMessage>>(Option.none()).pipe(Atom.keepAlive)

export const viewerAtom = Atom.make<Option.Option<MediaRef>>(Option.none()).pipe(Atom.keepAlive)

/** A question's option previews, full screen, opened at one of its options (`index`). */
export interface OptionsView {
  readonly message: QuestionMessage
  readonly index: number
}

export const optionsViewerAtom = Atom.make<Option.Option<OptionsView>>(Option.none()).pipe(Atom.keepAlive)

/** A message's thread, open over its project's Chat; `highlight` is a reply to show (from a notification). */
export interface OpenThread {
  readonly projectId: ProjectId
  readonly messageId: MessageId
  readonly highlight?: MessageId | undefined
  /** Opened to reply (Reply in a menu or the expanded view): the composer takes the keyboard. */
  readonly compose?: boolean
  /** When it was asked for, so asking again (Reply while it's open) focuses the composer again. */
  readonly at?: number
}

export const threadOpenAtom = Atom.make<Option.Option<OpenThread>>(Option.none()).pipe(Atom.keepAlive)

/** A message held down: lifted over a dimmed screen where it was, with its menu (Reply, Copy, its card's own). */
export interface Held {
  readonly message: Message
  readonly rect: Rect
}

export const heldAtom = Atom.make<Option.Option<Held>>(Option.none()).pipe(Atom.keepAlive)

/** Hold this message as if pressed (`?hold=<messageId>`, for checking the menu from a link). */
export const holdRequestAtom = Atom.make<Option.Option<MessageId>>(Option.none()).pipe(Atom.keepAlive)

type Measure = () => Promise<Rect | undefined>
const rects = new Map<MessageId, Array<Measure>>()

/**
 * Measures for the message cards on screen, so the expanded view can shrink back into one. A card can be on screen
 * twice (in Chat, and in its thread over it); the one shown last is measured, and the other again once it goes.
 */
export const messageRects = {
  set: (id: MessageId, measure: Measure): (() => void) => {
    rects.set(id, [...(rects.get(id) ?? []), measure])
    return () => {
      const left = (rects.get(id) ?? []).filter((m) => m !== measure)
      if (left.length === 0) rects.delete(id)
      else rects.set(id, left)
    }
  },
  get: (id: MessageId): Measure | undefined => rects.get(id)?.at(-1)
}

/** The sheet open over Home for app links: adding one, changing one's icon, or putting one on the Home Screen. */
export type LinkSheet =
  | { readonly kind: "add" }
  | { readonly kind: "icon"; readonly linkId: LinkId }
  | { readonly kind: "home-screen"; readonly linkId: LinkId }

export const linkSheetAtom = Atom.make<Option.Option<LinkSheet>>(Option.none()).pipe(Atom.keepAlive)
