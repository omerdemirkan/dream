/**
 * What the screens read and do, as atoms over the app's services.
 *
 * Queries refresh through reactivity keys when a mutation changes what they
 * show ("projects", "asks", "connections", "integrations"), and when the app
 * comes back to the foreground.
 */
import {
  type AccessMessage,
  type IntegrationId,
  type Message,
  type MessageId,
  type ModelConnectionId,
  type ModelProvider,
  NotificationId,
  type ProjectId,
  type QuestionAnswer,
  type User
} from "@dream/domain"
import * as Application from "expo-application"
import { getCalendars } from "expo-localization"
import { Effect, Option, Redacted, Schema, Stream } from "effect"
import { Atom } from "effect/reactivity"
import { AppClient } from "../data/AppClient.ts"
import { type AnswerInput, Answers, asksChanged } from "../data/Answers.ts"
import { ProjectStates } from "../data/ProjectStates.ts"
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

export const openAsksAtom = appRuntime
  .atom(AppClient.use((app) => app.ListOpenAsks()))
  .pipe(Atom.withReactivity(["asks"]), Atom.keepAlive)

export const modelConnectionsAtom = appRuntime
  .atom(AppClient.use((app) => app.ListModelConnections()))
  .pipe(Atom.withReactivity(["connections"]), Atom.keepAlive)

export const integrationsAtom = appRuntime
  .atom(AppClient.use((app) => app.ListIntegrations()))
  .pipe(Atom.withReactivity(["integrations"]))

/** Refreshes everything Home shows, e.g. when the app returns to the foreground or a push arrives. */
export const refreshHomeFn = appRuntime.fn(
  Effect.fn(function* () {
    yield* Effect.void
  }),
  { reactivityKeys: ["projects", "asks", "connections"] }
)

export const createProjectFn = appRuntime.fn(
  Effect.fn(function* (idea: string) {
    const app = yield* AppClient
    return yield* app.CreateProject({ idea })
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

const received = (message: Message) => ProjectStates.use((states) => states.receive(message))

export const sendMessageFn = appRuntime.fn(
  Effect.fn(function* (input: { readonly projectId: ProjectId; readonly text: string }) {
    const app = yield* AppClient
    const message = yield* app.SendMessage(input)
    yield* received(message)
    return message
  }),
  { reactivityKeys: ["projects"] }
)

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Answers held for Undo, by question; the UI shows them as answered. */
export const pendingAnswersAtom = appRuntime.subscriptionRef(Answers.useSync((answers) => answers.pending))

export const answerNowFn = appRuntime.fn(
  Effect.fn(function* (input: AnswerInput) {
    const answers = yield* Answers
    const message = yield* answers.answerNow(input)
    yield* received(message)
    return message
  })
)

export const answerUndoableFn = appRuntime.fn(
  Effect.fn(function* (input: AnswerInput) {
    const answers = yield* Answers
    yield* answers.answerUndoable(input)
  })
)

export const undoAnswerFn = appRuntime.fn(
  Effect.fn(function* (messageId: MessageId) {
    const answers = yield* Answers
    return yield* answers.undo(messageId)
  })
)

export const flushAnswersFn = appRuntime.fn(
  Effect.fn(function* () {
    const answers = yield* Answers
    yield* answers.flush
  })
)

/** Failures of answers sent after their undo window, for the toast. */
export const answerFailuresAtom = appRuntime.atom(Stream.unwrap(Answers.useSync((answers) => answers.failures)))

export type { QuestionAnswer }

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

interface AccessRef {
  readonly projectId: ProjectId
  readonly messageId: MessageId
}

const accessChanged = { reactivityKeys: [...asksChanged, "integrations"] }

export const startGoogleAccessFn = appRuntime.fn(
  Effect.fn(function* (input: AccessRef) {
    const app = yield* AppClient
    return yield* app.StartGoogleAccess(input)
  })
)

const receivedAccess = (message: AccessMessage) => received(message).pipe(Effect.as(message))

export const submitKeyAccessFn = appRuntime.fn(
  Effect.fn(function* (input: AccessRef & { readonly key: string }) {
    const app = yield* AppClient
    const message = yield* app.SubmitKeyAccess({ ...input, key: Redacted.make(input.key) })
    return yield* receivedAccess(message)
  }),
  accessChanged
)

export const submitAppleAccessFn = appRuntime.fn(
  Effect.fn(function* (
    input: AccessRef & { readonly issuerId: string; readonly keyId: string; readonly privateKey: string }
  ) {
    const app = yield* AppClient
    const message = yield* app.SubmitAppleAccess({ ...input, privateKey: Redacted.make(input.privateKey) })
    return yield* receivedAccess(message)
  }),
  accessChanged
)

export const declineAccessFn = appRuntime.fn(
  Effect.fn(function* (input: AccessRef) {
    const app = yield* AppClient
    return yield* receivedAccess(yield* app.DeclineAccess(input))
  }),
  accessChanged
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
  { reactivityKeys: ["projects", "asks", "connections", "integrations"] }
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
