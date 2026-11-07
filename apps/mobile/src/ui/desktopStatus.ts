/** Where a link they had emailed to finish an access request on a computer stands (`AccessMessage.desktop`). */
import type { AccessMessage } from "@dream/domain"
import { DateTime } from "effect"

/** How long an emailed link works (the API's `LinkLifetime`). */
export const linkMinutes = 30

/** Where the link stands: not sent, sent and waiting, opened on a computer, or past its 30 minutes unopened. */
export const desktopStatus = (message: AccessMessage, now: number) => {
  const desktop = message.desktop
  if (desktop === undefined) return { _tag: "NotSent" } as const
  if (desktop.openedAt !== undefined) return { _tag: "Opened", to: desktop.to } as const
  const expired = DateTime.toEpochMillis(desktop.sentAt) + linkMinutes * 60_000 <= now
  return expired ? ({ _tag: "Expired", to: desktop.to } as const) : ({ _tag: "Sent", to: desktop.to } as const)
}
