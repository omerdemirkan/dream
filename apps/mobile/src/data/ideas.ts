/**
 * Starters for a blank New idea page (Deck v3 inspiration, option A): a
 * curated list of things an agent can build and keep running, each a one-line
 * starter and an editable draft. A draft marks its guesses (⟦Lisbon⟧, ⟦£120⟧):
 * the page tints them until they're edited and selects the first, so typing
 * replaces it. The list ships with the app, so over-the-air updates change it.
 *
 * The order of `ideas` is the founder's priority (set with mocks/ideas-editor,
 * whose "Dream starters update" messages are applied here). What someone has
 * connected only breaks ties within it (`rankIdeas`).
 */
import type { Integration } from "@dream/domain"
import type { Selection } from "./draft.ts"

/** How More groups the starters. */
export type IdeaGroup = "schedule" | "phone" | "inbox" | "bots"

export const ideaGroups: ReadonlyArray<{ readonly id: IdeaGroup; readonly label: string }> = [
  { id: "schedule", label: "On a schedule" },
  { id: "phone", label: "On your phone" },
  { id: "inbox", label: "Gmail and Calendar" },
  { id: "bots", label: "Bots" }
]

/** What an idea uses that the person may already have connected. */
export type IdeaNeed = "gmail" | "calendar" | "sheets" | "spotify" | "slack"

export interface Idea {
  readonly id: string
  /** Names the draft on the chip by Send. */
  readonly title: string
  /** An SF Symbol. */
  readonly symbol: string
  readonly group: IdeaGroup
  /** The starter as listed: one line, in their voice. */
  readonly line: string
  /** The draft the page gets, with each guess in ⟦…⟧. */
  readonly draft: string
  readonly needs: ReadonlyArray<IdeaNeed>
  /** Words that, in a project's title, mean they've built this already. */
  readonly near: ReadonlyArray<string>
}

export const ideas: ReadonlyArray<Idea> = [
  {
    id: "evening-inbox",
    title: "Evening inbox",
    symbol: "envelope",
    group: "inbox",
    line: "Every evening, tell me the three emails I actually need to answer.",
    draft:
      "Every evening around ⟦9⟧, go through my Gmail and tell me the ⟦three⟧ emails I actually need to answer, and why each one matters. Skip newsletters, receipts and anything automated. If nothing needs me, say so in one line.\n\nSend it as ⟦a notification⟧ I can tap to see the emails.",
    needs: ["gmail"],
    near: ["inbox", "triage"]
  },
  {
    id: "anki-walk",
    title: "Anki on a walk",
    symbol: "waveform",
    group: "phone",
    line: "A voice tutor that quizzes me on my Anki decks while I walk.",
    draft:
      "A voice tutor for my ⟦Spanish⟧ Anki deck that I can use with headphones in, on a walk. It reads a card, I answer out loud, and it tells me if I got it. Cards I miss come back sooner.\n\nIt should sync with Anki so my phone app stays right. Sessions of about ⟦15 minutes⟧.",
    needs: [],
    near: ["anki", "flashcard", "tutor", "vocab"]
  },
  {
    id: "before-meetings",
    title: "Before each meeting",
    symbol: "calendar",
    group: "inbox",
    line: "Ten minutes before a meeting, tell me who it’s with and what we last emailed about.",
    draft:
      "⟦Ten minutes⟧ before each meeting on my Calendar, send me who it’s with, what we last emailed about, and one thing worth asking. Only for meetings with people ⟦outside my company⟧.\n\nKeep it short enough to read in the lift.",
    needs: ["calendar", "gmail"],
    near: ["meeting", "briefing"]
  },
  {
    id: "fare-watch",
    title: "Fare watch",
    symbol: "airplane",
    group: "schedule",
    line: "Check flights to Lisbon each morning and tell me when one drops under £120.",
    draft:
      "Check return flights from ⟦London⟧ to ⟦Lisbon⟧ every morning, for any weekend in ⟦May⟧. Tell me when one drops under ⟦£120⟧, with the link to book it. Otherwise don’t message me.",
    needs: [],
    near: ["flight", "fare", "airfare"]
  },
  {
    id: "receipts",
    title: "Receipts to a sheet",
    symbol: "tablecells",
    group: "inbox",
    line: "Pull the receipts from my Gmail into a monthly spending sheet, by category.",
    draft:
      "Once a month, go through my Gmail and pull every receipt into a spending sheet, by category: ⟦food, travel, subscriptions⟧. Flag subscriptions I haven’t used in a while.\n\nPut it in ⟦a Google Sheet⟧ and send me the total.",
    needs: ["gmail", "sheets"],
    near: ["receipt", "spending", "budget", "expense"]
  },
  {
    id: "run-club-bot",
    title: "Running club bot",
    symbol: "figure.run",
    group: "bots",
    line: "A Telegram bot that posts Saturday’s route and keeps track of who’s coming.",
    draft:
      "A ⟦Telegram⟧ bot for our running club. Every ⟦Thursday⟧ it posts Saturday’s route with a map, and people tap to say they’re coming. On Friday night it reminds whoever said yes.\n\nI pick the routes from ⟦a list I keep⟧.",
    needs: [],
    near: ["club", "running", "route"]
  },
  {
    id: "chore-chart",
    title: "Chore chart",
    symbol: "star",
    group: "phone",
    line: "A chore chart for the kids on our iPad, with stars that add up to pocket money.",
    draft:
      "A chore chart app for our iPad, for ⟦two kids, 6 and 9⟧. Each chore earns stars, and stars add up to pocket money at ⟦10p each⟧. They tick things off themselves, and I approve at the end of the week.",
    needs: [],
    near: ["chore", "pocket"]
  },
  {
    id: "friday-playlist",
    title: "Friday playlist",
    symbol: "music.note",
    group: "schedule",
    line: "Every Friday, a playlist of new songs from artists I actually replay.",
    draft:
      "Every Friday, make me a Spotify playlist of new releases from artists I actually replay, not ones I listened to once. About ⟦25 songs⟧. Leave out ⟦remixes and live versions⟧.",
    needs: ["spotify"],
    near: ["playlist", "spotify", "music"]
  },
  {
    id: "sunday-listen",
    title: "Sunday listen",
    symbol: "headphones",
    group: "schedule",
    line: "Share articles to it all week, and on Sunday it reads me the ones I didn’t get to.",
    draft:
      "I share articles to it from my phone during the week. On ⟦Sunday morning⟧ it turns the ones I didn’t read into a private podcast I can play in ⟦Overcast⟧, about ⟦30 minutes⟧ long.",
    needs: [],
    near: ["article", "podcast", "reading"]
  },
  {
    id: "bin-night",
    title: "Bin night",
    symbol: "trash",
    group: "schedule",
    line: "Text me the night before bin day, and which bin it is.",
    draft:
      "The night before bin day, text me which bin goes out. Use ⟦Oxford⟧ council’s collection calendar for ⟦my postcode⟧, and handle bank holidays.",
    needs: [],
    near: ["bin", "rubbish", "recycling"]
  },
  {
    id: "family-car",
    title: "Family car",
    symbol: "car",
    group: "phone",
    line: "A shared calendar for the family car, so everyone sees who has it which day.",
    draft:
      "A simple app for our ⟦family⟧ car. Anyone can claim a day, everyone sees the week at a glance, and two people can’t take the same ⟦Saturday⟧. It should work for ⟦four⟧ of us, on any phone.",
    needs: [],
    near: ["car"]
  },
  {
    id: "newsletter-digest",
    title: "Newsletter digest",
    symbol: "newspaper",
    group: "inbox",
    line: "Read my newsletters overnight and send me a five-minute digest at 7.",
    draft:
      "Read the newsletters that land in my Gmail overnight and send me one digest at ⟦7⟧, short enough to read in ⟦five minutes⟧. Group it by topic, link each story, and skip anything ⟦promotional⟧.",
    needs: ["gmail"],
    near: ["newsletter", "digest", "brief"]
  },
  {
    id: "lift-log",
    title: "Strength log",
    symbol: "dumbbell",
    group: "phone",
    line: "A strength log that reads Apple Health and tells me when to add weight.",
    draft:
      "An iPhone app to log my ⟦squat, bench and deadlift⟧. It reads my workouts from Apple Health, shows how each lift is going, and tells me when it’s time to add ⟦2.5 kg⟧.",
    needs: [],
    near: ["lift", "gym", "workout", "strength"]
  },
  {
    id: "dinner-plan",
    title: "Week of dinners",
    symbol: "fork.knife",
    group: "schedule",
    line: "Every Sunday, plan five dinners we’ll actually eat and send one shopping list.",
    draft:
      "Every ⟦Sunday⟧, plan ⟦five⟧ dinners for the week from the things we like, nothing over ⟦40 minutes⟧. Send me one shopping list, sorted by aisle. Remember what we said no to.",
    needs: [],
    near: ["dinner", "meal", "grocery", "shopping"]
  },
  {
    id: "standup-bot",
    title: "Standup bot",
    symbol: "bubble.left.and.bubble.right",
    group: "bots",
    line: "A Slack bot that asks the team what they’re on each morning and posts one summary.",
    draft:
      "A Slack bot for my team of ⟦six⟧. At ⟦9:30⟧ it asks each person what they’re working on and what’s blocking them, then posts one short summary in ⟦#team⟧. It skips people who are on holiday.",
    needs: ["slack"],
    near: ["standup", "slack"]
  },
  {
    id: "wishlist-sales",
    title: "Wishlist sales",
    symbol: "tag",
    group: "schedule",
    line: "Watch the things on my wishlist and tell me when one goes on sale.",
    draft:
      "I keep a wishlist of ⟦about ten⟧ things from different shops. Check their prices ⟦every morning⟧ and tell me when one drops by more than ⟦15%⟧, with the link. Adding one should be as easy as sharing the page.",
    needs: [],
    near: ["wishlist", "price", "sale"]
  },
  {
    id: "parcels",
    title: "Today’s parcels",
    symbol: "shippingbox",
    group: "inbox",
    line: "Find the tracking numbers in my Gmail and tell me what arrives today.",
    draft:
      "Find the tracking numbers in my Gmail and keep track of every parcel. Each morning at ⟦8⟧, tell me what arrives today and roughly when. If something is stuck for more than ⟦three days⟧, say so.",
    needs: ["gmail"],
    near: ["parcel", "delivery", "package", "tracking"]
  },
  {
    id: "birthdays",
    title: "Birthdays",
    symbol: "gift",
    group: "inbox",
    line: "A week before each birthday on my Calendar, suggest a gift and remind me again the day before.",
    draft:
      "A ⟦week⟧ before each birthday on my Calendar, suggest a gift for ⟦under £40⟧ based on what I know about them, and remind me again the day before. Keep notes on who liked what.",
    needs: ["calendar"],
    near: ["birthday", "gift"]
  },
  {
    id: "plants",
    title: "Plant watering",
    symbol: "leaf",
    group: "phone",
    line: "Remind me to water each plant, based on the weather and when I last did it.",
    draft:
      "I have ⟦eight⟧ plants, ⟦some on the balcony⟧. Remind me when each one needs water, based on the weather and when I last watered it. Tapping the reminder should mark it done.",
    needs: [],
    near: ["plant", "garden", "water"]
  },
  {
    id: "remind-bot",
    title: "Remind-me bot",
    symbol: "bell",
    group: "bots",
    line: "A Telegram bot I can text “remind me…” in plain words, that actually reminds me.",
    draft:
      "A ⟦Telegram⟧ bot I can message things like “remind me to call Mum on Sunday afternoon” and it works out when. It reminds me then, and lets me snooze with ⟦one tap⟧.",
    needs: [],
    near: ["remind", "reminder"]
  },
  {
    id: "commute",
    title: "Morning train",
    symbol: "tram",
    group: "schedule",
    line: "Every weekday at 8, tell me if my train is late and which one to take instead.",
    draft:
      "Every weekday at ⟦8⟧, check my train from ⟦Oxford⟧ to ⟦London Paddington⟧. If it’s late or cancelled, tell me the best one to take instead. If it’s fine, don’t message me.",
    needs: [],
    near: ["train", "commute"]
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
// Which starters, in what order
// ---------------------------------------------------------------------------

/** What their connected integrations let an idea use without asking. */
export const connectedNeeds = (integrations: ReadonlyArray<Integration>): ReadonlySet<IdeaNeed> => {
  const needs = new Set<IdeaNeed>()
  for (const integration of integrations) {
    if (integration.status !== "connected") continue
    const access = integration.access
    if (access._tag === "Google") {
      for (const scope of access.scopes) {
        if (scope.startsWith("gmail")) needs.add("gmail")
        if (scope.startsWith("calendar")) needs.add("calendar")
        if (scope.startsWith("spreadsheets") || scope.startsWith("drive")) needs.add("sheets")
      }
    } else if (access._tag === "OAuth") {
      const provider = access.provider.toLowerCase()
      if (provider === "spotify" || provider === "slack") needs.add(provider)
    }
  }
  return needs
}

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

/** How many ideas count as one step of priority, inside which what they've connected breaks the tie. */
export const priorityBand = 4

/**
 * The starters for this person: the list's order (the founder's priority),
 * ideas too close to one of their projects dropped. Within each band of four,
 * ideas whose needs they've connected come first (all of them, then some), as a
 * tiebreak that never lifts an idea past a higher band.
 */
export const rankIdeas = (
  list: ReadonlyArray<Idea>,
  context: { readonly connected: ReadonlySet<IdeaNeed>; readonly projectTitles: ReadonlyArray<string> }
): ReadonlyArray<Idea> => {
  const tier = (idea: Idea) => {
    const have = idea.needs.filter((n) => context.connected.has(n)).length
    return have === 0 ? 2 : have === idea.needs.length ? 0 : 1
  }
  return list
    .filter((idea) => !nearProject(idea, context.projectTitles))
    .map((idea, i) => ({ idea, i, band: Math.floor(i / priorityBand), tier: tier(idea) }))
    .sort((a, b) => a.band - b.band || a.tier - b.tier || a.i - b.i)
    .map((x) => x.idea)
}

/** A small seeded generator, so a page keeps its four while it's open and tests can pin them. */
const random = (seed: number) => {
  let s = Math.floor(seed * 2 ** 31) >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 2 ** 32
  }
}

/**
 * The four under the placeholder, in ranked order: always the top two, and two
 * more drawn from the next six, so the page shows a slightly different mix each
 * time without leaving the founder's top eight.
 */
export const pickStarters = (ranked: ReadonlyArray<Idea>, seed: number, count = 4): ReadonlyArray<Idea> => {
  const fixed = Math.min(2, count)
  const next = random(seed)
  const drawn = ranked
    .slice(fixed, fixed + 6)
    .map((idea) => ({ idea, k: next() }))
    .sort((a, b) => a.k - b.k)
    .slice(0, count - fixed)
    .map((x) => x.idea)
  return ranked.filter((idea, i) => i < fixed || drawn.includes(idea))
}
