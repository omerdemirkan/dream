/**
 * Worker → ProjectDO, over HTTP on the DO's `fetch` at `InternalRpcPath`.
 * The phone's WebSocket is attached to a separate server that only knows
 * `ProjectLiveRpcs`, so nothing here is reachable from the phone.
 *
 * The DO also serves `SandboxRpcs` on the same path: the Worker authenticates
 * dreamd's project token and forwards each call unchanged. These shapes are
 * internal to the control plane, built from @dream/domain types.
 */
import {
  AccessMessage,
  AppDelivery,
  AppId,
  AppNotifications,
  AppSender,
  Attachment,
  DeclineReason,
  DeviceId,
  NotificationId,
  Integration,
  InvalidRequest,
  LinkId,
  Message,
  MessageId,
  NotFound,
  Project,
  QuestionAnswer,
  RelayForward,
  RelayForwardResult,
  RelayId,
  QuestionMessage,
  TextMessage,
  UpstreamFailure,
  UsageWindowName,
  WorkstreamId
} from "@dream/domain"
import { Redacted, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export const InternalRpcPath = "/internal/rpc"
export const LivePath = "/live"

export const GatewayTarget = Schema.Struct({
  /** `https://<port>-<sandbox>.<domain>` */
  origin: Schema.String,
  trafficAccessToken: Schema.String
})
export type GatewayTarget = typeof GatewayTarget.Type

/** A relay's key, decrypted for its RelayDO: the integration's value and how it's sent. */
export const RelayCredential = Schema.Struct({
  key: Schema.RedactedFromValue(Schema.String),
  host: Schema.String,
  header: Schema.String,
  format: Schema.String
})
export type RelayCredential = typeof RelayCredential.Type

/** The header a `Key` integration's request carries, as Dream's egress rules write it. */
export const credentialHeader = (credential: RelayCredential): readonly [string, string] => [
  credential.header,
  credential.format.replaceAll("{key}", Redacted.value(credential.key))
]

export class ProjectRpcs extends RpcGroup.make(
  /** Called once by CreateProject: stores the project, adds the idea as the first message and wakes the agent. */
  Rpc.make("Init", {
    payload: { project: Project, attachments: Schema.optionalKey(Schema.Array(Attachment)) },
    success: Project
  }),
  Rpc.make("GetProject", { success: Project, error: NotFound }),
  Rpc.make("ListMessages", {
    payload: { before: Schema.optionalKey(MessageId), limit: Schema.Int },
    success: Schema.Struct({ messages: Schema.Array(Message), hasEarlier: Schema.Boolean })
  }),
  /**
   * With an `id` (derived from the phone's request id), posting it again returns the message already posted. With a
   * `workstream` the project has, they wrote it into that one. With `replyTo`, they wrote it in that message's
   * thread, and it goes into that message's workstream instead.
   */
  Rpc.make("SendUserMessage", {
    payload: {
      /** Empty only with attachments (the Worker checks). */
      text: Schema.String,
      attachments: Schema.optionalKey(Schema.Array(Attachment)),
      id: Schema.optionalKey(MessageId),
      workstream: Schema.optionalKey(WorkstreamId),
      replyTo: Schema.optionalKey(MessageId)
    },
    success: TextMessage,
    error: NotFound
  }),
  /** A thread: its first message and its replies (`AppRpcs.ListThread`). */
  Rpc.make("ListThread", {
    payload: { messageId: MessageId },
    success: Schema.Struct({ root: Message, replies: Schema.Array(Message) }),
    error: NotFound
  }),
  Rpc.make("AnswerQuestion", {
    payload: { messageId: MessageId, answer: QuestionAnswer },
    success: QuestionMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /** An access request in whatever state it's in (for StartGoogleAccess and the paste flows, which decide). */
  Rpc.make("GetAccess", {
    payload: { messageId: MessageId },
    success: AccessMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  Rpc.make("AccessConnected", {
    payload: { messageId: MessageId, integration: Integration },
    success: AccessMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  Rpc.make("DeclineAccess", {
    payload: { messageId: MessageId, reason: Schema.optionalKey(DeclineReason) },
    success: AccessMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  Rpc.make("RegisterLiveActivity", {
    payload: { deviceId: DeviceId, activityId: Schema.NonEmptyString, pushToken: Schema.NonEmptyString }
  }),
  /**
   * One of their integrations is gone: they removed it (its row is gone), or it stopped working (`failure` says
   * how). Cards connected to it say so, the sandbox loses it (a file key's file, or its egress rules), and the agent
   * hears if this project asked for it. Sent to every project of theirs, but only the file key's own for a file key.
   */
  Rpc.make("IntegrationGone", { payload: { integration: Integration, failure: Schema.optionalKey(Schema.String) } }),
  /**
   * An integration that had stopped working is connected again: cards it disconnected are connected again, and with
   * `tell` the agent hears (the project whose card was answered hears through that card instead).
   */
  Rpc.make("IntegrationRestored", { payload: { integration: Integration, tell: Schema.Boolean } }),
  /** They entered a new key for one of this project's file keys: rewrite the file, and tell the agent. */
  Rpc.make("KeyFileReplaced", { payload: { integration: Integration } }),
  /** Their credentials or integrations changed: refresh this sandbox's egress rules. */
  Rpc.make("CredentialsChanged", {}),
  /** Their subscription hit a limit in another project; hold this one until it resets. */
  Rpc.make("UsageLimited", { payload: { window: UsageWindowName, until: Schema.DateTimeUtc } }),
  /** Where the gateway sends this project's public traffic. */
  Rpc.make("GatewayTarget", { success: GatewayTarget, error: Schema.Union([NotFound, UpstreamFailure]) }),
  /** Refresh their ChatGPT tokens now and push them to every sandbox of theirs. */
  Rpc.make("RefreshModelCredential", { error: UpstreamFailure }),
  /**
   * Deletes the project for good (`DeleteProject`, and the operator's `/admin/projects/:id/archive`): kills its
   * sandbox and any Mac, withdraws its notifications and ends its Live Activity, deletes its file keys and its Home
   * row, and empties this DO but for a tombstone, so nothing late (an alarm, a delivery under way, dreamd) brings
   * any of it back. Its media in R2 is the Worker's to remove.
   */
  Rpc.make("Delete", {}),
  /**
   * They archived the project (`ArchiveProject`): hold the agent and pause the sandbox, keeping everything. Returns
   * when it was archived (the first time, for a repeat).
   */
  Rpc.make("Archive", { success: Schema.DateTimeUtc }),
  /** They restored it (`RestoreProject`): the agent goes on with what was waiting. Nothing for one that isn't archived. */
  Rpc.make("Restore", {}),
  // From the project's RelayDOs. `NotFound` means the relay is no longer this project's to hold (it was removed, or
  // the project archived or deleted): the RelayDO closes its line and forgets everything.
  /** Hand a relay's events to dreamd, which posts them to the app. Failures come back in the result, to retry. */
  Rpc.make("RelayDeliver", {
    payload: { relayId: RelayId, deliveries: Schema.NonEmptyArray(RelayForward) },
    success: RelayForwardResult,
    error: NotFound
  }),
  /** The relay's key, decrypted. `InvalidRequest` when it's gone, failed, or no longer fits the relay. */
  Rpc.make("RelayCredential", {
    payload: { relayId: RelayId },
    success: RelayCredential,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /** Something about the relay the agent should hear (it stopped, or the app hasn't taken events for an hour). */
  Rpc.make("RelayAlert", { payload: { relayId: RelayId, reason: Schema.NonEmptyString }, error: NotFound }),
  /** Whether the relay is still this project's to hold; asked now and then by a line that's been quiet. */
  Rpc.make("RelayActive", { payload: { relayId: RelayId }, success: Schema.Boolean }),
  // Notifications from the project's apps, for the phone (`AppRpcs` of the same names).
  Rpc.make("GetAppNotifications", { success: AppNotifications }),
  Rpc.make("AllowAppNotifications", {
    payload: { messageId: MessageId },
    success: AccessMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  Rpc.make("UpdateAppNotifications", {
    payload: {
      app: AppId,
      delivery: Schema.optionalKey(AppDelivery),
      mutedUntil: Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtc))
    },
    success: AppSender,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  Rpc.make("OpenedAppNotification", { payload: { notificationId: NotificationId }, error: NotFound }),
  /** They renamed, re-iconed or removed one of the agent's app links: tell the agent (`AgentEvent.LinkEdited`). */
  Rpc.make("LinkEdited", {
    payload: {
      linkId: LinkId,
      url: Schema.String,
      title: Schema.String,
      change: Schema.Literals(["renamed", "icon", "removed"]),
      previousTitle: Schema.optionalKey(Schema.String),
      tile: Schema.optionalKey(Schema.String)
    }
  })
) {}
