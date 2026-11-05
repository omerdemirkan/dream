/**
 * Phone → API over HTTP (`Routes.app`). Everything the app does except the
 * live project stream, which is `ProjectLiveRpcs`.
 */
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { AppAuth } from "../Auth.ts"
import { ConnectLink, ConnectLinkProvider, Integration, ModelConnectFlow, ModelConnection } from "../Connections.ts"
import { InvalidRequest, NoModelConnection, NotFound, NotInvited, Unauthorized, UpstreamFailure } from "../Errors.ts"
import { DeviceId, IntegrationId, MessageId, ModelConnectionId, NotificationId, ProjectId, RequestId } from "../Ids.ts"
import { AccessMessage, AskMessage, Message, QuestionAnswer, QuestionMessage, TextMessage } from "../Message.ts"
import { Harness, Project, ProjectSummary } from "../Project.ts"
import { ModelProvider } from "../Usage.ts"
import { Device, TimeZone, User } from "../User.ts"

/** An open question or access request for the Home deck, with the project it belongs to. */
export const OpenAsk = Schema.Struct({
  project: Project,
  message: AskMessage
})
export type OpenAsk = typeof OpenAsk.Type

const ProjectMessage = { projectId: ProjectId, messageId: MessageId }

// ---------------------------------------------------------------------------
// Unauthenticated
// ---------------------------------------------------------------------------

/** Sign in with the ID token from native Google Sign-In; returns a Dream session token. */
export class PublicAppRpcs extends RpcGroup.make(
  Rpc.make("SignIn", {
    payload: { googleIdToken: Schema.NonEmptyString },
    success: Schema.Struct({
      sessionToken: Schema.RedactedFromValue(Schema.String),
      user: User
    }),
    error: Schema.Union([Unauthorized, NotInvited])
  }),
  /**
   * Sign in without Google, for development and end-to-end tests. Works only when the
   * deployment has a DEV_LOGIN_SECRET and `secret` matches it; otherwise Unauthorized.
   */
  Rpc.make("DevSignIn", {
    payload: {
      email: Schema.NonEmptyString,
      name: Schema.optionalKey(Schema.String),
      secret: Schema.RedactedFromValue(Schema.NonEmptyString)
    },
    success: Schema.Struct({ sessionToken: Schema.RedactedFromValue(Schema.String), user: User }),
    error: Schema.Union([Unauthorized, NotInvited])
  })
) {}

// ---------------------------------------------------------------------------
// Authenticated with the session token (AppAuth)
// ---------------------------------------------------------------------------

export class AuthedAppRpcs extends RpcGroup.make(
  Rpc.make("GetMe", { success: User }),

  // Devices and push --------------------------------------------------------
  /** Upsert this install. Call on launch and whenever a push token or the time zone changes. */
  Rpc.make("RegisterDevice", {
    payload: {
      deviceId: DeviceId,
      apnsToken: Schema.optionalKey(Schema.String),
      pushToStartToken: Schema.optionalKey(Schema.String),
      timeZone: TimeZone,
      appVersion: Schema.optionalKey(Schema.String)
    },
    success: Device
  }),
  Rpc.make("UnregisterDevice", { payload: { deviceId: DeviceId } }),
  /**
   * A Live Activity started on this device (usually by push-to-start); its
   * update token lets Dream update and end it.
   */
  Rpc.make("RegisterLiveActivity", {
    payload: {
      projectId: ProjectId,
      deviceId: DeviceId,
      activityId: Schema.NonEmptyString,
      pushToken: Schema.NonEmptyString
    },
    error: NotFound
  }),
  /** Which of these delivered notifications have been withdrawn and should be removed. Called when the app opens. */
  Rpc.make("FilterStaleNotifications", {
    payload: { notificationIds: Schema.Array(NotificationId) },
    success: Schema.Struct({ stale: Schema.Array(NotificationId) })
  }),

  // Home ---------------------------------------------------------------------
  Rpc.make("ListProjects", { success: Schema.Array(ProjectSummary) }),
  /** The needs-you deck: open questions and access requests across projects, oldest first. */
  Rpc.make("ListOpenAsks", { success: Schema.Array(OpenAsk) }),
  /**
   * Start a project from an idea. The idea becomes its first message and the
   * agent's first event. `harness` defaults to the one their connected
   * subscription runs. With a `requestId`, a retry returns the project the
   * first attempt created (`InvalidRequest` if that id belongs to someone else).
   */
  Rpc.make("CreateProject", {
    payload: {
      idea: Schema.NonEmptyString,
      harness: Schema.optionalKey(Harness),
      requestId: Schema.optionalKey(RequestId)
    },
    success: Project,
    error: Schema.Union([NoModelConnection, UpstreamFailure, InvalidRequest])
  }),

  // A project ----------------------------------------------------------------
  /**
   * A `wss://` URL for `ProjectLiveRpcs` with a short-lived ticket in the query
   * string (WebSocket clients can't set headers). Fetch a fresh one per connection.
   */
  Rpc.make("GetLiveUrl", {
    payload: { projectId: ProjectId },
    success: Schema.Struct({ url: Schema.String }),
    error: NotFound
  }),
  /** Older Chat history, newest first, before `before`. The live snapshot carries the recent messages. */
  Rpc.make("ListMessages", {
    payload: {
      projectId: ProjectId,
      before: Schema.optionalKey(MessageId),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })))
    },
    success: Schema.Struct({ messages: Schema.Array(Message), hasEarlier: Schema.Boolean }),
    error: NotFound
  }),
  /** Post their message to Chat. With a `requestId`, a retry returns the message the first attempt posted. */
  Rpc.make("SendMessage", {
    payload: { projectId: ProjectId, text: Schema.NonEmptyString, requestId: Schema.optionalKey(RequestId) },
    success: TextMessage,
    error: NotFound
  }),
  /**
   * Answer, or change an answer. Sending the answer it already has changes nothing (so a retry is safe).
   * Fails with `InvalidRequest` if the question was withdrawn or the option isn't one of its options.
   */
  Rpc.make("AnswerQuestion", {
    payload: { ...ProjectMessage, answer: QuestionAnswer },
    success: QuestionMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),

  // Access -------------------------------------------------------------------
  /**
   * Begin Google OAuth for an access request. Open `authorizeUrl` in an auth
   * session; Google returns to `Routes.googleOAuthCallback`, which finishes the
   * connection and redirects back into the app. The message updates over the live stream.
   */
  Rpc.make("StartGoogleAccess", {
    payload: ProjectMessage,
    success: Schema.Struct({ authorizeUrl: Schema.String }),
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /**
   * The key for a `Key` request, or for a `File` request, which Dream writes into that project's sandbox (and
   * no other) before the agent hears it's there. Submitting again for the same host, or the same project and
   * file name, replaces the key.
   */
  Rpc.make("SubmitKeyAccess", {
    payload: { ...ProjectMessage, key: Schema.RedactedFromValue(Schema.NonEmptyString) },
    success: AccessMessage,
    error: Schema.Union([NotFound, InvalidRequest, UpstreamFailure])
  }),
  Rpc.make("SubmitAppleAccess", {
    payload: {
      ...ProjectMessage,
      issuerId: Schema.NonEmptyString,
      keyId: Schema.NonEmptyString,
      /** Contents of the AuthKey_XXXX.p8 file. */
      privateKey: Schema.RedactedFromValue(Schema.NonEmptyString)
    },
    success: AccessMessage,
    error: Schema.Union([NotFound, InvalidRequest, UpstreamFailure])
  }),
  /** "Not now" on an access request. Declining one that's already declined returns it unchanged. */
  Rpc.make("DeclineAccess", {
    payload: ProjectMessage,
    success: AccessMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),

  // Settings -----------------------------------------------------------------
  Rpc.make("ListIntegrations", { success: Schema.Array(Integration) }),
  Rpc.make("DisconnectIntegration", {
    payload: { integrationId: IntegrationId },
    error: Schema.Union([NotFound, UpstreamFailure])
  }),
  Rpc.make("ListModelConnections", { success: Schema.Array(ModelConnection) }),
  /** Starts the provider's own sign-in in a short-lived auth sandbox. Takes a few seconds. */
  Rpc.make("StartModelConnection", {
    payload: { provider: ModelProvider },
    success: Schema.Struct({ connection: ModelConnection, flow: ModelConnectFlow }),
    error: UpstreamFailure
  }),
  /** Finish a `PasteCode` flow with the code Anthropic showed them. */
  Rpc.make("CompleteModelConnection", {
    payload: { connectionId: ModelConnectionId, code: Schema.RedactedFromValue(Schema.NonEmptyString) },
    success: ModelConnection,
    error: Schema.Union([NotFound, InvalidRequest, UpstreamFailure])
  }),
  /** Poll a `DeviceCode` flow until `status` is no longer "pending". */
  Rpc.make("GetModelConnection", {
    payload: { connectionId: ModelConnectionId },
    success: ModelConnection,
    error: NotFound
  }),
  Rpc.make("DisconnectModelConnection", {
    payload: { connectionId: ModelConnectionId },
    error: Schema.Union([NotFound, UpstreamFailure])
  }),
  /**
   * A one-time link (15 minutes) to a page where they paste a token they generated themselves (`claude setup-token`).
   * Open it in a browser; when they submit, the connection is stored like one from `StartModelConnection`.
   */
  Rpc.make("CreateConnectLink", {
    payload: { provider: ConnectLinkProvider },
    success: ConnectLink
  })
).middleware(AppAuth) {}

/** The whole phone ↔ API surface, served at `Routes.app`. */
export class AppRpcs extends PublicAppRpcs.merge(AuthedAppRpcs) {}
