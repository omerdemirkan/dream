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
