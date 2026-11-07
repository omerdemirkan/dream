/**
 * The Deck v3 sample content (mocks/BRIEF.md) as domain values, for tests and
 * for building UI before the API exists. Import from "@dream/domain/fixtures";
 * it is not part of the main entry point.
 */
import { DateTime } from "effect"
import type { AgentEvent } from "./AgentEvent.ts"
import type { AppNotification, AppSender } from "./AppNotifications.ts"
import type { Integration } from "./Connections.ts"
import type {
  AppId,
  IntegrationId,
  LinkId,
  MediaId,
  MessageId,
  NotificationId,
  ProjectId,
  UserId,
  WorkstreamId
} from "./Ids.ts"
import type { AppLink } from "./Links.ts"
import type { MediaRef } from "./Media.ts"
import type { AccessMessage, Message, QuestionMessage, TextMessage } from "./Message.ts"
import type { Project } from "./Project.ts"
import type { StatusCard } from "./Status.ts"
import type { AccountUsage, ProjectUsage, UsageSnapshot } from "./Usage.ts"
import type { User } from "./User.ts"
import type { Workstream } from "./Workstream.ts"

const at = (iso: string) => DateTime.makeUnsafe(iso)
const ids = {
  user: "usr_ada" as UserId,
  lift: "prj_liftlog" as ProjectId,
  brief: "prj_morningbrief" as ProjectId,
  cabin: "prj_cabin" as ProjectId,
  recipe: "prj_recipescaler" as ProjectId
}

export const user: User = {
  id: ids.user,
  email: "ada@example.com",
  name: "Ada",
  timeZone: "America/Los_Angeles",
  createdAt: at("2026-10-01T17:00:00Z")
}

const project = (fields: Pick<Project, "id" | "title" | "idea" | "phase" | "slug"> & Partial<Project>): Project => ({
  ownerId: ids.user,
  harness: "codex",
  publicUrl: `https://${fields.slug}-k3x9q2.dream.example`,
  createdAt: at("2026-10-13T16:00:00Z"),
  updatedAt: at("2026-11-04T22:09:00Z"),
  ...fields
})

export const liftLog = project({
  id: ids.lift,
  title: "Lift Log",
  kind: "iOS app",
  icon: "dumbbell",
  idea: "A strength log that reads Apple Health and tells me when to add weight.",
  phase: "building",
  headline: "Building progress charts for squat, bench and deadlift.",
  slug: "lift-log"
})

export const morningBrief = project({
  id: ids.brief,
  title: "Morning Brief",
  kind: "Background worker",
  icon: "sun.horizon",
  idea: "Reads my newsletters overnight and emails me a 5-minute digest at 7.",
  phase: "live",
  headline: "Sent today’s digest at 7:00",
  slug: "morning-brief"
})

export const cabin = project({
  id: ids.cabin,
  title: "Cabin",
  kind: "Web app",
  icon: "house",
  idea: "A booking site for our family cabin so relatives can claim weekends.",
  phase: "exploring",
  headline: "Three prototypes are ready for your reaction.",
  slug: "cabin"
})

export const recipeScaler = project({
  id: ids.recipe,
  title: "Recipe Scaler",
  kind: "Just started",
  icon: "frying.pan",
  idea: "Scale any recipe up or down, and keep the ingredient math honest.",
  phase: "interviewing",
  slug: "recipe-scaler"
})

export const healthImportRecording: MediaRef = {
  id: "med_healthimport" as MediaId,
  kind: "video",
  contentType: "video/mp4",
  sizeBytes: 3_400_000,
  width: 1170,
  height: 2532,
  durationSeconds: 24,
  caption: "Recording · 0:24"
}

export const liftLogStatus: StatusCard = {
  phase: "building",
  phaseSince: at("2026-11-02T17:00:00Z"),
  now: "Building progress charts for squat, bench and deadlift.",
  justDid: "Apple Health import works in the simulator — 214 workouts from a sample export.",
  next: "Rest timer with its own Live Activity, then a TestFlight build.",
  media: [healthImportRecording],
  milestones: [
    { title: "Prototype", state: "done", date: at("2026-10-14T20:00:00Z"), needs: [] },
    { title: "Health import", state: "done", date: at("2026-11-04T21:40:00Z"), needs: [] },
    { title: "Progress charts", state: "current", needs: [] },
    { title: "Rest timer", state: "upcoming", needs: [] },
    {
      title: "On your phone",
      state: "upcoming",
      needs: [{ what: "Your Apple Developer account", when: "around Thursday", messageId: "msg_apple" as MessageId }]
    }
  ],
  updatedAt: at("2026-11-04T22:09:00Z")
}

/**
 * Lift Log running three things at once (mocks/screens/workstreams, option A): the charts, the rest timer, and an
 * Android question they asked in Chat; the Health import finished the day before.
 */
export const liftLogWorkstreams: ReadonlyArray<Workstream> = [
  {
    id: "ws_charts" as WorkstreamId,
    title: "Progress charts",
    now: "Charting estimated 1RM for each lift",
    state: "active",
    startedAt: at("2026-11-04T21:45:00Z"),
    updatedAt: at("2026-11-04T22:09:00Z")
  },
  {
    id: "ws_timer" as WorkstreamId,
    title: "Rest timer",
    now: "Wiring it into a Live Activity",
    state: "active",
    startedAt: at("2026-11-04T21:50:00Z"),
    updatedAt: at("2026-11-04T22:05:00Z")
  },
  {
    id: "ws_android" as WorkstreamId,
    title: "Android?",
    now: "Finding out what it would take",
    state: "active",
    startedAt: at("2026-11-04T22:06:00Z"),
    updatedAt: at("2026-11-04T22:06:00Z")
  },
  {
    id: "ws_health" as WorkstreamId,
    title: "Health import",
    state: "done",
    result: "214 workouts from a sample export",
    startedAt: at("2026-11-03T17:00:00Z"),
    updatedAt: at("2026-11-04T21:40:00Z"),
    endedAt: at("2026-11-04T21:40:00Z")
  }
]

export const appleAccess: AccessMessage = {
  _tag: "Access",
  id: "msg_apple" as MessageId,
  projectId: ids.lift,
  createdAt: at("2026-11-03T18:00:00Z"),
  request: { _tag: "Apple" },
  why: "Add your Apple Developer key to put Lift Log on your phone.",
  when: "around Thursday",
  state: { _tag: "Open" }
}

export const liftLogUpdate: TextMessage = {
  _tag: "Text",
  id: "msg_liftimport" as MessageId,
  projectId: ids.lift,
  createdAt: at("2026-11-04T21:40:00Z"),
  from: "agent",
  text: "Apple Health import works in the simulator — 214 workouts from a sample export.",
  media: [healthImportRecording],
  notificationId: "6f1c7a52-8f0e-4c4b-9a53-2a0f5f8d9b11" as NotificationId
}

export const cabinQuestion: QuestionMessage = {
  _tag: "Question",
  id: "msg_cabinrule" as MessageId,
  projectId: ids.cabin,
  createdAt: at("2026-11-04T19:20:00Z"),
  question: "When two relatives want the same weekend, who gets it?",
  options: ["First to ask", "Rotate by family branch", "You approve each request"],
  why: "This rule shapes the booking flow and the data model, so I’d rather ask than guess.",
  meanwhile: "I’ll keep building the calendar; only the request step depends on this.",
  state: { _tag: "Open" },
  notificationId: "0b6a2d1e-3c4f-4e5a-8b7c-9d0e1f2a3b4c" as NotificationId
}

const preview = (
  id: string,
  caption: string,
  contentType: MediaRef["contentType"],
  size: { width?: number; height?: number; durationSeconds?: number }
): MediaRef => ({
  id: id as MediaId,
  kind: contentType.startsWith("video/") ? "video" : contentType.startsWith("audio/") ? "audio" : "image",
  contentType,
  sizeBytes: 200_000,
  ...size,
  caption
})

/** Option previews (`dream ask --show`): Cabin's three directions, as phone screens, a desktop page and a recording. */
export const cabinDirections: QuestionMessage = {
  _tag: "Question",
  id: "msg_cabindirs" as MessageId,
  projectId: ids.cabin,
  createdAt: at("2026-11-04T19:21:00Z"),
  question: "How should a weekend get booked?",
  options: ["Calendar first", "Requests first", "Rotation"],
  why: "This shapes the whole site, and it’s quicker to see than to describe.",
  previews: [
    {
      option: "Calendar first",
      media: [
        preview("med_optcal", "Opening the site", "image/jpeg", { width: 1170, height: 2532 }),
        preview("med_optcaldesk", "On a laptop", "image/jpeg", { width: 2880, height: 1800 })
      ]
    },
    {
      option: "Requests first",
      media: [
        preview("med_optreq", "Opening the site", "image/jpeg", { width: 1170, height: 2532 }),
        preview("med_optreqflow", "Asking for a weekend", "video/mp4", { width: 780, height: 1688, durationSeconds: 9 })
      ]
    },
    { option: "Rotation", media: [preview("med_optrot", "Opening the site", "image/jpeg", { width: 1170, height: 2532 })] }
  ],
  state: { _tag: "Open" },
  notificationId: "5c2e8a1f-6b3d-4f7e-a9c0-1d2e3f4a5b6c" as NotificationId
}

/** Option previews that are sounds: which chime the rest timer ends with. */
export const timerSounds: QuestionMessage = {
  _tag: "Question",
  id: "msg_timersound" as MessageId,
  projectId: ids.lift,
  createdAt: at("2026-11-04T21:40:00Z"),
  question: "Which sound should the rest timer end with?",
  options: ["Soft chime", "Three short buzzes", "Rising tone"],
  why: "You’ll hear it mid-set, so I’d rather you choose by ear.",
  previews: [
    { option: "Soft chime", media: [preview("med_sndchime", "Soft chime", "audio/mp4", { durationSeconds: 1.6 })] },
    { option: "Three short buzzes", media: [preview("med_sndbuzz", "Three short buzzes", "audio/mp4", { durationSeconds: 1.2 })] },
    { option: "Rising tone", media: [preview("med_sndrise", "Rising tone", "audio/mp4", { durationSeconds: 2 })] }
  ],
  state: { _tag: "Open" }
}

export const recipeQuestion: QuestionMessage = {
  _tag: "Question",
  id: "msg_recipewho" as MessageId,
  projectId: ids.recipe,
  createdAt: at("2026-11-04T22:00:00Z"),
  question: "Who’ll use this besides you?",
  options: ["Nobody, just me", "My household", "Friends and family"],
  why: "It decides whether I build accounts and sharing, or keep this as sharp as a personal tool.",
  meanwhile: "I’ll keep sketching how the scaling should work; this only changes who it’s for.",
  state: { _tag: "Open" }
}

export const gmailAccess: AccessMessage = {
  _tag: "Access",
  id: "msg_gmail" as MessageId,
  projectId: ids.brief,
  createdAt: at("2026-10-20T18:00:00Z"),
  request: { _tag: "Google", scopes: ["gmail.readonly"] },
  why: "Connect Gmail so I can read your newsletters.",
  state: {
    _tag: "Connected",
    integrationId: "int_google" as IntegrationId,
    connectedAt: at("2026-10-20T18:05:00Z")
  }
}

export const google: Integration = {
  id: "int_google" as IntegrationId,
  label: "Gmail",
  status: "connected",
  access: {
    _tag: "Google",
    email: "ada@example.com",
    scopes: ["gmail.readonly"],
    hosts: ["gmail.googleapis.com"],
    placeholder: "dream-placeholder-google"
  },
  connectedAt: at("2026-10-20T18:05:00Z")
}

/** A last-resort file key (`dream access file`), still open: Telegram's bot token goes in the URL, not a header. */
export const telegramKey: AccessMessage = {
  _tag: "Access",
  id: "msg_telegram" as MessageId,
  projectId: ids.brief,
  createdAt: at("2026-10-21T09:00:00Z"),
  request: { _tag: "File", service: "Telegram", name: "telegram-bot-token" },
  why: "Your bot token, so the brief can arrive in Telegram every morning.",
  state: { _tag: "Open" }
}

export const telegramKeyFile: Integration = {
  id: "int_telegram" as IntegrationId,
  label: "Telegram",
  status: "connected",
  access: {
    _tag: "File",
    service: "Telegram",
    name: "telegram-bot-token",
    path: "/home/user/.dream/keys/telegram-bot-token",
    projectId: ids.brief
  },
  connectedAt: at("2026-10-21T09:04:00Z")
}

export const usage: UsageSnapshot = {
  provider: "chatgpt",
  plan: "ChatGPT Pro",
  fiveHour: { usedPercent: 41, resetsAt: at("2026-11-04T23:40:00Z") },
  weekly: { usedPercent: 38, resetsAt: at("2026-11-09T08:00:00Z") },
  observedAt: at("2026-11-04T22:10:00Z")
}

/**
 * Lift Log's usage sheet: about 4% of a week that's 38% used, the rest spread over the other projects and use
 * outside Dream (Deck v3, project usage option A).
 */
export const liftLogUsage: ProjectUsage = {
  provider: "chatgpt",
  billing: "subscription",
  plan: "ChatGPT Pro",
  weekly: { usedPercent: 38, projectPercent: 4, resetsAt: at("2026-11-09T08:00:00Z") },
  fiveHourWindow: { usedPercent: 41, projectPercent: 9, resetsAt: at("2026-11-04T23:40:00Z") },
  today: { tokens: 2_140_000, cacheReadTokens: 18_400_000, sharePercent: 2 },
  fiveHour: { tokens: 910_000, cacheReadTokens: 7_900_000, sharePercent: 9 },
  week: { tokens: 9_620_000, cacheReadTokens: 83_000_000, sharePercent: 4 },
  projects: [
    { projectId: ids.recipe, title: "Recipe Scaler", icon: "frying.pan", sharePercent: 19 },
    { projectId: ids.lift, title: "Lift Log", icon: "dumbbell", sharePercent: 4 },
    { projectId: ids.cabin, title: "Cabin", icon: "house", sharePercent: 3 },
    { projectId: ids.brief, title: "Morning Brief", icon: "sun.horizon", sharePercent: 2 }
  ],
  outsideDreamPercent: 10,
  subagents: "included",
  observedAt: at("2026-11-04T22:10:00Z")
}

/** Settings' plan card for the same ChatGPT Pro week: every project's share, together 28%, and 10% outside Dream. */
export const accountUsage: AccountUsage = {
  provider: "chatgpt",
  billing: "subscription",
  plan: "ChatGPT Pro",
  fiveHour: { usedPercent: 41, dreamPercent: 30, resetsAt: at("2026-11-04T23:40:00Z") },
  weekly: { usedPercent: 38, dreamPercent: 28, resetsAt: at("2026-11-09T08:00:00Z") },
  projects: liftLogUsage.projects,
  outsideDreamPercent: 10,
  observedAt: at("2026-11-04T22:10:00Z")
}

/**
 * App links on Home (option A, the dock): three made by agents, the newest (Cabin) not opened yet, and one they
 * added themselves, which has no icon and shows a monogram.
 */
export const links: ReadonlyArray<AppLink> = [
  {
    id: "lnk_liftlog" as LinkId,
    url: liftLog.publicUrl,
    title: "Lift Log",
    icon: { _tag: "Symbol", name: "dumbbell" },
    color: "purple",
    projectId: liftLog.id,
    addedBy: "agent",
    createdAt: at("2026-10-28T18:00:00Z"),
    updatedAt: at("2026-10-28T18:00:00Z"),
    openedAt: at("2026-10-28T19:00:00Z")
  },
  {
    id: "lnk_brief" as LinkId,
    url: `${morningBrief.publicUrl}/today`,
    title: "Brief",
    icon: { _tag: "Symbol", name: "sun.horizon" },
    color: "orange",
    projectId: morningBrief.id,
    addedBy: "agent",
    createdAt: at("2026-10-30T15:00:00Z"),
    updatedAt: at("2026-10-30T15:00:00Z"),
    openedAt: at("2026-10-31T14:00:00Z")
  },
  {
    id: "lnk_cabin" as LinkId,
    url: cabin.publicUrl,
    title: "Cabin",
    icon: { _tag: "Symbol", name: "house" },
    color: "green",
    projectId: cabin.id,
    addedBy: "agent",
    createdAt: at("2026-11-04T21:50:00Z"),
    updatedAt: at("2026-11-04T21:50:00Z")
  },
  {
    id: "lnk_traintimes" as LinkId,
    url: "https://www.realtimetrains.co.uk/search/simple/gb-nr:HIB/to/gb-nr:EUS",
    title: "Train times",
    color: "light",
    addedBy: "person",
    createdAt: at("2026-11-01T08:00:00Z"),
    updatedAt: at("2026-11-01T08:00:00Z"),
    openedAt: at("2026-11-02T07:40:00Z")
  }
]

/** Morning Brief's digest notifies them itself (`dream notify setup morning-brief`), and they allowed it. */
export const morningBriefNotificationsCard: AccessMessage = {
  _tag: "Access",
  id: "msg_briefnotify" as MessageId,
  projectId: ids.brief,
  createdAt: at("2026-10-21T17:00:00Z"),
  notificationId: "2f0b8a52-3f7e-4d0c-9a51-6c1f4b9e7d21" as NotificationId,
  request: {
    _tag: "Notifications",
    app: "morning-brief" as AppId,
    name: "Morning Brief",
    often: "Once a day, at 7",
    icon: { _tag: "Symbol", name: "sun.horizon.fill" },
    color: "orange"
  },
  why: "When today’s digest is ready",
  state: { _tag: "Allowed", allowedAt: at("2026-10-21T17:04:00Z") }
}

export const morningBriefApp: AppSender = {
  id: "morning-brief" as AppId,
  name: "Morning Brief",
  icon: { _tag: "Symbol", name: "sun.horizon.fill" },
  color: "orange",
  url: "https://morning-brief-k3x9q2.dream.example/",
  why: "When today’s digest is ready",
  often: "Once a day, at 7",
  messageId: morningBriefNotificationsCard.id,
  state: { _tag: "Allowed", allowedAt: at("2026-10-21T17:04:00Z") },
  delivery: "immediate",
  createdAt: at("2026-10-21T17:00:00Z")
}

export const morningBriefAppNotifications: ReadonlyArray<AppNotification> = [
  {
    id: "7c1e2d9a-41b6-4f3e-8a0d-2b5c9e6f1a01" as NotificationId,
    app: morningBriefApp.id,
    title: "Today’s digest: 6 newsletters, 5 minutes",
    text: "Stratechery on Apple’s chip plans, Money Stuff on the bond rally, and a short one from Platformer.",
    url: "https://morning-brief-k3x9q2.dream.example/digest/2026-11-04",
    key: "digest",
    outcome: "sent",
    sentAt: at("2026-11-04T15:00:00Z"),
    openedAt: at("2026-11-04T15:12:00Z")
  },
  {
    id: "7c1e2d9a-41b6-4f3e-8a0d-2b5c9e6f1a02" as NotificationId,
    app: morningBriefApp.id,
    title: "Today’s digest: 4 newsletters, 3 minutes",
    text: "A quiet day: Money Stuff, Matt Levine’s mailbag, and two short ones.",
    url: "https://morning-brief-k3x9q2.dream.example/digest/2026-11-03",
    key: "digest",
    outcome: "sent",
    sentAt: at("2026-11-03T15:00:00Z"),
    replacedAt: at("2026-11-04T15:00:00Z")
  },
  {
    id: "7c1e2d9a-41b6-4f3e-8a0d-2b5c9e6f1a03" as NotificationId,
    app: morningBriefApp.id,
    title: "Gmail stopped answering",
    text: "Today’s digest is late; it will try again at 8.",
    outcome: "quiet",
    sentAt: at("2026-11-02T15:00:00Z")
  }
]

export const messages: ReadonlyArray<Message> = [appleAccess, liftLogUpdate, cabinQuestion, recipeQuestion, gmailAccess]

export const events: ReadonlyArray<AgentEvent> = [
  {
    _tag: "UserMessage",
    id: "evt_1" as AgentEvent["id"],
    at: at("2026-11-04T22:02:00Z"),
    messageId: "msg_1rm" as MessageId,
    text: "Can the charts show estimated 1RM, not just the weight?"
  },
  {
    _tag: "QuestionAnswered",
    id: "evt_2" as AgentEvent["id"],
    at: at("2026-11-04T22:05:00Z"),
    messageId: cabinQuestion.id,
    question: cabinQuestion.question,
    answer: { _tag: "Choice", option: "First to ask" }
  }
]
