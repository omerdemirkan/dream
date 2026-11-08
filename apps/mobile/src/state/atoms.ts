/**
 * What the screens read and do, as atoms over the app's services.
 *
 * Queries refresh through reactivity keys when a mutation changes what they
 * show ("projects", "connections", "integrations"), and when the app
 * comes back to the foreground.
 */
import {
  type AccessMessage,
  type Features,
  type AppDelivery,
  type AppId,
  type AppLink,
  type LinkColor,
  type Harness,
  type LinkIcon,
  type LinkId,
  type IntegrationId,
  type MediaId,
  type Message,
  type MessageId,
  type ModelConnectionId,
  type ModelProvider,
  NotificationId,
  type ProjectId,
  type QuestionAnswer,
  type RequestId,
  type UsageLimits,
  type WorkstreamId,
  type User
} from "@dream/domain"
import * as Application from "expo-application"
import { getCalendars } from "expo-localization"
import { type DateTime, Effect, Option, Redacted, Schedule, Schema, Stream } from "effect"
import { Atom } from "effect/reactivity"
import { AppClient } from "../data/AppClient.ts"
import { type AnswerInput, Answers, asksChanged } from "../data/Answers.ts"
import { withWriteTimeout } from "../data/errors.ts"
import { ProjectArchive } from "../data/ProjectArchive.ts"
import { ProjectStates } from "../data/ProjectStates.ts"
import { AccountUsages } from "../data/AccountUsages.ts"
import { CostReports } from "../data/CostReports.ts"
import { ProjectUsages } from "../data/ProjectUsages.ts"
import { Replies, type Reply, type ReplyTarget } from "../data/Replies.ts"
import { Session } from "../data/Session.ts"
import { FakeBackend, type Scenario } from "../fake/FakeBackend.ts"
import { googleIdToken } from "../platform/google.ts"
import * as Push from "../platform/push.ts"
import { appRuntime } from "./runtime.ts"

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const sessionAtom = appRuntime.subscriptionRef(Session.useSync((session) => session.current))

/** Google's sign-in sheet, then the API's `SignIn`. Succeeds with none if they cancelled. */
export const signInWithGoogleFn = appRuntime.fn(
  Effect.fn(function* () {
    const token = yield* googleIdToken
    if (Option.isNone(token)) return Option.none<User>()
    const app = yield* AppClient
    const session = yield* Session
    const result = yield* app.SignIn({ googleIdToken: token.value })
    yield* session.signIn({ token: result.sessionToken, user: result.user })
    return Option.some(result.user)
  })
)

export const devSignInFn = appRuntime.fn(
  Effect.fn(function* (input: { readonly email: string; readonly secret: string }) {
    const app = yield* AppClient
    const session = yield* Session
    const result = yield* app.DevSignIn({ email: input.email, secret: Redacted.make(input.secret) })
    yield* session.signIn({ token: result.sessionToken, user: result.user })
    return result.user
  })
)

export const signOutFn = appRuntime.fn(
  Effect.fn(function* () {
    const app = yield* AppClient
    const session = yield* Session
    yield* app.UnregisterDevice({ deviceId: session.deviceId }).pipe(Effect.ignore)
    yield* session.signOut
  })
)

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export const projectsAtom = appRuntime
  .atom(AppClient.use((app) => app.ListProjects()))
  .pipe(Atom.withReactivity(["projects"]), Atom.keepAlive)

export const modelConnectionsAtom = appRuntime
  .atom(AppClient.use((app) => app.ListModelConnections()))
  .pipe(Atom.withReactivity(["connections"]), Atom.keepAlive)

/** What the API can do; an API without `GetFeatures` (or unreachable) turns nothing extra on. */
/**
 * What this deployment can do (email links, …), fetched once per launch. A blip on that one call would hide those
 * features until the app restarted, so it retries a few times before settling for "none".
 */
export const featuresAtom = appRuntime
  .atom(
    AppClient.use((app) =>
      app.GetFeatures().pipe(
        Effect.retry({ schedule: Schedule.exponential("1 second"), times: 5 }),
        Effect.orElseSucceed((): Features => ({}))
      )
    )
  )
  .pipe(Atom.keepAlive)

export const integrationsAtom = appRuntime
  .atom(AppClient.use((app) => app.ListIntegrations()))
  .pipe(Atom.withReactivity(["integrations"]))

/** Their archived projects, for Settings. */
export const archivedProjectsAtom = appRuntime
  .atom(AppClient.use((app) => app.ListArchivedProjects()))
  .pipe(Atom.withReactivity(["archived"]))

/** Projects archived or deleted from this phone: Home leaves them out at once. */
export const hiddenProjectsAtom = appRuntime.subscriptionRef(ProjectArchive.useSync((archive) => archive.hidden))

export const archiveProjectFn = appRuntime.fn(
  Effect.fn(function* (projectId: ProjectId) {
    return yield* ProjectArchive.use((archive) => archive.archive(projectId))
  })
)

export const restoreProjectFn = appRuntime.fn(
  Effect.fn(function* (projectId: ProjectId) {
    return yield* ProjectArchive.use((archive) => archive.restore(projectId))
  })
)

export const deleteProjectFn = appRuntime.fn(
  Effect.fn(function* (projectId: ProjectId) {
    yield* ProjectArchive.use((archive) => archive.remove(projectId))
  })
)

// ---------------------------------------------------------------------------
// App links (the row of app icons at the top of Home)
// ---------------------------------------------------------------------------

export const linksAtom = appRuntime
  .atom(AppClient.use((app) => app.ListLinks()))
  .pipe(Atom.withReactivity(["links"]), Atom.keepAlive)

/** The agents' links they took off Home, for the add sheet. An API from before them has none to offer. */
export const removedLinksAtom = appRuntime
  .atom(
    AppClient.use((app) => app.ListRemovedLinks()).pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<AppLink>>([])))
  )
  .pipe(Atom.withReactivity(["links"]), Atom.keepAlive)

export const restoreLinkFn = appRuntime.fn(
  Effect.fn(function* (linkId: LinkId) {
    const app = yield* AppClient
    return yield* app.RestoreLink({ linkId }).pipe(withWriteTimeout)
  }),
  { reactivityKeys: ["links"] }
)

export const updateLinkFn = appRuntime.fn(
  Effect.fn(function* (input: {
    readonly linkId: LinkId
    readonly title?: string
    readonly icon?: LinkIcon | null
    readonly color?: LinkColor
  }) {
    const app = yield* AppClient
    return yield* app.UpdateLink(input).pipe(withWriteTimeout)
  }),
  { reactivityKeys: ["links"] }
)

export const removeLinkFn = appRuntime.fn(
  Effect.fn(function* (linkId: LinkId) {
    const app = yield* AppClient
    yield* app.RemoveLink({ linkId }).pipe(withWriteTimeout)
  }),
  { reactivityKeys: ["links"] }
)

/** Takes a new link's dot away; nothing to report if it fails. */
export const markLinkOpenedFn = appRuntime.fn(
  Effect.fn(function* (linkId: LinkId) {
    const app = yield* AppClient
    yield* app.MarkLinkOpened({ linkId }).pipe(Effect.ignore)
  }),
  { reactivityKeys: ["links"] }
)

/** Hands the gateway the tile as a png, and returns the URL to open in Safari. */
export const prepareHomeScreenFn = appRuntime.fn(
  Effect.fn(function* (input: { readonly linkId: LinkId; readonly iconPng?: string | undefined }) {
    const app = yield* AppClient
    const { iconPng, linkId } = input
    return yield* app
      .PrepareHomeScreen({ linkId, ...(iconPng === undefined ? {} : { iconPng }) })
      .pipe(withWriteTimeout)
  })
)

/** Refreshes everything Home shows, e.g. when the app returns to the foreground or a push arrives. */
export const refreshHomeFn = appRuntime.fn(
  Effect.fn(function* () {
    yield* Effect.void
  }),
  { reactivityKeys: ["projects", "connections", "links"] }
)

/** `requestId` stays the same when they retry the same idea, so a retry can't start a second project. */
export const createProjectFn = appRuntime.fn(
  Effect.fn(function* (input: {
    readonly idea: string
    readonly requestId: RequestId
    readonly attachments?: ReadonlyArray<MediaId>
    /** Only with both plans connected: the one the new-idea picker shows. */
    readonly harness?: Harness
  }) {
    const app = yield* AppClient
    return yield* app.CreateProject(input).pipe(withWriteTimeout)
  }),
  { reactivityKeys: ["projects"] }
)

// ---------------------------------------------------------------------------
// A project
// ---------------------------------------------------------------------------

/** The live state of one project; `None` until its first snapshot. */
export const projectAtom = Atom.family((projectId: ProjectId) =>
  appRuntime.atom(Stream.unwrap(ProjectStates.useSync((states) => states.state(projectId))))
)

/** The header's usage figures for a project; `undefined` while none are known. */
export const usageGlanceAtom = Atom.family((projectId: ProjectId) =>
  appRuntime.atom(Stream.unwrap(ProjectUsages.useSync((usages) => usages.glance(projectId))))
)

/** Settings' plan card for one subscription, fetched when Settings opens; `undefined` when the API can't say. */
export const accountUsageAtom = Atom.family((provider: ModelProvider) =>
  appRuntime.atom(AccountUsages.use((usages) => usages.plan(provider)))
)

/** The usage sheet, fetched when it opens (refresh it to fetch again). */
export const projectUsageAtom = Atom.family((projectId: ProjectId) =>
  appRuntime.atom(ProjectUsages.use((usages) => usages.sheet(projectId)))
)

/** What Dream paid to run a project, for its usage sheet; fetched when the sheet opens. */
export const projectCostsAtom = Atom.family((projectId: ProjectId) =>
  appRuntime.atom(CostReports.use((costs) => costs.project(projectId)))
)

/** What Dream paid across their projects, for Settings and its full-screen detail. */
export const accountCostsAtom = appRuntime.atom(CostReports.use((costs) => costs.account()))

/** Their limits on a project's usage, both at once; returns the sheet as it is now. */
export const setUsageLimitsFn = appRuntime
  .fn(
    Effect.fn(function* (input: { readonly projectId: ProjectId; readonly limits: UsageLimits }) {
      const usages = yield* ProjectUsages
      return yield* usages.setLimits(input.projectId, input.limits).pipe(withWriteTimeout)
    })
  )
  // Kept alive: a limit typed as the sheet closes is saved after it's gone.
  .pipe(Atom.keepAlive)

export const loadEarlierFn = appRuntime.fn(
  Effect.fn(function* (projectId: ProjectId) {
    const states = yield* ProjectStates
    yield* states.loadEarlier(projectId)
  })
)

export const reconnectProjectsFn = appRuntime.fn(
  Effect.fn(function* () {
    const states = yield* ProjectStates
    yield* states.reconnect
  })
)

/**
 * A message they acted on here. Once a question or access request is settled, its notification has nothing left to
 * ask, so it leaves the lock screen now rather than when the API's withdrawal reaches the phone.
 */
const received = (message: Message) =>
  ProjectStates.use((states) => states.receive(message)).pipe(
    Effect.tap(() =>
      (message._tag === "Question" || message._tag === "Access") && message.state._tag !== "Open"
        ? Push.removeDeliveredFor([message.id]).pipe(Effect.ignore)
        : Effect.void
    )
  )

/** `requestId` stays the same when they retry the same text, so a retry can't post it twice. */
export const sendMessageFn = appRuntime.fn(
  Effect.fn(function* (input: {
    readonly projectId: ProjectId
    readonly text: string
    readonly requestId: RequestId
    /** Written into one of the agent's workstreams. */
    readonly workstream?: WorkstreamId
    /** Written in the thread on this message. */
    readonly replyTo?: MessageId
    /** Uploaded photos and files that go with it. */
    readonly attachments?: ReadonlyArray<MediaId>
  }) {
    const app = yield* AppClient
    const message = yield* app.SendMessage(input).pipe(withWriteTimeout)
    yield* received(message)
    return message
  }),
  { reactivityKeys: ["projects"] }
)

/**
 * A thread as the API has it (`ListThread`), keyed `<projectId>/<messageId>`, for one whose first message is older
 * than the Chat loaded. The thread view merges it with the live messages, which win.
 */
export const threadAtom = Atom.family((key: string) => {
  const [projectId, messageId] = key.split("/") as [ProjectId, MessageId]
  return appRuntime.atom(AppClient.use((app) => app.ListThread({ projectId, messageId })))
})

/** A reply typed into a notification (see `Replies`): retried, and kept as a draft if it still fails. */
export const replyFn = appRuntime.fn(
  Effect.fn(function* (reply: Reply) {
    const replies = yield* Replies
    const message = yield* replies.send(reply)
    yield* received(message)
    return message
  }),
  { reactivityKeys: [...asksChanged, "drafts"] }
)

/** The text of a reply that didn't send, by `draftKey`; read when the composer it belongs in appears. */
export const draftAtom = Atom.family((key: string) =>
  appRuntime.atom(Replies.use((replies) => replies.draft(key))).pipe(Atom.withReactivity(["drafts"]))
)

export const clearDraftFn = appRuntime.fn(
  Effect.fn(function* (target: ReplyTarget) {
    const replies = yield* Replies
    yield* replies.clearDraft(target)
  }),
  { reactivityKeys: ["drafts"] }
)

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export const answerNowFn = appRuntime.fn(
  Effect.fn(function* (input: AnswerInput) {
    const answers = yield* Answers
    const message = yield* answers.answerNow(input)
    yield* received(message)
    return message
  })
)

export type { QuestionAnswer }

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

interface AccessRef {
  readonly projectId: ProjectId
  readonly messageId: MessageId
}

const accessChanged = { reactivityKeys: [...asksChanged, "integrations", "app-notifications"] }

export const startGoogleAccessFn = appRuntime.fn(
  Effect.fn(function* (input: AccessRef) {
    const app = yield* AppClient
    return yield* app.StartGoogleAccess(input)
  })
)

export const startOAuthAccessFn = appRuntime.fn(
  Effect.fn(function* (input: AccessRef) {
    const app = yield* AppClient
    return yield* app.StartOAuthAccess(input)
  })
)

const receivedAccess = (message: AccessMessage) => received(message).pipe(Effect.as(message))

export const submitKeyAccessFn = appRuntime.fn(
  Effect.fn(function* (input: AccessRef & { readonly key: string }) {
    const app = yield* AppClient
    const message = yield* app.SubmitKeyAccess({ ...input, key: Redacted.make(input.key) }).pipe(withWriteTimeout)
    return yield* receivedAccess(message)
  }),
  accessChanged
)

export const submitAppleAccessFn = appRuntime.fn(
  Effect.fn(function* (
    input: AccessRef & { readonly issuerId: string; readonly keyId: string; readonly privateKey: string }
  ) {
    const app = yield* AppClient
    const message = yield* app
      .SubmitAppleAccess({ ...input, privateKey: Redacted.make(input.privateKey) })
      .pipe(withWriteTimeout)
    return yield* receivedAccess(message)
  }),
  accessChanged
)

/** "Email it to me": a link to finish the request on a computer, sent to the address they signed in with. */
export const emailAccessLinkFn = appRuntime.fn(
  Effect.fn(function* (input: AccessRef) {
    const app = yield* AppClient
    return yield* receivedAccess(yield* app.EmailAccessLink(input).pipe(withWriteTimeout))
  }),
  accessChanged
)

export const declineAccessFn = appRuntime.fn(
  Effect.fn(function* (input: AccessRef & { readonly reason?: string }) {
    const app = yield* AppClient
    return yield* receivedAccess(yield* app.DeclineAccess(input).pipe(withWriteTimeout))
  }),
  accessChanged
)

// ---------------------------------------------------------------------------
// Notifications from a project's apps
// ---------------------------------------------------------------------------

/** A project's apps that notify, and what they sent: the Notifications sheet, fetched when it opens. */
export const appNotificationsAtom = Atom.family((projectId: ProjectId) =>
  appRuntime
    .atom(AppClient.use((app) => app.GetAppNotifications({ projectId })))
    .pipe(Atom.withReactivity(["app-notifications"]))
)

/** "Allow" on an app's card, or in the sheet for one they declined. */
export const allowAppNotificationsFn = appRuntime.fn(
  Effect.fn(function* (input: AccessRef) {
    const app = yield* AppClient
    return yield* receivedAccess(yield* app.AllowAppNotifications(input).pipe(withWriteTimeout))
  }),
  accessChanged
)

/** Immediately, Quietly or Off, and Mute until a time (`null` unmutes), for one app. */
export const updateAppNotificationsFn = appRuntime.fn(
  Effect.fn(function* (input: {
    readonly projectId: ProjectId
    readonly app: AppId
    readonly delivery?: AppDelivery
    readonly mutedUntil?: DateTime.Utc | null
  }) {
    const app = yield* AppClient
    return yield* app.UpdateAppNotifications(input).pipe(withWriteTimeout)
  }),
  { reactivityKeys: ["app-notifications"] }
)

/** They opened one of an app's notifications; nothing to report if that doesn't reach Dream. */
export const openedAppNotificationFn = appRuntime.fn(
  Effect.fn(function* (input: { readonly projectId: ProjectId; readonly notificationId: NotificationId }) {
    const app = yield* AppClient
    yield* app.OpenedAppNotification(input).pipe(Effect.ignore)
  }),
  { reactivityKeys: ["app-notifications"] }
)

/** A new key for a pasted or file key, from Settings. Sending the same key again changes nothing. */
export const replaceKeyFn = appRuntime.fn(
  Effect.fn(function* (input: { readonly integrationId: IntegrationId; readonly key: string }) {
    const app = yield* AppClient
    return yield* app
      .ReplaceKey({ integrationId: input.integrationId, key: Redacted.make(input.key) })
      .pipe(withWriteTimeout)
  }),
  { reactivityKeys: ["integrations"] }
)

export const disconnectIntegrationFn = appRuntime.fn(
  Effect.fn(function* (integrationId: IntegrationId) {
    const app = yield* AppClient
    yield* app.DisconnectIntegration({ integrationId })
  }),
  accessChanged
)

// ---------------------------------------------------------------------------
// Model connections (Claude or ChatGPT)
// ---------------------------------------------------------------------------

export const startModelConnectionFn = appRuntime.fn(
  Effect.fn(function* (provider: ModelProvider) {
    const app = yield* AppClient
    return yield* app.StartModelConnection({ provider })
  }),
  { reactivityKeys: ["connections"] }
)

export const completeModelConnectionFn = appRuntime.fn(
  Effect.fn(function* (input: { readonly connectionId: ModelConnectionId; readonly code: string }) {
    const app = yield* AppClient
    return yield* app.CompleteModelConnection({ connectionId: input.connectionId, code: Redacted.make(input.code) })
  }),
  { reactivityKeys: ["connections"] }
)

/** Polls a device-code sign-in until it's no longer pending. */
export const awaitModelConnectionFn = appRuntime.fn(
  Effect.fn(function* (connectionId: ModelConnectionId) {
    const app = yield* AppClient
    while (true) {
      const connection = yield* app.GetModelConnection({ connectionId })
      if (connection.status !== "pending") return connection
      yield* Effect.sleep("3 seconds")
    }
  }),
  { reactivityKeys: ["connections"] }
)

export const disconnectModelConnectionFn = appRuntime.fn(
  Effect.fn(function* (connectionId: ModelConnectionId) {
    const app = yield* AppClient
    yield* app.DisconnectModelConnection({ connectionId })
  }),
  { reactivityKeys: ["connections"] }
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Puts the fixtures world in a named state (no-op against the real API). */
export const scenarioFn = appRuntime.fn(
  Effect.fn(function* (name: Scenario) {
    const backend = yield* Effect.serviceOption(FakeBackend)
    if (Option.isNone(backend)) return
    yield* backend.value.scenario(name)
    const session = yield* Session
    if (name === "signed-out") yield* session.signOut
    if (name === "signed-in") {
      const app = yield* AppClient
      const result = yield* app.DevSignIn({ email: "ada@example.com", secret: Redacted.make("fixtures") })
      yield* session.signIn({ token: result.sessionToken, user: result.user })
    }
  }),
  { reactivityKeys: ["projects", "connections", "integrations", "links"] }
)

// ---------------------------------------------------------------------------
// This device: push tokens, Live Activities, delivered notifications
// ---------------------------------------------------------------------------

const timeZone = () => getCalendars()[0]?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"

/** Upserts this install with every token known so far. */
export const registerDeviceFn = appRuntime.fn(
  Effect.fn(function* (tokens: {
    readonly apnsToken?: string | undefined
    readonly pushToStartToken?: string | undefined
  }) {
    const app = yield* AppClient
    const session = yield* Session
    return yield* app.RegisterDevice({
      deviceId: session.deviceId,
      timeZone: timeZone(),
      ...(Application.nativeApplicationVersion ? { appVersion: Application.nativeApplicationVersion } : {}),
      ...(tokens.apnsToken ? { apnsToken: tokens.apnsToken } : {}),
      ...(tokens.pushToStartToken ? { pushToStartToken: tokens.pushToStartToken } : {})
    })
  })
)

export const registerLiveActivityFn = appRuntime.fn(
  Effect.fn(function* (input: {
    readonly projectId: ProjectId
    readonly activityId: string
    readonly pushToken: string
  }) {
    const app = yield* AppClient
    const session = yield* Session
    yield* app.RegisterLiveActivity({ ...input, deviceId: session.deviceId })
  })
)

/** Asks the API which delivered notifications were withdrawn, and removes them. */
export const cleanUpNotificationsFn = appRuntime.fn(
  Effect.fn(function* () {
    const delivered = yield* Push.deliveredIds
    const ids = delivered.flatMap((id) => Option.toArray(Schema.decodeUnknownOption(NotificationId)(id.toLowerCase())))
    if (ids.length === 0) return
    const app = yield* AppClient
    const { stale } = yield* app.FilterStaleNotifications({ notificationIds: ids })
    if (stale.length > 0) yield* Push.removeDelivered(stale)
  })
)

/**
 * Fixtures mode: what the fake backend would have pushed through APNs, shown
 * as local notifications with the same payload shape. Runs while mounted.
 */
export const fixturePushesAtom = appRuntime.atom(
  Effect.gen(function* () {
    const backend = yield* Effect.serviceOption(FakeBackend)
    if (Option.isNone(backend)) return
    yield* backend.value.pushes.pipe(
      Stream.runForEach((push) =>
        push.data._tag === "Withdraw"
          ? Push.removeDelivered(push.data.notificationIds).pipe(Effect.ignore)
          : Push.presentLocal(push).pipe(Effect.ignore)
      )
    )
  })
)
