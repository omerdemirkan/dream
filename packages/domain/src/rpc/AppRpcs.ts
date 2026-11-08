/**
 * Phone → API over HTTP (`Routes.app`). Everything the app does except the
 * live project stream, which is `ProjectLiveRpcs`.
 */
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { AppDelivery, AppNotifications, AppSender } from "../AppNotifications.ts"
import { AppAuth } from "../Auth.ts"
import { ConnectLink, ConnectLinkProvider, Integration, ModelConnectFlow, ModelConnection } from "../Connections.ts"
import { InvalidRequest, NoModelConnection, NotFound, NotInvited, Unauthorized, UpstreamFailure } from "../Errors.ts"
import {
  AppId,
  DeviceId,
  IntegrationId,
  LinkId,
  MediaId,
  MessageId,
  ModelConnectionId,
  NotificationId,
  ProjectId,
  RequestId,
  WorkstreamId
} from "../Ids.ts"
import { AppLink, LinkColor, LinkIcon, LinkTitle, LinkUrl } from "../Links.ts"
import {
  AccessMessage,
  AskMessage,
  DeclineReason,
  Message,
  QuestionAnswer,
  QuestionMessage,
  TextMessage
} from "../Message.ts"
import { Attachment, AttachmentContentType, AttachmentLimits, MediaUploadTarget } from "../Media.ts"
import { ArchivedProject, Harness, Project, ProjectSummary } from "../Project.ts"
import { AccountCosts, ProjectCosts } from "../Costs.ts"
import { AccountUsage, ModelProvider, ProjectUsage, UsageLimits } from "../Usage.ts"
import { Device, Features, TimeZone, User } from "../User.ts"

/** An open question or access request for the Home deck, with the project it belongs to. */
export const OpenAsk = Schema.Struct({
  project: Project,
  message: AskMessage
})
export type OpenAsk = typeof OpenAsk.Type

const ProjectMessage = { projectId: ProjectId, messageId: MessageId }

/** Ids of uploaded attachments, as `SendMessage` and `CreateProject` take them. */
const Attachments = Schema.Array(MediaId).check(Schema.isMaxLength(AttachmentLimits.perMessage))

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
  /** What this deployment can do (`Features`). Fetched at launch; older APIs don't have it, which means nothing extra. */
  Rpc.make("GetFeatures", { success: Features }),

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
  /**
   * Open questions and access requests across projects, oldest first. Current builds don't call it (Home shows
   * which projects need them from `ListProjects`); it stays for older builds' needs-you deck.
   */
  Rpc.make("ListOpenAsks", { success: Schema.Array(OpenAsk) }),
  /**
   * Start a project from an idea. The idea becomes its first message and the
   * agent's first event. `harness` defaults to the one their connected
   * subscription runs; with both connected, to their newest project's (the new-idea picker sends it). With a `requestId`, a retry returns the project the
   * first attempt created (`InvalidRequest` if that id belongs to someone else). `attachments` (November 2026):
   * uploads from `CreateAttachmentUpload` that go with the idea.
   */
  Rpc.make("CreateProject", {
    payload: {
      idea: Schema.NonEmptyString,
      harness: Schema.optionalKey(Harness),
      requestId: Schema.optionalKey(RequestId),
      attachments: Schema.optionalKey(Attachments)
    },
    success: Project,
    error: Schema.Union([NoModelConnection, UpstreamFailure, InvalidRequest])
  }),
  /**
   * Put a project away: it leaves Home and the deck, its agent stops (nothing is delivered, wakes wait, a turn in
   * progress is paused with the sandbox), its Live Activity ends and its published URL stops serving. Nothing is
   * deleted. Archiving an
   * archived project returns it as it is.
   */
  Rpc.make("ArchiveProject", {
    payload: { projectId: ProjectId },
    success: ArchivedProject,
    error: NotFound
  }),
  /**
   * Bring an archived project back as it was: on Home again, its agent picking up what was waiting (a paused turn
   * starts over, wakes that came due while it was archived fire once). Restoring one that isn't archived returns
   * its Home row.
   */
  Rpc.make("RestoreProject", {
    payload: { projectId: ProjectId },
    success: ProjectSummary,
    error: NotFound
  }),
  /**
   * Delete a project for good, archived or not: its sandbox (code and app), chat, status, published link, media and
   * the file keys only it had. Connections their other projects share stay. Its notifications are withdrawn and its
   * Live Activity ends. There's no undo. Deleting one that's already gone is `NotFound`.
   */
  Rpc.make("DeleteProject", {
    payload: { projectId: ProjectId },
    error: NotFound
  }),
  /** Their archived projects for Settings, most recently archived first. */
  Rpc.make("ListArchivedProjects", { success: Schema.Array(ArchivedProject) }),

  // App links on Home -------------------------------------------------------------
  /**
   * The row of app icons at the top of Home, oldest first. Links of archived projects are left out until they're
   * restored. Added after the first release.
   */
  Rpc.make("ListLinks", { success: Schema.Array(AppLink) }),
  /**
   * The agents' links they removed from Home, most recently removed first, each with `removedAt`. The add sheet
   * offers them back (`RestoreLink`). Links of archived projects are left out. Added when hand-added links went.
   */
  Rpc.make("ListRemovedLinks", { success: Schema.Array(AppLink) }),
  /**
   * Put an agent's link they removed back on Home, in its old place, with what they changed on it still theirs.
   * Its agent can change it again. Added when hand-added links went.
   */
  Rpc.make("RestoreLink", { payload: { linkId: LinkId }, success: AppLink, error: NotFound }),
  /**
   * Deprecated: Home holds only what their projects' agents make, so this always fails with `InvalidRequest`
   * saying so. Builds from before `RestoreLink` still call it from their add sheet. Links they added before keep
   * working, and `UpdateLink` and `RemoveLink` take them as before.
   */
  Rpc.make("AddLink", {
    payload: {
      url: LinkUrl,
      title: LinkTitle,
      icon: Schema.optionalKey(LinkIcon),
      color: LinkColor,
      requestId: Schema.optionalKey(RequestId)
    },
    success: AppLink,
    error: InvalidRequest
  }),
  /**
   * Rename or re-icon a link (absent leaves a field; `icon: null` makes it a monogram). On an agent's link the
   * change becomes theirs and the agent hears about it (`AgentEvent.LinkEdited`).
   */
  Rpc.make("UpdateLink", {
    payload: {
      linkId: LinkId,
      title: Schema.optionalKey(LinkTitle),
      icon: Schema.optionalKey(Schema.NullOr(LinkIcon)),
      color: Schema.optionalKey(LinkColor)
    },
    success: AppLink,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /** Take a link off Home. An agent's link stays off: its agent hears, and can't add that URL again. */
  Rpc.make("RemoveLink", { payload: { linkId: LinkId }, error: NotFound }),
  /** They opened it from Home: an agent's new link loses its dot. */
  Rpc.make("MarkLinkOpened", { payload: { linkId: LinkId }, error: NotFound }),
  /**
   * Before opening a link in Safari to add it to their Home Screen, or when they share it. `iconPng` is the tile as
   * the phone draws it (base64 png, square), which the gateway serves as the app's icon and its link preview's image;
   * an image icon needs none. Returns the URL to open: on a published app, one that shows Safari's steps once.
   */
  Rpc.make("PrepareHomeScreen", {
    payload: {
      linkId: LinkId,
      iconPng: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_000_000)))
    },
    success: Schema.Struct({ url: Schema.String }),
    error: Schema.Union([NotFound, InvalidRequest])
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
  /**
   * The usage sheet: this project's tokens today, in the five-hour window and this week, its estimated share of
   * each window, and every project's share of the week. The header's figures come live as `ProjectEvent.Usage`.
   */
  Rpc.make("GetProjectUsage", {
    payload: { projectId: ProjectId },
    success: ProjectUsage,
    error: NotFound
  }),
  /**
   * Set this project's usage limits, both at once: a key that's absent clears that limit. The agent hears of the
   * change, a limit reached pauses the project, and one raised or cleared lets it go on. Returns the usage sheet as
   * it is now. Added November 2026.
   */
  Rpc.make("SetUsageLimits", {
    payload: { projectId: ProjectId, limits: UsageLimits },
    success: ProjectUsage,
    error: NotFound
  }),
  /**
   * Settings' plan card: how full each window of their `provider` subscription is, about how much of it their
   * projects used together, and each project's share of the week. Fails with `NotFound` when that subscription
   * isn't connected. Phones fall back to the connection's `usage` without project shares when an API lacks it.
   */
  Rpc.make("GetAccountUsage", {
    payload: { provider: ModelProvider },
    success: AccountUsage,
    error: NotFound
  }),
  /**
   * What Dream paid to run this project, this month and last, by cost center (sandbox time, browsers, Macs, OpenAI
   * through Dream's gateway, storage, email), and each of the last 30 days. Estimates at list prices; separate from
   * their subscription's usage. Added November 2026.
   */
  Rpc.make("GetProjectCosts", {
    payload: { projectId: ProjectId },
    success: ProjectCosts,
    error: NotFound
  }),
  /**
   * What Dream paid for all their projects, this month and last, with each project's share; for an operator, also
   * everyone's (`everyone`). Added November 2026.
   */
  Rpc.make("GetAccountCosts", { success: AccountCosts }),
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
  /**
   * A thread (`Thread.ts`): its first message and every reply, oldest first, for opening one whose first message is
   * older than the Chat loaded (from a notification, say). Added in November 2026. `NotFound` for a message the
   * project doesn't have; for a reply, the thread it's in.
   */
  Rpc.make("ListThread", {
    payload: ProjectMessage,
    success: Schema.Struct({ root: Message, replies: Schema.Array(Message) }),
    error: NotFound
  }),
  /**
   * Post their message to Chat. With a `requestId`, a retry returns the message the first attempt posted. With a
   * `workstream` (added in November 2026), they wrote it into that workstream; one the project doesn't have is
   * ignored. `attachments` (November 2026): uploads from `CreateAttachmentUpload` that go with it, in order; with
   * some, `text` may be empty. `InvalidRequest` for an empty message, or an attachment that isn't theirs, wasn't
   * uploaded, or went with another message. With `replyTo` (November 2026), they wrote it in that message's thread
   * (`Thread.ts`), and it goes into that message's workstream; a reply to a reply goes into the same thread, and one
   * to a message the project doesn't have is `NotFound`.
   */
  Rpc.make("SendMessage", {
    payload: {
      projectId: ProjectId,
      text: Schema.String,
      requestId: Schema.optionalKey(RequestId),
      workstream: Schema.optionalKey(WorkstreamId),
      replyTo: Schema.optionalKey(MessageId),
      attachments: Schema.optionalKey(Attachments)
    },
    success: TextMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /**
   * Start uploading a photo or file they're attaching (added in November 2026): send the bytes as `upload` says, then
   * pass the attachment's id to `SendMessage` or `CreateProject`. The name is made safe for a path (the returned
   * attachment has the one Dream uses). `InvalidRequest` when it's larger than `AttachmentLimits.maxBytes` or
   * storage isn't on.
   */
  Rpc.make("CreateAttachmentUpload", {
    payload: {
      name: Schema.NonEmptyString,
      contentType: AttachmentContentType,
      sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      width: Schema.optionalKey(Schema.Int),
      height: Schema.optionalKey(Schema.Int)
    },
    success: Schema.Struct({ attachment: Attachment, upload: MediaUploadTarget }),
    error: InvalidRequest
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
   * Works for open, declined and disconnected requests; `InvalidRequest` for a connected one.
   */
  Rpc.make("StartGoogleAccess", {
    payload: ProjectMessage,
    success: Schema.Struct({ authorizeUrl: Schema.String }),
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /**
   * Begin an OAuth sign-in for an `OAuth` access request, like `StartGoogleAccess`: open `authorizeUrl` in an auth
   * session; the provider returns to `Routes.oauthCallback(provider)`, which finishes the connection and redirects to
   * `<app scheme>://oauth/<provider>?status=connected|error&projectId=…&messageId=…[&error=…]`.
   * `UpstreamFailure` when the provider isn't set up on this deployment.
   */
  Rpc.make("StartOAuthAccess", {
    payload: ProjectMessage,
    success: Schema.Struct({ authorizeUrl: Schema.String }),
    error: Schema.Union([NotFound, InvalidRequest, UpstreamFailure])
  }),
  /**
   * The key for a `Key` request, or for a `File` request, which Dream writes into that project's sandbox (and
   * no other) before the agent hears it's there. Submitting again for the same host, or the same project and
   * file name, replaces the key. Open, declined and disconnected requests take a key; one that's connected
   * already returns as it is, so retrying a submission that went through is safe (as for `SubmitAppleAccess`).
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
  /**
   * "Don't connect" on an access request, with why if they said (older apps send no `reason`). Declining one
   * that's already declined returns it unchanged.
   */
  Rpc.make("DeclineAccess", {
    payload: { ...ProjectMessage, reason: Schema.optionalKey(DeclineReason) },
    success: AccessMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),

  /**
   * "Email it to me": emails them a link to finish this access request on a computer, at the address on file from
   * their sign-in, and returns the card with `desktop` set. Nothing is sent unless they ask. The link works once,
   * for 30 minutes, in one browser, and only while the request still waits (`canFinishOnDesktop`); sending again
   * replaces it. `InvalidRequest` for a request that can't be finished there or after too many sends.
   */
  Rpc.make("EmailAccessLink", {
    payload: ProjectMessage,
    success: AccessMessage,
    error: Schema.Union([NotFound, InvalidRequest, UpstreamFailure])
  }),

  // Notifications from a project's apps ---------------------------------------
  /** A project's apps that notify, with their controls, and the last 30 days of what they sent. */
  Rpc.make("GetAppNotifications", {
    payload: { projectId: ProjectId },
    success: AppNotifications,
    error: NotFound
  }),
  /**
   * "Allow" on a `Notifications` card (open, or declined earlier). Allowing an allowed one returns it unchanged.
   * "Not now" is `DeclineAccess`.
   */
  Rpc.make("AllowAppNotifications", {
    payload: ProjectMessage,
    success: AccessMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /**
   * How one app's notifications reach them: Immediately, Quietly or Off, and Mute until a time (`null` unmutes).
   * From the Notifications sheet and the notification's own actions. `InvalidRequest` for an app they haven't allowed.
   */
  Rpc.make("UpdateAppNotifications", {
    payload: {
      projectId: ProjectId,
      app: AppId,
      delivery: Schema.optionalKey(AppDelivery),
      mutedUntil: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtc))
    },
    success: AppSender,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /** They opened an app's notification, from the lock screen or the history, so the agent can see what gets read. */
  Rpc.make("OpenedAppNotification", {
    payload: { projectId: ProjectId, notificationId: NotificationId },
    error: NotFound
  }),

  // Settings -----------------------------------------------------------------
  Rpc.make("ListIntegrations", { success: Schema.Array(Integration) }),
  /**
   * A new key for a pasted `Key` integration or a `File` key, from Settings (a rotated key, a new bot token).
   * A header key changes in every sandbox's egress rules; a file key's project rewrites its file and tells the
   * agent. `InvalidRequest` for any other kind of integration.
   */
  Rpc.make("ReplaceKey", {
    payload: { integrationId: IntegrationId, key: Schema.RedactedFromValue(Schema.NonEmptyString) },
    success: Integration,
    error: Schema.Union([NotFound, InvalidRequest, UpstreamFailure])
  }),
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
