/**
 * How a question's option previews (`QuestionMessage.previews`) are laid out: the thumbnails on its card, and each
 * piece of media in the full-screen viewer, at the media's own shape (a phone's screenshot, a desktop page, a
 * recording) or as a player for audio. Pure, so it's tested in Node.
 */
import type { MediaRef, QuestionMessage } from "@dream/domain"

/** One option as the card and the viewer show it: its letter, its words, and what it looks or sounds like. */
export interface OptionTile {
  readonly index: number
  readonly letter: string
  readonly option: string
  readonly media: ReadonlyArray<MediaRef>
}

/** Whether the card shows the question's options as previews. */
export const hasPreviews = (message: QuestionMessage): boolean =>
  (message.previews ?? []).some((preview) => preview.media.length > 0)

/** "A", "B", … "Z", then "27", for an option's place. */
export const letterFor = (index: number): string => (index < 26 ? String.fromCharCode(65 + index) : String(index + 1))

/** Every option, with its previews if it has any, in the question's order. */
export const optionTiles = (message: QuestionMessage): ReadonlyArray<OptionTile> =>
  message.options.map((option, index) => ({
    index,
    letter: letterFor(index),
    option,
    media: message.previews?.find((preview) => preview.option === option)?.media ?? []
  }))

/** A phone screenshot's shape, for media whose size isn't known yet. */
export const phoneAspect = 390 / 844

/** Width over height: from the media, else what the phone measured on load, else a phone's. */
export const aspectOf = (media: MediaRef, measured?: number): number =>
  media.width !== undefined && media.height !== undefined && media.height > 0
    ? media.width / media.height
    : (measured ?? phoneAspect)

/** Taller than wide by enough to read as a phone screen. */
const portrait = (aspect: number) => aspect < 0.85

export interface ThumbSize {
  readonly width: number
  readonly height: number
}

/**
 * The card's thumbnails. Up to three phone-shaped options share the card's width in a row, like the mock; anything
 * else (a desktop page, audio, a fourth option) is a strip that scrolls sideways at one height, each at its own shape.
 */
export const thumbLayout = (
  tiles: ReadonlyArray<OptionTile>,
  inner: number,
  aspects: ReadonlyArray<number | "audio" | "none">,
  gap = 10
): { readonly mode: "row" | "strip"; readonly sizes: ReadonlyArray<ThumbSize> } => {
  const row = tiles.length <= 3 && aspects.every((aspect) => typeof aspect !== "number" || portrait(aspect))
  if (row) {
    const width = Math.floor((inner - gap * (tiles.length - 1)) / tiles.length)
    const screens = aspects.filter((aspect): aspect is number => typeof aspect === "number")
    // Sounds and words alone sit in a short row; with a screen among them, the row is as tall as the screens.
    const height =
      screens.length === 0
        ? 104
        : Math.round(Math.min(Math.max(Math.max(...screens.map((aspect) => width / aspect)), width * 1.3), 240))
    return { mode: "row", sizes: tiles.map(() => ({ width, height })) }
  }
  const visual = aspects.some((aspect) => typeof aspect === "number")
  const height = visual ? 150 : 104
  return {
    mode: "strip",
    sizes: aspects.map((aspect) => ({
      height,
      width: Math.round(
        aspect === "audio"
          ? Math.max(height, 132)
          : aspect === "none"
            ? 132
            : Math.min(Math.max(height * aspect, 96), inner * 0.82)
      )
    }))
  }
}

/** Media fitted inside a box, whole (contain), at its own shape. */
export const fit = (aspect: number, box: ThumbSize): ThumbSize => {
  const width = Math.min(box.width, box.height * aspect)
  return { width: Math.round(width), height: Math.round(width / aspect) }
}

/** "0:07", "1:05". */
export const clock = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** What a tile says it holds, for VoiceOver and as the strip's small print: "2 screens, a recording". */
export const contentsOf = (media: ReadonlyArray<MediaRef>): string => {
  const count = (kind: MediaRef["kind"]) => media.filter((m) => m.kind === kind).length
  const parts = [
    [count("image"), "screen", "screens"],
    [count("video"), "recording", "recordings"],
    [count("audio"), "sound", "sounds"]
  ] as const
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => (n === 1 ? `a ${one}` : `${n} ${many}`))
    .join(", ")
}
