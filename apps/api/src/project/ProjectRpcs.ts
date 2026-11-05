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
  /** The access request, if it's still open (for StartGoogleAccess and the paste flows). */
  Rpc.make("GetOpenAccess", {
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
  /** Their credentials or integrations changed: refresh this sandbox's egress rules. */
  Rpc.make("CredentialsChanged", {}),
  /** Their subscription hit a limit in another project; hold this one until it resets. */
  Rpc.make("UsageLimited", { payload: { window: UsageWindowName, until: Schema.DateTimeUtc } }),
  /** Where the gateway sends this project's public traffic. */
  Rpc.make("GatewayTarget", { success: GatewayTarget, error: Schema.Union([NotFound, UpstreamFailure]) }),
  /** Refresh their ChatGPT tokens now and push them to every sandbox of theirs. */
  Rpc.make("RefreshModelCredential", { error: UpstreamFailure }),
  /** Stops the project for good: kills its sandbox and drops its wakes and undelivered events. */
  Rpc.make("Archive", {})
) {}
