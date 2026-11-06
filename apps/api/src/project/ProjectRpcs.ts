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
  DeviceId,
  Integration,
  InvalidRequest,
  Message,
  MessageId,
  NotFound,
  Project,
  QuestionAnswer,
  QuestionMessage,
  TextMessage,
  UpstreamFailure,
  UsageWindowName
} from "@dream/domain"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

export const InternalRpcPath = "/internal/rpc"
export const LivePath = "/live"

export const GatewayTarget = Schema.Struct({
  /** `https://<port>-<sandbox>.<domain>` */
  origin: Schema.String,
  trafficAccessToken: Schema.String
})
export type GatewayTarget = typeof GatewayTarget.Type

export class ProjectRpcs extends RpcGroup.make(
  /** Called once by CreateProject: stores the project, adds the idea as the first message and wakes the agent. */
  Rpc.make("Init", { payload: { project: Project }, success: Project }),
  Rpc.make("GetProject", { success: Project, error: NotFound }),
  Rpc.make("ListMessages", {
    payload: { before: Schema.optionalKey(MessageId), limit: Schema.Int },
    success: Schema.Struct({ messages: Schema.Array(Message), hasEarlier: Schema.Boolean })
  }),
  /** With an `id` (derived from the phone's request id), posting it again returns the message already posted. */
  Rpc.make("SendUserMessage", {
    payload: { text: Schema.NonEmptyString, id: Schema.optionalKey(MessageId) },
    success: TextMessage
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
    payload: { messageId: MessageId },
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
   * Destroys the project, for the operator's cleanup (`/admin/projects/:id/archive`): kills its sandbox, deletes its
   * file keys, drops its wakes and undelivered events, and removes it from Home. There's no undoing it, so the phone
   * never reaches it.
   */
  Rpc.make("Retire", {})
) {}
