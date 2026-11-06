/**
 * Starters for a blank New idea page: a few things an agent can build and keep
 * running, each a short line on a card and a draft that fills the page. A draft
 * reads as something they could send as it is; it leaves out specifics only
 * they can choose, which the agent asks about when it looks into the idea.
 *
 * Each line is short (about 40 characters) so it reads in a glance on a card in
 * the row above the buttons: 132 pt of text at 14 pt, two lines for most, three
 * at most.
 *
 * The order is the founder's (set with mocks/ideas-editor, whose "Dream
 * starters update" messages are applied here), and every one shows. The list
 * ships with the app, so over-the-air updates change it.
 */
export interface Idea {
  readonly id: string
  /** An SF Symbol. */
  readonly symbol: string
  /** The starter as listed: one short line, in their voice. */
  readonly line: string
  /** What the page gets. */
  readonly draft: string
}

export const ideas: ReadonlyArray<Idea> = [
  {
    id: "my-podcast",
    symbol: "headphones",
    line: "A daily podcast on the topics I follow",
    draft:
      "A private podcast made for me, about the topics I follow. Every morning, a new episode on what’s new, short enough for my commute, without repeating stories from earlier episodes. Publish it to a private feed I can add to my podcast app, with the sources in the show notes."
  },
  {
    id: "memory-tutor",
    symbol: "brain.head.profile",
    line: "Quiz me out loud on what I memorize",
    draft:
      "A voice tutor for the things I have to memorize. It turns my notes and flashcards into questions, quizzes me out loud while I walk or drive, and checks my answers. What I miss comes back sooner, and before an exam it tells me which topics are slipping."
  },
  {
    id: "points-trips",
    symbol: "creditcard",
    line: "Find trips worth my credit card points",
    draft:
      "Watch my credit card points and the deals that make them go further, like transfer bonuses, card promotions and award sales on flights and hotels. When something adds up to an exceptionally good trip somewhere interesting, send me an itinerary with the points and cash it takes and how to book it. Otherwise, stay quiet."
  },
  {
    id: "run-club-bot",
    symbol: "figure.run",
    line: "A bot for our running club’s group chat",
    draft:
      "A bot for our running club’s group chat. Each week it suggests a few interesting routes and lets the group vote. Once a route wins, it asks who’s coming and keeps the attendance list, and the night before it nudges everyone who said yes and anyone who hasn’t answered. It should live in the chat we already use if it can, or the closest thing that works."
  },
  {
    id: "dinner-plan",
    symbol: "fork.knife",
    line: "Plan our week of dinners and groceries",
    draft:
      "Every week, plan our dinners from the things we like, quick enough for a weeknight, and send me the plan with one shopping list sorted by aisle. I’ll tell you what worked and what didn’t, and the next plan should take that into account."
  }
]

/** The page after picking a starter: its draft, with a space after it so typing carries straight on. */
export const draftOf = (idea: Idea): string => `${idea.draft} `
