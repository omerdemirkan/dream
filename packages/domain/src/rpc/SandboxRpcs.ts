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
import {
  AppName,
  AppNotification,
  AppNotificationKey,
  AppNotifications,
  AppNotificationText,
  AppNotificationTitle,
  AppSender
} from "../AppNotifications.ts"
import { SandboxAuth } from "../Auth.ts"
import { Integration } from "../Connections.ts"
import { InvalidRequest, NotFound, UpstreamFailure } from "../Errors.ts"
import {
  AppId,
  BrowserSessionId,
  EventId,
  LinkId,
  MediaId,
  MessageId,
  NotificationId,
  RelayId,
  WakeId,
  WorkstreamId
} from "../Ids.ts"
import { AppLink, LinkColor, LinkIcon, LinkTitle, LinkUrl } from "../Links.ts"
import { LiveActivityContent } from "../LiveActivity.ts"
import { BrowserSession, MacSshAccess, MacStatus } from "../Machines.ts"
import { MediaContentType, MediaRef, MediaUploadTarget } from "../Media.ts"
import { AccessMessage, AccessRequest, Message, QuestionMessage, TextMessage } from "../Message.ts"
import { ProjectPhase } from "../Project.ts"
import { Relay, RelaySource, RelayTarget } from "../Relay.ts"
import { Milestone, StatusCard } from "../Status.ts"
import { TurnUsage, UsageSnapshot } from "../Usage.ts"
import { Wake, WakeWhen } from "../Wake.ts"
import { Workstreams, WorkstreamTitle } from "../Workstream.ts"

/** Absent leaves a field as it is; `null` clears it. */
const Patch = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

/**
 * A link as `dream link` shows it, with the project name its long-press menu shows ("Made by …") and the project's
 * public URL (only links there get Dream's name and icon when added to their iPhone's Home Screen).
 */
export const ProjectLink = Schema.Struct({ link: AppLink, projectTitle: Schema.String, publicUrl: Schema.String })
export type ProjectLink = typeof ProjectLink.Type

export const ProjectLinks = Schema.Struct({
  links: Schema.Array(AppLink),
  projectTitle: Schema.String,
  publicUrl: Schema.String
})
export type ProjectLinks = typeof ProjectLinks.Type

/**
 * `--work <workstream-id>`: the message belongs to one of the agent's workstreams, and carries its label. Added in
 * November 2026; an older API ignores it (the message is sent without a label, which `dream` says).
 */
const work = Schema.optionalKey(WorkstreamId)

export class SandboxRpcs extends RpcGroup.make(
  // Talking to them ------------------------------------------------------------
  /**
   * `dream message [--notify] [--media file…] [--work id] "text"`. The CLI uploads each file first
   * (`CreateMediaUpload`). `InvalidRequest` for a workstream the project doesn't have.
   */
  Rpc.make("SendMessage", {
    payload: {
      text: Schema.NonEmptyString,
      media: Schema.Array(MediaId),
      notify: Schema.Boolean,
      workstream: work
    },
    success: TextMessage,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /**
   * `dream ask "question" --option "…" … [--why "…"] [--context "…"] [--meanwhile "…"] [--work id]`. Always notifies.
   * While it's open, its workstream waits on them.
   */
  Rpc.make("AskQuestion", {
    payload: {
      question: Schema.NonEmptyString,
      options: Schema.Array(Schema.NonEmptyString),
      why: Schema.optionalKey(Schema.String),
      /** Added after the first release; an older API ignores it. */
      context: Schema.optionalKey(Schema.String),
      meanwhile: Schema.optionalKey(Schema.String),
      workstream: work
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
      when: Schema.optionalKey(Schema.String),
      workstream: work
    },
    success: AccessMessage,
    error: InvalidRequest
  }),
  /** `dream access list`: what works here, meaning their shared integrations and this project's file keys. */
  Rpc.make("ListAccess", { success: Schema.Array(Integration) }),
  /** `dream notify withdraw <notification-id>`: one the agent sent, or one of its apps'. */
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

  // Workstreams (added in November 2026: an older API answers these with "Unknown request tag") ------------------
  /** `dream work list`, and `dream work` with no subcommand. */
  Rpc.make("ListWorkstreams", { success: Workstreams }),
  /**
   * `dream work start "title" [--now "…"] [--from <message-id>]`: a new active workstream. `from` files the message
   * that started it under it, as `RouteMessage` does.
   */
  Rpc.make("StartWorkstream", {
    payload: {
      title: WorkstreamTitle,
      now: Schema.optionalKey(Schema.String),
      from: Schema.optionalKey(MessageId)
    },
    success: Workstreams,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /** `dream work update <id> [--title "…"] [--now "…"]`: changes only its row, with no message. `--now ""` clears it. */
  Rpc.make("UpdateWorkstream", {
    payload: { workstreamId: WorkstreamId, title: Schema.optionalKey(WorkstreamTitle), now: Patch(Schema.String) },
    success: Workstreams,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /** `dream work done <id> [--result "…"]` and `dream work drop <id> [--why "…"]`. Ending one again changes nothing. */
  Rpc.make("EndWorkstream", {
    payload: {
      workstreamId: WorkstreamId,
      state: Schema.Literals(["done", "dropped"]),
      result: Schema.optionalKey(Schema.String)
    },
    success: Workstreams,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /** `dream work route <message-id> <id>`: files a message (usually theirs) under a workstream, with its label. */
  Rpc.make("RouteMessage", {
    payload: { messageId: MessageId, workstreamId: WorkstreamId },
    success: Message,
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

  // Relays ---------------------------------------------------------------------------------
  /**
   * `dream relay discord|websocket … --to <path> [--port <port>]`: Dream holds a line open from its Worker and POSTs
   * each event to the app. `InvalidRequest` when the project has `RelaysPerProject` already, when the key named
   * isn't one of theirs (or isn't for that host), or when a Discord relay has no key to use. Added after the first
   * release.
   */
  Rpc.make("AddRelay", {
    payload: { source: RelaySource, target: RelayTarget, label: Schema.optionalKey(Schema.NonEmptyString) },
    success: Relay,
    error: InvalidRequest
  }),
  /** `dream relay list`: each relay with its state, what's waiting, and recent problems. */
  Rpc.make("ListRelays", { success: Schema.Array(Relay) }),
  /** `dream relay remove <relay-id>`: closes the line and drops what's waiting. */
  Rpc.make("RemoveRelay", { payload: { relayId: RelayId }, error: NotFound }),
  /** `dream relay restart <relay-id>`: opens the line afresh, e.g. once a failed one's cause is fixed. */
  Rpc.make("RestartRelay", { payload: { relayId: RelayId }, success: Relay, error: NotFound }),

  // Notifications from the project's apps ------------------------------------------------
  /**
   * `dream notify setup <app> --name … --why … --often … [--icon …] [--color …] [--url …] [--work …]`: readies an app
   * to notify them under its own name, and puts a `Notifications` card in Chat asking them to allow it. Again for
   * the same app: an open card is updated in place, a declined one asks again, and an allowed app keeps its
   * permission with the new name, tile and page. `InvalidRequest` for a URL off the project's published one.
   * Added in November 2026.
   */
  Rpc.make("SetUpAppNotifications", {
    payload: {
      app: AppId,
      name: AppName,
      why: Schema.NonEmptyString,
      often: Schema.NonEmptyString,
      icon: Schema.optionalKey(LinkIcon),
      color: Schema.optionalKey(LinkColor),
      url: Schema.optionalKey(Schema.NonEmptyString),
      workstream: work
    },
    success: Schema.Struct({ app: AppSender, card: AccessMessage }),
    error: InvalidRequest
  }),
  /**
   * `dream notify --app <app> [--title …] [--url …] [--key …] [--quiet] [--dry-run] "text"`, from any process. The
   * result's `outcome` says what happened; none of them is an error. `InvalidRequest` only when the call is wrong:
   * an app that isn't set up, a URL off the project's published one, or text with one of the project's file keys.
   * `dryRun` decides the outcome without sending or keeping anything. Added in November 2026.
   */
  Rpc.make("SendAppNotification", {
    payload: {
      app: AppId,
      text: AppNotificationText,
      title: Schema.optionalKey(AppNotificationTitle),
      url: Schema.optionalKey(Schema.NonEmptyString),
      key: Schema.optionalKey(AppNotificationKey),
      quiet: Schema.Boolean,
      dryRun: Schema.Boolean
    },
    success: AppNotification,
    error: InvalidRequest
  }),
  /** `dream notify list [--app <app>]`: the apps, and what they sent (newest first). Added in November 2026. */
  Rpc.make("ListAppNotifications", {
    payload: { app: Schema.optionalKey(AppId) },
    success: AppNotifications
  }),

  // App links on their Home ------------------------------------------------------------
  /**
   * `dream link add <url> --title … [--icon <symbol|emoji|file>] [--color …]`. `InvalidRequest` when the project
   * already has `AgentLinksPerProject` links on Home, when they removed a link to this URL, or for an image that
   * isn't this project's upload. Added after the first release.
   */
  Rpc.make("AddLink", {
    payload: { url: LinkUrl, title: LinkTitle, icon: Schema.optionalKey(LinkIcon), color: LinkColor },
    success: ProjectLink,
    error: InvalidRequest
  }),
  /**
   * `dream link update <link-id> [--url …] [--title …] [--icon …] [--color …]`; `--icon ""` makes it a monogram.
   * `InvalidRequest` for a link they added, and for a title or icon they've since made their own.
   */
  Rpc.make("UpdateLink", {
    payload: {
      linkId: LinkId,
      url: Schema.optionalKey(LinkUrl),
      title: Schema.optionalKey(LinkTitle),
      icon: Patch(LinkIcon),
      color: Schema.optionalKey(LinkColor)
    },
    success: ProjectLink,
    error: Schema.Union([NotFound, InvalidRequest])
  }),
  /** `dream link remove <link-id>`. `InvalidRequest` for a link they added. */
  Rpc.make("RemoveLink", { payload: { linkId: LinkId }, error: Schema.Union([NotFound, InvalidRequest]) }),
  /** `dream link list`: this project's links, theirs too, and the agent's ones they removed (with `removedAt`). */
  Rpc.make("ListLinks", { success: ProjectLinks }),

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
  /**
   * A turn started or finished, with the events it consumed. Drives the "working" state on the phone. A finished
   * turn carries the tokens it used; dreamd builds before that send none.
   */
  Rpc.make("ReportTurn", {
    payload: {
      state: Schema.Literals(["started", "finished"]),
      eventIds: Schema.Array(EventId),
      usage: Schema.optionalKey(TurnUsage)
    }
  }),
  /**
   * Keep the sandbox up: a scheduled `--run` command is running, the published app is in use, or the app is taking
   * a relay's delivery ("relay", added after the first release). dreamd sends it about once a minute while any
   * holds, and Dream keeps the sandbox awake until five minutes from then (longer timeouts, like a turn's, stay).
   * Nothing for an archived project.
   */
  Rpc.make("StayAwake", { payload: { reason: Schema.Literals(["command", "app", "relay"]) } }),
  /**
   * dreamd has nothing left to do: the scheduled command or relay delivery it woke for is done, no turn is running
   * or waiting, and nobody has used the app for a few minutes. Dream pauses the sandbox now rather than when its
   * timeout runs out, unless something on its side still needs it (a turn, events on their way, a delivery under
   * way, the few minutes after a turn). Added after the first release; an older API refuses it.
   */
  Rpc.make("Sleep", {
    payload: {
      reason: Schema.Literals(["command", "relay"]),
      /** When dreamd last looked and saw nothing to do; anything handed to it after that may not have been seen. */
      checkedAt: Schema.DateTimeUtc
    }
  })
).middleware(SandboxAuth) {}
