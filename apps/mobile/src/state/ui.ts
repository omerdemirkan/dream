/**
 * Screen state that isn't data: the expanded message, where Chat should land,
 * the toast, and the media viewer.
 */
import type { AskMessage, LinkId, MediaRef, MessageId, ProjectId } from "@dream/domain"
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

export const viewerAtom = Atom.make<Option.Option<MediaRef>>(Option.none()).pipe(Atom.keepAlive)

/** Measures for the message cards on screen in Chat, so the expanded view can shrink back into one. */
export const messageRects = new Map<MessageId, () => Promise<Rect | undefined>>()

/** The sheet open over Home for app links: adding one, changing one's icon, or putting one on the Home Screen. */
export type LinkSheet =
  | { readonly kind: "add" }
  | { readonly kind: "icon"; readonly linkId: LinkId }
  | { readonly kind: "home-screen"; readonly linkId: LinkId }

export const linkSheetAtom = Atom.make<Option.Option<LinkSheet>>(Option.none()).pipe(Atom.keepAlive)
