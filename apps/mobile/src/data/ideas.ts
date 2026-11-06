/**
 * Starters for a blank New idea page (Deck v3 inspiration, option A): a few
 * ideas an agent can build and keep running, each a one-line starter and an
 * editable draft. Each should fit a kind of person nearly as written, so the
 * guesses are the only thing they'd change. A draft marks its guesses
 * (⟦Saturday⟧, ⟦20 minutes⟧): the page tints them until they're edited and
 * selects the first, so typing replaces it. The list ships with the app, so
 * over-the-air updates change it.
 *
 * The order is the founder's priority (set with mocks/ideas-editor, whose
 * "Dream starters update" messages are applied here), and every one shows.
 */
import type { Selection } from "./draft.ts"

export interface Idea {
  readonly id: string
  /** Names the draft on the chip by Send. */
  readonly title: string
  /** An SF Symbol. */
  readonly symbol: string
  /** The starter as listed: one line, in their voice. */
  readonly line: string
  /** The draft the page gets, with each guess in ⟦…⟧. */
  readonly draft: string
  /** Words that, in a project's title, mean they've built this already. */
  readonly near: ReadonlyArray<string>
}

export const ideas: ReadonlyArray<Idea> = [
  {
    id: "memory-tutor",
    title: "Study by voice",
    symbol: "brain.head.profile",
    line: "A voice tutor that quizzes me on everything I have to memorize, so I can study on a walk.",
    draft:
      "A voice tutor for everything I have to memorize for ⟦PA school⟧. It turns ⟦my lecture notes and Anki decks⟧ into cards, quizzes me out loud while I walk or drive, and checks what I say back. Cards I miss come back sooner, and before ⟦each exam⟧ it tells me which topics are slipping.\n\nSessions of about ⟦20 minutes⟧, with headphones in.",
    near: ["tutor", "flashcard", "anki", "quiz", "study"]
  },
  {
    id: "points-trips",
    title: "Trips from points",
    symbol: "creditcard",
    line: "Watch my credit card points and travel deals, and send me a trip when one is exceptional.",
    draft:
      "I have ⟦80,000 Chase Ultimate Rewards points⟧. Watch transfer bonuses, card promotions and award sales on flights and hotels. When something adds up to an exceptionally good trip from ⟦my home airport⟧ to somewhere interesting, send me an itinerary with the points and cash it takes and how to book it.\n\nTrips of ⟦4 to 10 days⟧, and no more than ⟦one message a week⟧.",
    near: ["point", "reward", "award", "trip", "travel"]
  },
  {
    id: "run-club-bot",
    title: "Running club",
    symbol: "figure.run",
    line: "A bot for our running club’s group chat that picks routes by vote, tracks who’s coming and nudges people.",
    draft:
      "A bot for our running club’s group chat. Every ⟦Wednesday⟧ it suggests ⟦three⟧ interesting routes near ⟦our usual meeting spot⟧ for ⟦Saturday⟧ and runs a vote. Once a route wins, it asks who’s coming and keeps the attendance list. The night before, it nudges everyone who said yes and anyone who hasn’t answered.\n\nWe use ⟦WhatsApp⟧ now, but I’m open to whatever works best for a group.",
    near: ["club", "running", "route"]
  },
  {
    id: "dinner-plan",
    title: "Week of dinners",
    symbol: "fork.knife",
    line: "Every Sunday, plan the week’s dinners we’ll actually eat and send one shopping list.",
    draft:
      "Every ⟦Sunday morning⟧, plan ⟦five⟧ dinners for ⟦two adults and two kids⟧, each under ⟦40 minutes⟧, from the things we like. Send me the plan and one shopping list sorted by aisle. I’ll tell you what worked and what didn’t, and the next week’s plan should take that into account.",
    near: ["dinner", "meal", "grocery", "shopping"]
  }
]

// ---------------------------------------------------------------------------
// Drafts and their guesses
// ---------------------------------------------------------------------------

/** A draft as the page holds it: plain text, and where its guesses are. */
export interface Draft {
  readonly text: string
  readonly guesses: ReadonlyArray<Selection>
}

/** "Fly to ⟦Lisbon⟧" → the text without the brackets, and the guess at "Lisbon". */
export const parseDraft = (marked: string): Draft => {
  const guesses: Array<Selection> = []
  let text = ""
  let rest = marked
  for (;;) {
    const open = rest.indexOf("⟦")
    const close = open < 0 ? -1 : rest.indexOf("⟧", open)
    if (open < 0 || close < 0) break
    text += rest.slice(0, open)
    const guess = rest.slice(open + 1, close)
    guesses.push({ start: text.length, end: text.length + guess.length })
    text += guess
    rest = rest.slice(close + 1)
  }
  return { text: text + rest, guesses }
}

/**
 * The guesses after an edit. The edit is found by comparing the texts; a guess
 * it touched has been typed over (or into) and stops being a guess, and those
 * after it move with the text.
 */
export const shiftGuesses = (
  guesses: ReadonlyArray<Selection>,
  before: string,
  after: string
): ReadonlyArray<Selection> => {
  if (guesses.length === 0 || before === after) return guesses
  const shortest = Math.min(before.length, after.length)
  let prefix = 0
  while (prefix < shortest && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < shortest - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  const editEnd = before.length - suffix
  const delta = after.length - before.length
  return guesses.flatMap((g) =>
    g.end <= prefix ? [g] : g.start >= editEnd ? [{ start: g.start + delta, end: g.end + delta }] : []
  )
}

/** The text cut into plain runs and guesses, in order, for drawing. */
export const draftRuns = (text: string, guesses: ReadonlyArray<Selection>) => {
  const runs: Array<{ readonly text: string; readonly guess: boolean }> = []
  let at = 0
  for (const g of [...guesses].sort((a, b) => a.start - b.start)) {
    if (g.start < at || g.end > text.length || g.end <= g.start) continue
    if (g.start > at) runs.push({ text: text.slice(at, g.start), guess: false })
    runs.push({ text: text.slice(g.start, g.end), guess: true })
    at = g.end
  }
  if (at < text.length) runs.push({ text: text.slice(at), guess: false })
  return runs
}

// ---------------------------------------------------------------------------
// Which starters
// ---------------------------------------------------------------------------

/** Lowercase words, with a plural "s" dropped, so "Receipts" meets "receipt". */
const words = (text: string) =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))

/** Whether one of their projects is already this idea: its title names what the idea is about. */
export const nearProject = (idea: Idea, projectTitles: ReadonlyArray<string>): boolean => {
  const near = new Set([...idea.near.flatMap(words), words(idea.title).join(" ")])
  return projectTitles.some((title) => {
    const ws = words(title)
    return ws.some((w) => near.has(w)) || near.has(ws.join(" "))
  })
}

/** The starters for this person: the founder's order, without ideas one of their projects already is. */
export const startersFor = (list: ReadonlyArray<Idea>, projectTitles: ReadonlyArray<string>): ReadonlyArray<Idea> =>
  list.filter((idea) => !nearProject(idea, projectTitles))
