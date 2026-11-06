/**
 * Phone ↔ ProjectDO over a WebSocket while a project is open
 * (`Routes.projectLive`, JSON serialization).
 *
 * The socket belongs to one project: the Worker checks the ticket, then hands
 * the upgrade to that project's DO, so payloads carry no project id.
 */
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Message } from "../Message.ts"
import { AgentActivity, Project } from "../Project.ts"
import { StatusCard } from "../Status.ts"

/**
 * What the phone receives. The first event of every subscription is a
 * `Snapshot`; after that, changes in the order they happened. On reconnect the
 * phone subscribes again and replaces its state with the new snapshot.
 */
export const ProjectEvent = Schema.TaggedUnion({
  Snapshot: {
    project: Project,
    status: StatusCard,
    /** The most recent messages, oldest first. Earlier ones come from `AppRpcs.ListMessages`. */
    messages: Schema.Array(Message),
    hasEarlierMessages: Schema.Boolean,
    /** Whether the agent is in a turn right now. */
    working: Schema.Boolean,
    /** Whether the agent is starting, working or idle, and its next wake. Absent from older APIs. */
    activity: Schema.optionalKey(AgentActivity)
  },
  ProjectChanged: { project: Project },
  StatusChanged: { status: StatusCard },
  MessageAdded: { message: Message },
  /** A message's state changed (answered, connected, declined, withdrawn) or its notification was withdrawn. */
  MessageChanged: { message: Message },
  /** Sent alongside `ActivityChanged`, for app builds that predate it. */
  WorkingChanged: { working: Schema.Boolean },
  /** The agent started bringing its sandbox up, started or finished a turn, or its next wake changed. */
  ActivityChanged: { activity: AgentActivity }
})
export type ProjectEvent = typeof ProjectEvent.Type

export class ProjectLiveRpcs extends RpcGroup.make(Rpc.make("Subscribe", { success: ProjectEvent, stream: true })) {}
