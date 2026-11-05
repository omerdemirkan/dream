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
  )
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
    { title: "Next run", state: "upcoming", date: at("2026-11-05T15:00:00Z"), needs: [] },
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
