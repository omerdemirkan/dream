/**
 * The Deck v3 sample content (mocks/BRIEF.md) as domain values, for tests and
 * for building UI before the API exists. Import from "@dream/domain/fixtures";
 * it is not part of the main entry point.
 */
import { DateTime } from "effect"
import type { AgentEvent } from "./AgentEvent.ts"
import type { Integration } from "./Connections.ts"
import type { IntegrationId, LinkId, MediaId, MessageId, NotificationId, ProjectId, UserId } from "./Ids.ts"
import type { AppLink } from "./Links.ts"
import type { MediaRef } from "./Media.ts"
import type { AccessMessage, Message, QuestionMessage, TextMessage } from "./Message.ts"
import type { Project } from "./Project.ts"
import type { StatusCard } from "./Status.ts"
import type { UsageSnapshot } from "./Usage.ts"
import type { User } from "./User.ts"

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
