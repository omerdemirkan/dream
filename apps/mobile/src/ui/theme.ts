/**
 * Deck v3 design tokens (mocks/deck-v3.html, `.scr`). Dark; amber only for
 * what needs the person.
 */
export const color = {
  bg: "#0A0A0C",
  s1: "#141417",
  s2: "#1D1D21",
  s3: "#28282D",
  line: "rgba(255,255,255,0.08)",
  line2: "rgba(255,255,255,0.15)",
  t1: "#F5F5F7",
  t2: "rgba(245,245,247,0.64)",
  t3: "rgba(245,245,247,0.40)",
  need: "#FFB35C",
  needInk: "#1B1204",
  needBg: "rgba(255,179,92,0.12)",
  needLine: "rgba(255,179,92,0.34)",
  cool: "#8FB8FF",
  toast: "#2C2C31",
  sheet: "#1B1B1F",
  black: "#000000",
  white: "#FFFFFF"
} as const

/** The amber glow at the top of cards that need them (`radial-gradient(130% 55% at 50% 0%, …)`). */
export const needGlow = "radial-gradient(130% 55% at 50% 0%, rgba(255,179,92,0.10), transparent 62%)"

/** Horizontal page padding. */
export const gutter = 20

/** Letter spacing in the mock is in em; React Native wants points. */
export const tracking = (em: number, size: number) => em * size

/**
 * App link tiles (`LinkColor`): a soft top-to-bottom gradient each, chosen to sit next to real app icons, and the
 * glyph's ink on it. The gateway's manifest uses `from` as the app's colour.
 */
export const linkTile = {
  red: { from: "#FF7A6B", to: "#E0392C", ink: "#FFFFFF" },
  orange: { from: "#FFC680", to: "#F0814A", ink: "#FFFFFF" },
  yellow: { from: "#FFE07A", to: "#F5B730", ink: "#2A1F05" },
  green: { from: "#4F8E66", to: "#28553A", ink: "#F6F0E2" },
  teal: { from: "#5BD6C9", to: "#1F9893", ink: "#FFFFFF" },
  blue: { from: "#62AEFF", to: "#2C68E6", ink: "#FFFFFF" },
  purple: { from: "#8E5CF7", to: "#EE8C6E", ink: "#FFFFFF" },
  pink: { from: "#FF93C6", to: "#E2508D", ink: "#FFFFFF" },
  graphite: { from: "#55555D", to: "#2B2B31", ink: "#F5F5F7" },
  light: { from: "#F6F4EE", to: "#E7E3D9", ink: "#1C1C1E" }
} as const
