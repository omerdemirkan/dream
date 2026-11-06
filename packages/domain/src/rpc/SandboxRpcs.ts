/**
 * Sandbox → API: everything the `dream` CLI does, plus what dreamd reports.
 *
 * The CLI sends these to dreamd over its Unix socket; dreamd forwards them to
 * `Routes.sandbox` with the project token (`SandboxAuth`). The project is
 * implied by the token, so payloads carry no project id.
 *
 * Each RPC notes the command it backs. Commands print their result as text by
 * default and as JSON with `--json`.
 *
 * The calls that put text in front of them (messages, questions, access
 * requests, the Status card, Live Activities) and scheduled wakes fail with
 * `InvalidRequest` when the text contains one of the project's file keys.
 */
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { SandboxAuth } from "../Auth.ts"
import { Integration } from "../Connections.ts"
import { InvalidRequest, NotFound, UpstreamFailure } from "../Errors.ts"
import { BrowserSessionId, EventId, MediaId, MessageId, NotificationId, WakeId } from "../Ids.ts"
import { LiveActivityContent } from "../LiveActivity.ts"
import { BrowserSession, MacSshAccess, MacStatus } from "../Machines.ts"
import { MediaContentType, MediaRef, MediaUploadTarget } from "../Media.ts"
import { AccessMessage, AccessRequest, QuestionMessage, TextMessage } from "../Message.ts"
import { ProjectPhase } from "../Project.ts"
import { Milestone, StatusCard } from "../Status.ts"
import { UsageSnapshot } from "../Usage.ts"
import { Wake, WakeWhen } from "../Wake.ts"

/** Absent leaves a field as it is; `null` clears it. */
const Patch = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

export class SandboxRpcs extends RpcGroup.make(
  // Talking to them ------------------------------------------------------------
  /** `dream message [--notify] [--media file…] "text"`. The CLI uploads each file first (`CreateMediaUpload`). */
  Rpc.make("SendMessage", {
    payload: {
      text: Schema.NonEmptyString,
      media: Schema.Array(MediaId),
      notify: Schema.Boolean
    },
    success: TextMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /** `dream ask "question" --option "…" … [--why "…"] [--context "…"] [--meanwhile "…"]`. Always notifies. */
  Rpc.make("AskQuestion", {
    payload: {
      question: Schema.NonEmptyString,
      options: Schema.Array(Schema.NonEmptyString),
      why: Schema.optionalKey(Schema.String),
      /** Added after the first release; an older API ignores it. */
      context: Schema.optionalKey(Schema.String),
      meanwhile: Schema.optionalKey(Schema.String)
    },
    success: QuestionMessage,
    error: InvalidRequest
  }),
  /** `dream ask withdraw <message-id>`: the answer is no longer needed. Also withdraws its notification. */
  Rpc.make("WithdrawQuestion", {
    payload: { messageId: MessageId },
    success: QuestionMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /**
   * `dream access google|key|file|apple|oauth … --why "…" [--context "…"] [--when "…"]`. Notifies unless `when` is set.
   * `InvalidRequest` when a key's host can't be an egress target (`accessHostProblem`), a file key's name isn't
   * a plain file name (`keyFileNameProblem`), or for `oauth` when Dream doesn't know the provider or it isn't set
   * up on this deployment.
   */
  Rpc.make("RequestAccess", {
    payload: {
      request: AccessRequest,
      why: Schema.NonEmptyString,
      /** Added after the first release; an older API ignores it. */
      context: Schema.optionalKey(Schema.String),
      when: Schema.optionalKey(Schema.String)
    },
    success: AccessMessage,
    error: InvalidRequest
  }),
  /** `dream access list`: what works here, meaning their shared integrations and this project's file keys. */
  Rpc.make("ListAccess", { success: Schema.Array(Integration) }),
  /** `dream notify withdraw <notification-id>`. */
  Rpc.make("WithdrawNotification", {
    payload: { notificationId: NotificationId },
    error: NotFound
  }),

  // Status ---------------------------------------------------------------------
  /** `dream status` with no flags prints the card. */
  Rpc.make("GetStatus", { success: StatusCard }),
  /**
   * `dream status [--phase …] [--title …] [--kind …] [--icon …] [--now …]
   * [--just-did …] [--next …] [--media file…] [--milestones milestones.json]`.
   * `--now ""` clears a line. `milestones` replaces the whole list.
   * Title, kind and icon describe the project on Home.
   */
  Rpc.make("UpdateStatus", {
    payload: {
      phase: Schema.optionalKey(ProjectPhase),
      title: Schema.optionalKey(Schema.NonEmptyString),
      kind: Patch(Schema.String),
      icon: Patch(Schema.String),
      now: Patch(Schema.String),
      justDid: Patch(Schema.String),
      next: Patch(Schema.String),
      media: Schema.optionalKey(Schema.Array(MediaId)),
      milestones: Schema.optionalKey(Schema.Array(Milestone))
    },
    success: StatusCard,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /** `dream live start` (replaces any running activity), on their devices that support it. */
  Rpc.make("StartLiveActivity", {
    payload: { content: LiveActivityContent },
    error: Schema.Union([InvalidRequest, UpstreamFailure])
  }),
  /** `dream live update`. */
  Rpc.make("UpdateLiveActivity", {
    payload: { content: LiveActivityContent },
    error: Schema.Union([InvalidRequest, UpstreamFailure])
  }),
  /** `dream live end`, optionally showing final content until iOS dismisses it. */
  Rpc.make("EndLiveActivity", {
    payload: { content: Schema.optionalKey(LiveActivityContent) },
    error: Schema.Union([InvalidRequest, UpstreamFailure])
  }),

  // Waking -----------------------------------------------------------------------
  /** `dream wake --at <time>|--cron "<expr>" [--run "<command>"] "why"`. */
  Rpc.make("ScheduleWake", {
    payload: { when: WakeWhen, why: Schema.NonEmptyString, run: Schema.optionalKey(Schema.NonEmptyString) },
    success: Wake,
    error: InvalidRequest
  }),
  /** `dream wake list`. */
  Rpc.make("ListWakes", { success: Schema.Array(Wake) }),
  /** `dream wake cancel <wake-id>`. */
  Rpc.make("CancelWake", { payload: { wakeId: WakeId }, error: NotFound }),
  /** `dream wake "why"` with no schedule: wake the agent now (from an app's error handler, say). */
  Rpc.make("WakeNow", { payload: { why: Schema.NonEmptyString } }),

  // Hosting ------------------------------------------------------------------------
  /** `dream publish --port <port>`: points the project's public URL at the port. */
  Rpc.make("Publish", {
    payload: { port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })) },
    success: Schema.Struct({ url: Schema.String }),
    error: InvalidRequest
  }),

  // Media ----------------------------------------------------------------------------
  /** `dream media upload <file>`: reserve a media id, then PUT the bytes to `upload`. */
  Rpc.make("CreateMediaUpload", {
    payload: {
      filename: Schema.NonEmptyString,
      contentType: MediaContentType,
      sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      caption: Schema.optionalKey(Schema.String)
    },
    success: Schema.Struct({ media: MediaRef, upload: MediaUploadTarget }),
    error: InvalidRequest
  }),

  // Beyond the sandbox ------------------------------------------------------------------
  /** `dream browser`: a recorded Browserbase session. */
  Rpc.make("StartBrowser", { success: BrowserSession, error: UpstreamFailure }),
  /** `dream browser stop <id>`. Closing the CDP connection also ends it. */
  Rpc.make("StopBrowser", {
    payload: { sessionId: BrowserSessionId },
    error: Schema.Union([NotFound, UpstreamFailure])
  }),
  /** `dream browser recording <id>`: a short-lived download URL for the session recording. */
  Rpc.make("GetBrowserRecording", {
    payload: { sessionId: BrowserSessionId },
    success: Schema.Struct({ url: Schema.String, contentType: Schema.String }),
    error: Schema.Union([NotFound, InvalidRequest, UpstreamFailure])
  }),
  /** `dream mac start`. Returns once the Mac is running. */
  Rpc.make("StartMac", { success: MacStatus, error: UpstreamFailure }),
  /** `dream mac` with no subcommand. */
  Rpc.make("GetMac", { success: MacStatus }),
  /** `dream mac ssh -- <cmd>`: fresh short-lived credentials for each session. */
  Rpc.make("GetMacSsh", { success: MacSshAccess, error: Schema.Union([InvalidRequest, UpstreamFailure]) }),
  /** `dream mac stop`. */
  Rpc.make("StopMac", { error: UpstreamFailure }),

  // Usage ------------------------------------------------------------------------------
  /** `dream usage`. */
  Rpc.make("GetUsage", { success: UsageSnapshot, error: NotFound }),

  // Reported by dreamd, not the CLI ----------------------------------------------------
  /** After each turn and whenever the harness reports rate limits. With `limitedUntil`, Dream pauses the project and wakes the agent at reset. */
  Rpc.make("ReportUsage", { payload: { usage: UsageSnapshot } }),
  /** A turn started or finished, with the events it consumed. Drives the "working" state on the phone. */
  Rpc.make("ReportTurn", {
    payload: { state: Schema.Literals(["started", "finished"]), eventIds: Schema.Array(EventId) }
  })
).middleware(SandboxAuth) {}
