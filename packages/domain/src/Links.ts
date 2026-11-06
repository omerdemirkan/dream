/**
 * App links: the row of app icons at the top of Home, under the Dream header and above Projects. Each is a
 * launcher for something they open often, usually what a project published. Tapping one opens it; holding it
 * brings up a menu (Open, Share, Add to Home Screen, Rename, Change icon, Remove) headed by who made it and
 * the host it goes to.
 *
 * The shape is exactly what the row shows: an icon tile and a one-line label under it, a small dot before the
 * label until they first open a link an agent added, and on long-press "Made by <project>" or "Added by you" with
 * the host. Nothing else is shown anywhere, so nothing else is stored.
 *
 * A project's agent makes them with `dream link`; they add their own from the add sheet (any https URL, or a
 * project's published URL). Links live per person in D1, with the project they belong to, if any. An archived
 * project's links leave Home until it's restored; a deleted project's links are deleted with it.
 */
import { Schema } from "effect"
import { LinkId, ProjectId } from "./Ids.ts"
import { MediaRef } from "./Media.ts"

// ---------------------------------------------------------------------------
// The tile
// ---------------------------------------------------------------------------

/**
 * The tile's background: a soft vertical gradient in one of these, picked to sit next to real app icons. White
 * glyphs, but dark ones on `yellow` and `light`. An `Image` icon fills the tile and ignores it.
 */
export const LinkColor = Schema.Literals([
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "graphite",
  "light"
])
export type LinkColor = typeof LinkColor.Type

/** SF Symbol names are lowercase ASCII words joined by dots, e.g. "dumbbell", "sun.horizon.fill". */
export const SymbolName = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(\.[a-z0-9]+)*$/), Schema.isMaxLength(64))

const emojiPattern = (() => {
  // One emoji: a flag, a keycap, or a pictograph with modifiers and ZWJ joins. Built at runtime so an engine
  // without these property escapes falls back to the length check below instead of failing to load.
  try {
    return new RegExp(
      "^(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})*" +
        "(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})*)*)$",
      "u"
    )
  } catch {
    return undefined
  }
})()

/** Whether `text` is a single emoji (one tile glyph). */
export const isSingleEmoji = (text: string): boolean =>
  emojiPattern === undefined
    ? text.length > 0 && text.length <= 16 && !/[A-Za-z0-9\s]/.test(text)
    : emojiPattern.test(text)

export const LinkEmoji = Schema.String.check(
  Schema.makeFilter((text: string) => isSingleEmoji(text) || "must be a single emoji")
)

/** What's drawn on the tile. Absent on a link: the first letter of its title, as a monogram. */
export const LinkIcon = Schema.TaggedUnion({
  /** An SF Symbol, drawn in white (dark on `yellow` and `light`) in the middle of the tile. */
  Symbol: { name: SymbolName },
  /** An emoji, large in the middle of the tile. */
  Emoji: { emoji: LinkEmoji },
  /**
   * A square png or jpg the agent made, uploaded through Dream's media path (`dream link --icon file.png`). It fills
   * the whole tile, which iOS rounds, so it has no corners or margin of its own.
   */
  Image: { media: MediaRef }
})
export type LinkIcon = typeof LinkIcon.Type

// ---------------------------------------------------------------------------
// The label
// ---------------------------------------------------------------------------

/** Longest title anyone can give a link. The label shows about ten characters of it (see `linkLabel`). */
export const LinkTitleMaxLength = 24

export const LinkTitle = Schema.String.check(
  Schema.makeFilter((text: string) => text.trim() === text || "has spaces at either end"),
  Schema.makeFilter((text: string) => !/[\n\r\t]/.test(text) || "must be one line"),
  Schema.isMinLength(1),
  Schema.isMaxLength(LinkTitleMaxLength)
)

/** How wide the label under a tile can be, in points of 12 pt SF Pro (the app's `labelWidth`, 8 pt between labels). */
const labelWidth = 68

// Advance widths at 12 pt, from Helvetica's metrics, which run about 5% narrower than SF Pro's (measured in the
// Simulator: "Morning Brief" is 74.7 pt). Others count as wide.
const narrow = new Map<string, number>(
  Object.entries({
    " ": 278,
    i: 222,
    j: 222,
    l: 222,
    f: 278,
    t: 278,
    r: 333,
    I: 278,
    ".": 278,
    ",": 278,
    "'": 191,
    "’": 222,
    ":": 278,
    "!": 278,
    "-": 333,
    "(": 333,
    ")": 333,
    "/": 278,
    "·": 278
  })
)
const wide = new Map<string, number>(
  Object.entries({
    m: 833,
    w: 722,
    M: 833,
    W: 944,
    O: 778,
    G: 778,
    Q: 778,
    C: 722,
    D: 722,
    H: 722,
    N: 722,
    R: 722,
    U: 722
  })
)
const charWidth = (char: string): number => {
  const known = narrow.get(char) ?? wide.get(char)
  if (known !== undefined) return (known * 12) / 1000
  if (/[a-z0-9]/.test(char)) return (/[ckszvxy]/.test(char) ? 500 : 556) * 0.012
  if (/[A-Z]/.test(char)) return (/[FTZJ]/.test(char) ? 611 : 667) * 0.012
  return 1000 * 0.012
}
const widthOf = (text: string) => [...text].reduce((sum, char) => sum + charWidth(char), 0) * 1.05

/**
 * What the label under the tile reads: the whole title when it fits on the one line, else as much as fits and
 * "…". An estimate (the phone measures the real text), close enough to tell an agent whether a name reads whole.
 */
export const linkLabel = (title: string): { readonly shown: string; readonly whole: boolean } =>
  fitLine(title, labelWidth, 12)

/**
 * `text` on one line `width` points wide in the system font at `size` points: whole, or as much as fits and "…".
 * An estimate, close enough to tell an agent whether its words read whole.
 */
export const fitLine = (
  text: string,
  width: number,
  size: number
): { readonly shown: string; readonly whole: boolean } => {
  const room = (width * 12) / size
  if (widthOf(text) <= room) return { shown: text, whole: true }
  let shown = ""
  for (const char of [...text]) {
    if (widthOf(`${shown}${char}…`) > room) break
    shown += char
  }
  return { shown: `${shown.trimEnd()}…`, whole: false }
}

/**
 * `text` wrapped at word boundaries into lines `width` points wide in the system font at `size` points, as iOS
 * lays out a paragraph (a word too long for a line breaks within it). An estimate, like `fitLine`.
 */
export const wrapLines = (text: string, width: number, size: number): ReadonlyArray<string> => {
  const room = (width * 12) / size
  const lines: Array<string> = []
  let line = ""
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    const joined = line === "" ? word : `${line} ${word}`
    if (widthOf(joined) <= room) {
      line = joined
      continue
    }
    if (line !== "") lines.push(line)
    line = ""
    for (const char of [...word]) {
      if (line !== "" && widthOf(`${line}${char}`) > room) {
        lines.push(line)
        line = ""
      }
      line += char
    }
  }
  if (line !== "") lines.push(line)
  return lines
}

// ---------------------------------------------------------------------------
// A link
// ---------------------------------------------------------------------------

/** Only https links: they open in Safari, and Safari can put them on the Home Screen. */
export const LinkUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((text: string) => linkUrlProblem(text) ?? true)
)

// Parsed by hand: React Native's URL can't read a host, and the domain gets no platform globals.
const urlParts = /^https:\/\/([A-Za-z0-9.-]+)(:[0-9]{1,5})?([/?#][^\s]*)?$/

/** Why `text` can't be a link's URL, or undefined if it can. */
export const linkUrlProblem = (text: string): string | undefined => {
  if (!/^https:\/\//i.test(text)) return "must start with https://"
  if (/\s/.test(text)) return "can't contain spaces"
  const parts = urlParts.exec(text)
  if (parts === null) return "isn't a URL Dream can open (only a host name, then a path)"
  const host = parts[1] ?? ""
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) return "needs a public host name"
  return undefined
}

export const LinkAuthor = Schema.Literals(["agent", "person"])
export type LinkAuthor = typeof LinkAuthor.Type

/** What they changed themselves on an agent's link; the agent can no longer change it. */
export const LinkPart = Schema.Literals(["title", "icon"])
export type LinkPart = typeof LinkPart.Type

export const AppLink = Schema.Struct({
  id: LinkId,
  url: LinkUrl,
  /** The label under the tile, and the app's name if they add it to their iPhone's Home Screen. */
  title: LinkTitle,
  /** Absent: a monogram of the title's first letter. */
  icon: Schema.optionalKey(LinkIcon),
  color: LinkColor,
  /** The project it belongs to: the one whose agent made it, or whose published URL they added. */
  projectId: Schema.optionalKey(ProjectId),
  /** Long-press says "Made by <project>" for `agent`, "Added by you" for `person`. */
  addedBy: LinkAuthor,
  /** An agent's link only: what they changed on it themselves, which stays theirs. */
  theirs: Schema.optionalKey(Schema.Array(LinkPart)),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  /** When they first opened it from Home. An agent's link shows a dot before its label until then. */
  openedAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** In `dream link list` only: they removed this agent's link, and it stays off Home. */
  removedAt: Schema.optionalKey(Schema.DateTimeUtc)
})
export type AppLink = typeof AppLink.Type

/** How many links one project's agent can have on Home at once. About five tiles fit before the row scrolls. */
export const AgentLinksPerProject = 3

/** The host a link goes to, as the long-press header shows it. */
export const linkHost = (url: string): string => {
  const parts = urlParts.exec(url)
  return parts === null ? url : `${(parts[1] ?? "").toLowerCase()}${parts[2] ?? ""}`
}

/** The path, query and fragment of a link's URL ("/" when it has none). */
export const linkPath = (url: string): string => {
  const parts = urlParts.exec(url)
  const rest = parts?.[3] ?? "/"
  return rest.startsWith("/") ? rest : `/${rest}`
}

/** The long-press header: who made it, then where it goes. */
export const linkMenuHeader = (
  link: Pick<AppLink, "addedBy" | "url">,
  projectTitle: string | undefined
): { readonly title: string; readonly host: string } => ({
  title: link.addedBy === "agent" && projectTitle !== undefined ? `Made by ${projectTitle}` : "Added by you",
  host: linkHost(link.url)
})

const colorWords: Record<LinkColor, string> = {
  red: "red",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  teal: "teal",
  blue: "blue",
  purple: "purple",
  pink: "pink",
  graphite: "dark grey",
  light: "off-white"
}

/** The tile in words, e.g. "a dumbbell on a purple tile", for the agent's echo and its events. */
export const describeLinkTile = (link: Pick<AppLink, "icon" | "color" | "title">): string => {
  const word = colorWords[link.color]
  const on = `on ${/^[aeiou]/.test(word) ? "an" : "a"} ${word} tile`
  if (link.icon === undefined) return `the letter ${[...link.title][0]?.toUpperCase() ?? "?"} ${on}`
  return LinkIcon.match(link.icon, {
    Symbol: ({ name }) => `the SF Symbol ${name} ${on}`,
    Emoji: ({ emoji }) => `${emoji} ${on}`,
    Image: () => "your image, filling the tile"
  })
}
