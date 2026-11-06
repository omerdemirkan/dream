/**
 * The Deck v3 sample world (mocks/BRIEF.md) as domain values: the four
 * projects, their Status cards and Chats, a connected ChatGPT plan and Gmail.
 * Builds on `@dream/domain/fixtures` and fills in what the mock shows beyond it.
 *
 * Every timestamp is shifted by whole days so the mock's "now" (Wednesday
 * 2:12 PM in Los Angeles) lands within the last day: "Today", "day 3" and
 * "7:00 AM" read as in the mock, in that time zone, whenever the app runs.
 */
import type {
  AccessMessage,
  Integration,
  IntegrationId,
  LiveActivityAttributes,
  LiveActivityContent,
  MediaId,
  MediaRef,
  Message,
  MessageId,
  ModelConnection,
  ModelConnectionId,
  NotificationId,
  Project,
  QuestionMessage,
  StatusCard,
  TextMessage
} from "@dream/domain"
import * as Fx from "@dream/domain/fixtures"
import { DateTime } from "effect"

/** The mock's "now": Wednesday, November 4, 2:12 PM in Los Angeles. */
export const mockNow = DateTime.makeUnsafe("2026-11-04T22:12:00Z")

/** A long brain dump for the New idea page (`/new?sample=long`), from the mock's option A. */
export const longIdea = [
  "Okay so, recipes. I cook a lot, from websites and from my mom’s old index cards, and whenever I’m cooking for a different number of people I end up doing math on the back of an envelope and getting it wrong.",
  "What I want: paste a link or snap a photo of a card, say how many people, and it rewrites the whole recipe. Not just multiplied. Eggs don’t come in halves, a pinch stays a pinch, and a bigger pan changes the baking time.",
  "My sister would use it too. She cooks for eight most weekends, and she’s in Berlin, so grams. I’m cups. It should flip between them without making either of us think.",
  "Maybe it remembers the ones we make a lot? A shopping list would be nice, but that’s later, don’t get distracted by it.",
  "What bugs me about the apps that exist: they’re full of ads, and they scale everything in a straight line, which is how you end up with three tablespoons of salt."
].join("\n\n")

const at = (iso: string) => DateTime.makeUnsafe(iso)
const msg = (id: string) => id as MessageId
const med = (id: string) => id as MediaId

// ---------------------------------------------------------------------------
// Media (the bytes are bundled with the app; see ui/media.ts)
// ---------------------------------------------------------------------------

const image = (id: string, caption: string, width = 408, height = 720): MediaRef => ({
  id: med(id),
  kind: "image",
  contentType: "image/png",
  sizeBytes: 180_000,
  width,
  height,
  caption
})

export const media = {
  // The bundled recording is 408×720.
  healthImport: { ...Fx.healthImportRecording, width: 408, height: 720 },
  squatChart: image("med_squatchart", "Squat chart · draft"),
  today: image("med_todayview", "Today view"),
  calendarFirst: image("med_cabincal", "Calendar first", 600, 643),
  requestsFirst: image("med_cabinreq", "Requests first", 600, 643),
  rotation: image("med_cabinrot", "Rotation", 600, 643),
  digest: image("med_digest", "Today’s digest", 600, 652)
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const liftLog: Project = { ...Fx.liftLog, updatedAt: at("2026-11-04T22:09:00Z") }
const morningBrief: Project = { ...Fx.morningBrief, updatedAt: at("2026-11-04T15:02:00Z") }
const cabin: Project = {
  ...Fx.cabin,
  headline: "Three prototypes are ready for your reaction.",
  publishedPort: 3000,
  updatedAt: at("2026-11-04T19:30:00Z")
}
const recipeScaler: Project = {
  ...Fx.recipeScaler,
  headline: "One question for you",
  createdAt: at("2026-11-04T21:58:00Z"),
  updatedAt: at("2026-11-04T22:00:00Z")
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const text = (
  projectId: Project["id"],
  id: string,
  iso: string,
  from: "agent" | "user",
  body: string,
  attached: ReadonlyArray<MediaRef> = []
): TextMessage => ({
  _tag: "Text",
  id: msg(id),
  projectId,
  createdAt: at(iso),
  from,
  text: body,
  media: attached
})

const answered = (
  question: Omit<QuestionMessage, "state" | "_tag">,
  option: string,
  answeredIso: string
): QuestionMessage => ({
  _tag: "Question",
  ...question,
  state: { _tag: "Answered", answer: { _tag: "Choice", option }, answeredAt: at(answeredIso) }
})

const liftRead = answered(
  {
    id: msg("msg_liftread"),
    projectId: liftLog.id,
    createdAt: at("2026-10-13T16:20:00Z"),
    question:
      "Before I sketch anything: should Lift Log only read workouts from Apple Health, or also let you log sets by hand?",
    options: ["Only read them", "Read, plus manual logging"],
    why: "Reading only keeps it effortless; manual logging adds a whole input flow."
  },
  "Only read them",
  "2026-10-13T17:02:00Z"
)

const liftToday = answered(
  {
    id: msg("msg_lifttoday"),
    projectId: liftLog.id,
    createdAt: at("2026-10-14T19:00:00Z"),
    question: "Three rough directions for the Today screen are ready. Which one should I build from?",
    options: ["Big numbers", "Timeline", "Cards"]
  },
  "Big numbers",
  "2026-10-14T20:00:00Z"
)

const liftMessages: ReadonlyArray<Message> = [
  text(liftLog.id, "msg_liftidea", "2026-10-13T16:00:00Z", "user", liftLog.idea),
  liftRead,
  liftToday,
  text(liftLog.id, "msg_liftgo", "2026-11-02T17:00:00Z", "user", "Go for it. Make it properly good."),
  text(
    liftLog.id,
    "msg_liftstart",
    "2026-11-02T17:04:00Z",
    "agent",
    "Starting the real build. I’ll only write when I need something from you or have something worth seeing."
  ),
  Fx.appleAccess,
  {
    ...Fx.liftLogUpdate,
    text: "Apple Health import works in the simulator — 214 workouts from a sample export.",
    media: [media.healthImport]
  },
  text(
    liftLog.id,
    "msg_lift1rm",
    "2026-11-04T22:02:00Z",
    "user",
    "Can the charts show estimated 1RM, not just the weight?"
  ),
  text(
    liftLog.id,
    "msg_lift1rmreply",
    "2026-11-04T22:09:00Z",
    "agent",
    "Yes. I’ll plot **estimated 1RM** and mark the sessions where I’d have told you to add weight."
  )
]

/** The last-resort key card (`dream access file`): Telegram takes the bot token in its URLs, not a header. */
export const telegramKey: AccessMessage = {
  ...Fx.telegramKey,
  id: msg("msg_brieftelegram"),
  createdAt: at("2026-11-04T15:06:00Z"),
  notificationId: "2d4f6a8c-1b3e-4f5a-9c7d-0e1f2a3b4c5d" as NotificationId
}

const briefMessages: ReadonlyArray<Message> = [
  text(morningBrief.id, "msg_briefidea", "2026-10-20T17:50:00Z", "user", morningBrief.idea),
  Fx.gmailAccess,
  text(
    morningBrief.id,
    "msg_brieffirst",
    "2026-10-21T19:00:00Z",
    "agent",
    "Your first digest arrives tomorrow at 7:00."
  ),
  text(
    morningBrief.id,
    "msg_briefsent",
    "2026-11-04T15:00:00Z",
    "agent",
    "Sent today’s digest at 7:00 — 11 newsletters, 4 min read.",
    [media.digest]
  ),
  text(
    morningBrief.id,
    "msg_brieffix",
    "2026-11-04T15:02:00Z",
    "agent",
    "Substack changed its layout; an alert woke me at 6:12 and the parser was updated before 7. Nothing for you to do."
  ),
  telegramKey
]

export const cabinPick: QuestionMessage = {
  _tag: "Question",
  id: msg("msg_cabinpick"),
  projectId: cabin.id,
  createdAt: at("2026-11-04T19:21:00Z"),
  question: "Which of these three feels most like Cabin?",
  options: ["Calendar first", "Requests first", "Rotation"],
  why: "Quick throwaway sketches. React fast; nothing here is final.",
  meanwhile: "I’ll keep the booking data model flexible until you pick.",
  state: { _tag: "Open" },
  notificationId: "4e8c1f6a-2b3d-4c5e-9f70-81a2b3c4d5e6" as NotificationId
}

export const cabinRule: QuestionMessage = { ...Fx.cabinQuestion, createdAt: at("2026-11-04T19:20:00Z") }

export const calendarAccess: AccessMessage = {
  _tag: "Access",
  id: msg("msg_gcal"),
  projectId: cabin.id,
  createdAt: at("2026-11-04T19:30:00Z"),
  request: { _tag: "Google", scopes: ["calendar.events"] },
  why: "Connect Google Calendar so claimed weekends show up on everyone’s calendar.",
  state: { _tag: "Open" },
  notificationId: "9a7b6c5d-4e3f-4a1b-8c2d-3e4f5a6b7c8d" as NotificationId
}

/** A third open question for Cabin, after the calendar request (scenario `ask-series`). */
export const cabinHold = (projectId: Project["id"], now: DateTime.Utc): QuestionMessage => ({
  _tag: "Question",
  id: msg("msg_cabinhold"),
  projectId,
  createdAt: now,
  question: "How long can one family hold a weekend before confirming?",
  options: ["24 hours", "3 days", "A week"],
  why: "Holds that never turn into stays block everyone else.",
  state: { _tag: "Open" }
})

const cabinMessages: ReadonlyArray<Message> = [
  text(cabin.id, "msg_cabinidea", "2026-11-02T18:00:00Z", "user", cabin.idea),
  text(
    cabin.id,
    "msg_cabinprotos",
    "2026-11-04T19:20:00Z",
    "agent",
    "Three throwaway prototypes are ready. React to whichever feels closest; nothing here is final.",
    [media.calendarFirst, media.requestsFirst, media.rotation]
  ),
  cabinRule,
  cabinPick,
  calendarAccess
]

const recipeMessages: ReadonlyArray<Message> = [
  text(recipeScaler.id, "msg_recipeidea", "2026-11-04T21:58:00Z", "user", recipeScaler.idea),
  Fx.recipeQuestion
]

// ---------------------------------------------------------------------------
// Status cards
// ---------------------------------------------------------------------------

const liftStatus: StatusCard = {
  ...Fx.liftLogStatus,
  media: [media.healthImport, media.squatChart, media.today]
}

const briefStatus: StatusCard = {
  phase: "live",
  phaseSince: at("2026-10-22T15:00:00Z"),
  media: [media.digest],
  milestones: [
    {
      title: "Next run",
      state: "upcoming",
      date: at("2026-11-05T15:00:00Z"),
      needs: [{ what: "Your Telegram bot token", messageId: telegramKey.id }]
    },
    {
      title: "Sent today’s digest at 7:00",
      state: "done",
      date: at("2026-11-04T15:00:00Z"),
      detail: "11 newsletters, 4 min read.",
      needs: []
    },
    {
      title: "Fixed on its own",
      state: "done",
      date: at("2026-11-04T14:12:00Z"),
      detail: "Substack changed its layout; an alert woke me at 6:12 and the parser was updated before 7.",
      needs: []
    },
    { title: "Earlier this week", state: "done", detail: "3 digests, all on time", needs: [] }
  ],
  updatedAt: at("2026-11-04T15:02:00Z")
}

const cabinStatus: StatusCard = {
  phase: "exploring",
  phaseSince: at("2026-11-02T18:00:00Z"),
  now: "Three prototypes are ready for your reaction.",
  media: [media.calendarFirst, media.requestsFirst, media.rotation],
  milestones: [
    {
      title: "Prototypes",
      state: "current",
      needs: [
        { what: "Your pick of the three", messageId: cabinPick.id },
        { what: "A rule for double-booked weekends", messageId: cabinRule.id },
        { what: "Google Calendar", messageId: calendarAccess.id }
      ]
    },
    { title: "Calendar", state: "upcoming", needs: [] },
    { title: "Requests", state: "upcoming", needs: [] },
    { title: "On the web", state: "upcoming", needs: [] }
  ],
  updatedAt: at("2026-11-04T19:30:00Z")
}

const recipeStatus: StatusCard = {
  phase: "interviewing",
  phaseSince: at("2026-11-04T21:58:00Z"),
  media: [],
  milestones: [],
  updatedAt: at("2026-11-04T22:00:00Z")
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export interface FixtureProject {
  readonly project: Project
  readonly status: StatusCard
  readonly messages: ReadonlyArray<Message>
  readonly working: boolean
}

export interface FixtureWorld {
  readonly user: typeof Fx.user
  readonly projects: ReadonlyArray<FixtureProject>
  readonly integrations: ReadonlyArray<Integration>
  readonly modelConnections: ReadonlyArray<ModelConnection>
}

const chatgpt: ModelConnection = {
  id: "mcn_chatgpt" as ModelConnectionId,
  provider: "chatgpt",
  status: "connected",
  connectedAt: at("2026-10-01T17:10:00Z"),
  usage: Fx.usage
}

const world: FixtureWorld = {
  user: Fx.user,
  projects: [
    { project: liftLog, status: liftStatus, messages: liftMessages, working: true },
    { project: morningBrief, status: briefStatus, messages: briefMessages, working: false },
    { project: cabin, status: cabinStatus, messages: cabinMessages, working: false },
    { project: recipeScaler, status: recipeStatus, messages: recipeMessages, working: false }
  ],
  integrations: [Fx.google],
  modelConnections: [chatgpt]
}

/** Moves every `DateTime` in a value by `millis`. */
const shift = <A>(value: A, millis: number): A => {
  const visit = (v: unknown): unknown => {
    if (DateTime.isDateTime(v)) return DateTime.add(v, { milliseconds: millis })
    if (Array.isArray(v)) return v.map(visit)
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([key, inner]) => [key, visit(inner)]))
    }
    return v
  }
  // The visitor only rebuilds plain data and DateTimes, so the shape is preserved.
  return visit(value) as A
}

const day = 86_400_000

/**
 * The fixture world moved forward by whole days, so the mock's "now" falls on
 * today (or within the last day) and times of day read as in the mock.
 */
export const makeWorld = (now: DateTime.Utc): FixtureWorld =>
  shift(world, Math.floor((DateTime.toEpochMillis(now) - DateTime.toEpochMillis(mockNow)) / day) * day)

/** An integration id for something connected during a fixtures session. */
export const newIntegrationId = (n: number) => `int_fake${n}` as IntegrationId

/** Live Activities as the agent would start them with `dream live` (shown with dream://fixtures/live-activity). */
export const liveActivitySamples: Record<
  string,
  { readonly attributes: LiveActivityAttributes; readonly content: LiveActivityContent }
> = {
  "live-activity": {
    attributes: { projectId: liftLog.id, projectName: "Lift Log", icon: "dumbbell" },
    content: {
      title: "Building progress charts",
      detail: "Squat, bench and deadlift",
      next: "Rest timer",
      step: { current: 3, total: 5 },
      badge: "Day 3"
    }
  },
  "live-activity-needs": {
    attributes: { projectId: cabin.id, projectName: "Cabin", icon: "house" },
    content: {
      title: "Building the calendar",
      badge: "Needs you",
      needsYou: { prompt: "Who gets a weekend two relatives want?" }
    }
  }
}

// ---------------------------------------------------------------------------
// What agents actually send (scenarios `long-question`, `vague-access`, `question-context`)
// ---------------------------------------------------------------------------

/** A whole message sent as the question, markdown and all, the way an agent once did. */
export const longQuestion = (projectId: Project["id"], now: DateTime.Utc): QuestionMessage => ({
  _tag: "Question",
  id: msg("msg_voicelong"),
  projectId,
  createdAt: now,
  notificationId: "5e1d7c3a-8b2f-4a6e-9d0c-1f3b5a7c9e2d" as NotificationId,
  question: [
    "Got your email, thanks.",
    "On Codex: unfortunately no. Dream can’t connect a ChatGPT/Codex subscription, and even if it could, that sign-in only covers Codex’s coding models, not OpenAI’s live voice model. Live voice is billed only through an OpenAI API account.",
    "Two ways forward:\n• **OpenAI voice**, using the OpenAI card I already sent: natural voice that responds quickly and handles interruptions. Pay as you go, roughly a few cents a session.\n• **No key:** your phone does the listening and speaking with its built-in speech, so it sounds more robotic, and reviews count against your Claude limits.",
    "Which do you want?",
    "Your Codex/ChatGPT sign-in won’t be used for any of this."
  ].join("\n\n"),
  options: ["OpenAI voice", "No key"],
  why: "So the coach can talk you through your sets.",
  state: { _tag: "Open" }
})

/** A key request whose heading only made sense next to the command the agent typed, with where to get the key. */
export const vagueAccess = (projectId: Project["id"], now: DateTime.Utc): AccessMessage => ({
  _tag: "Access",
  id: msg("msg_openai"),
  projectId,
  createdAt: now,
  notificationId: "7a2c4e6f-9b1d-4c3e-8f5a-2b4d6f8a0c1e" as NotificationId,
  request: {
    _tag: "Key",
    service: "OpenAI",
    host: "api.openai.com",
    header: "Authorization",
    format: "Bearer {key}"
  },
  why: "Powers the voice coach that talks you through your sets",
  context:
    "Make one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys): tap **Create new secret key**, name it Lift Log, and copy it. OpenAI shows it only once.",
  state: { _tag: "Open" }
})

/** The same decision as `longQuestion`, asked as Dream means it: a short question, with what it takes to decide under it. */
export const questionWithContext = (projectId: Project["id"], now: DateTime.Utc): QuestionMessage => ({
  _tag: "Question",
  id: msg("msg_voice"),
  projectId,
  createdAt: now,
  notificationId: "9c3e5a7b-2d4f-4b6a-8e0c-3a5c7e9b1d2f" as NotificationId,
  question: "Which voice should the coach use?",
  options: ["OpenAI voice", "Your phone’s voice"],
  why: "Your ChatGPT sign-in can’t power live voice, so it’s one of these.",
  context: [
    "**OpenAI voice** sounds natural, answers quickly and copes when you talk over it. It needs the OpenAI key I asked for, and costs a few cents a session.",
    "**Your phone’s voice** is free and needs no key, but it sounds flatter, and each session counts against your Claude limits."
  ].join("\n\n"),
  meanwhile: "I’ll keep building the set tracker; only the coach depends on this.",
  state: { _tag: "Open" }
})
