import type { ProjectId, PushData } from "@dream/domain"
import { Option } from "effect"

/**
 * Whether a notification that arrives while Dream is open should show. A withdrawal never does. Nor does one
 * about the project whose screen is in front: what it says is already arriving there, so a banner and a sound
 * would only repeat it. One of the project's apps' notifications isn't in Chat, so it shows even there. Everything
 * else shows as usual.
 */
export const showsWhileOpen = (data: Option.Option<PushData>, viewing: ProjectId | undefined): boolean =>
  Option.match(data, {
    onNone: () => true,
    onSome: (push) => (push._tag === "Withdraw" ? false : push._tag === "OpenApp" ? true : push.projectId !== viewing)
  })
