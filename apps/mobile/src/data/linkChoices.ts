/**
 * What the add sheet over Home's app links offers. Only agents make links, so it offers the ones they took off
 * Home that aren't back on it some other way (a link they added themselves to the same address, from before),
 * most recently removed first. When there's nothing to offer, it says why: no agent has made one yet, or every
 * one is on Home already.
 */
import type { AppLink } from "@dream/domain"

export type LinkChoices =
  | { readonly _tag: "Choices"; readonly links: ReadonlyArray<AppLink> }
  | { readonly _tag: "NothingYet" }
  | { readonly _tag: "AllOnHome" }

/** URLs that differ only by a trailing slash are the same link, as the API counts them. */
const sameUrl = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "")

/** `onHome` is Home's row (`ListLinks`); `removed` the agents' links they removed (`ListRemovedLinks`). */
export const linkChoices = (onHome: ReadonlyArray<AppLink>, removed: ReadonlyArray<AppLink>): LinkChoices => {
  const links = removed
    .filter((link) => link.addedBy === "agent" && link.removedAt !== undefined)
    .filter((link) => !onHome.some((home) => sameUrl(home.url, link.url)))
    .filter((link, i, all) => all.findIndex((other) => sameUrl(other.url, link.url)) === i)
  if (links.length > 0) return { _tag: "Choices", links }
  const anyByAgents = onHome.some((link) => link.addedBy === "agent") || removed.some((l) => l.addedBy === "agent")
  return anyByAgents ? { _tag: "AllOnHome" } : { _tag: "NothingYet" }
}
