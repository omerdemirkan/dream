/**
 * Everything that can wake the agent. The ProjectDO keeps an inbox of these
 * and delivers them to dreamd (`DaemonRpcs.Deliver`); dreamd starts a turn with
 * them, or queues them if a turn is running. Each turn's prompt is the
 * plain-text rendering of the events that woke it (see `renderAgentEvent`).
 */
import { DateTime, Schema } from "effect"
import { IntegrationAccess } from "./Connections.ts"
import { EventId, LinkId, MessageId, WakeId } from "./Ids.ts"
import { QuestionAnswer } from "./Message.ts"
import { UsageWindowName } from "./Usage.ts"
import { TaskFailure, WakeTask } from "./Wake.ts"
import { WorkstreamRef } from "./Workstream.ts"

const EventFields = {
  id: EventId,
  at: Schema.DateTimeUtc
}

/** The result of a scheduled `--run` command, filled in by dreamd after running it. */
export const RunResult = Schema.Struct({
  exitCode: Schema.Int,
  /** The last few KB of combined stdout and stderr. */
  outputTail: Schema.String
})
export type RunResult = typeof RunResult.Type

export const AgentEvent = Schema.TaggedUnion({
  /**
   * They wrote in Chat. A project's first event is the idea itself. `workstream`: they wrote it into one of the
   * agent's workstreams (a reply to it); added in November 2026, older dreamd builds ignore it.
   */
  UserMessage: {
    ...EventFields,
    messageId: MessageId,
    text: Schema.String,
    workstream: Schema.optionalKey(WorkstreamRef)
  },
  QuestionAnswered: {
    ...EventFields,
    messageId: MessageId,
    question: Schema.String,
    answer: QuestionAnswer,
    /** Present when they changed an earlier answer. */
    previous: Schema.optionalKey(QuestionAnswer)
  },
  AccessConnected: {
    ...EventFields,
    /** The request it answers, or for a `change`, the request it was connected through. */
    messageId: MessageId,
    label: Schema.String,
    access: IntegrationAccess,
    /**
     * Present when this isn't a request being answered: `replaced`, they entered a new key in Settings (for a `File`
     * key, Dream rewrote the file); `restored`, a connection that stopped working was connected again from another
     * project. Older dreamd builds ignore it and read it as an answer.
     */
    change: Schema.optionalKey(Schema.Literals(["replaced", "restored"]))
  },
  /** `reason`: why, if they said (one of the app's one-tap reasons or their own words). */
  AccessDeclined: { ...EventFields, messageId: MessageId, reason: Schema.optionalKey(Schema.String) },
  /**
   * Something they had connected is gone. Sent for `File` keys, whose file Dream deleted from this sandbox, and for
   * any other connection this project asked for (a card it sent was connected to it). Only dreamd builds that know
   * this event receive it: ones that can request a `File` key or an `OAuth` sign-in, or that report a release.
   */
  AccessRemoved: {
    ...EventFields,
    label: Schema.String,
    access: IntegrationAccess,
    /**
     * Present when they didn't remove it: the service stopped accepting it (they revoked it there, or it lapsed), in
     * a sentence. Older dreamd builds ignore it and say they disconnected it.
     */
    failure: Schema.optionalKey(Schema.String)
  },
  /**
   * A wake the agent scheduled came due. With `run` or `task`, the agent only sees it if the command or the task
   * failed. dreamd builds that don't know `task` take it for a plain wake and start a turn.
   */
  WakeDue: {
    ...EventFields,
    wakeId: WakeId,
    why: Schema.String,
    run: Schema.optionalKey(Schema.Struct({ command: Schema.String, result: Schema.optionalKey(RunResult) })),
    task: Schema.optionalKey(Schema.Struct({ ...WakeTask.fields, result: Schema.optionalKey(TaskFailure) }))
  },
  /** `dream wake "why"` from anywhere in the sandbox, typically an app's error handler. */
  Alert: { ...EventFields, reason: Schema.String },
  UsageReset: { ...EventFields, window: UsageWindowName },
  /**
   * dreamd loaded the project's published URL after a turn and it looked broken (an error status, uncaught page
   * errors, or no answer). Made by dreamd itself, never by the API, and only when the result changed.
   */
  PublishedUrlBroken: {
    ...EventFields,
    url: Schema.String,
    port: Schema.Int,
    /** What the check saw, as `dream publish` prints it. */
    facts: Schema.String
  },
  /**
   * They changed or removed one of this project's app links on their Home (`dream link`). Their change stays: the
   * agent can't rename or re-icon what they did, or add a link to a URL they removed. Only sent for links an agent
   * made, so only to dreamd builds that know `dream link` and this event.
   */
  LinkEdited: {
    ...EventFields,
    linkId: LinkId,
    url: Schema.String,
    /** Its title now, or for `removed`, the title it had. */
    title: Schema.String,
    change: Schema.Literals(["renamed", "icon", "removed"]),
    /** `renamed`: the title it had before. */
    previousTitle: Schema.optionalKey(Schema.String),
    /** `icon`: the new tile in words, e.g. "the SF Symbol dumbbell on a red tile". */
    tile: Schema.optionalKey(Schema.String)
  }
})
export type AgentEvent = typeof AgentEvent.Type

// ---------------------------------------------------------------------------
// Plain-text rendering for the turn prompt
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Their IANA time zone; times are shown in it. Defaults to UTC. */
  readonly timeZone?: string | undefined
}

/** e.g. "Wed, Nov 4, 2:02 PM", in their time zone. */
export const formatEventTime = (at: DateTime.Utc, options: RenderOptions = {}): string =>
  DateTime.format(at, {
    locale: "en-US",
    timeZone: options.timeZone ?? "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  })

const quote = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`))
    .join("\n")

const renderAnswer = (answer: QuestionAnswer): string =>
  QuestionAnswer.match(answer, {
    Choice: ({ option }) => `"${option}"`,
    Freeform: ({ text }) => `in their own words:\n${quote(text)}`
  })

const renderAccess = (label: string, access: IntegrationAccess): string =>
  IntegrationAccess.match(access, {
    Google: ({ scopes, hosts, placeholder }) =>
      `They connected ${label} (${scopes.join(", ")}). HTTPS requests to ${hosts.join(", ")} carry their ` +
      `Google credential. Where a library needs a token configured, use the placeholder "${placeholder}".`,
    Key: ({ service, host, header, format, placeholder }) =>
      `They connected ${service}. HTTPS requests to ${host} get the header "${header}: ${format}" with ` +
      `their real key. Where a library needs a key configured, use the placeholder "${placeholder}".`,
    File: ({ service, path }) =>
      `They entered their ${service} key, and Dream wrote it to ${path}. Have your code read the file when it ` +
      `runs. Don't print it, put it in a command or the project's files, or send it anywhere but ${service}: ` +
      "whatever you see in this session goes to the model provider.",
    Apple: ({ issuerId, keyId }) =>
      `They connected their App Store Connect API key (issuer id ${issuerId}, key id ${keyId}).`,
    OAuth: ({ service, account, scopes, hosts, placeholder, notes }) =>
      `They connected ${service}${account === undefined ? "" : ` as ${account}`}` +
      `${scopes.length === 0 ? "" : ` (${scopes.join(", ")})`}. HTTPS requests to ${hosts.join(", ")} carry ` +
      `their ${service} access token, which Dream keeps fresh. Where a library needs a token configured, use the ` +
      `placeholder "${placeholder}"; never refresh it yourself.${notes === undefined ? "" : ` ${notes}`}`
  })

const renderReplaced = (label: string, access: IntegrationAccess): string =>
  access._tag === "File"
    ? `They entered a new ${access.service} key in Settings, and Dream rewrote ${access.path} with it. Anything ` +
      "that read the old key when it started still has it: restart it so it reads the file again."
    : `They replaced their ${label} key in Settings. Requests carry the new one already; nothing needs to change.`

/** The hosts whose requests carried a connection's credential. */
const hostsOf = (access: IntegrationAccess): ReadonlyArray<string> =>
  IntegrationAccess.match(access, {
    Google: ({ hosts }) => hosts,
    Key: ({ host }) => [host],
    File: () => [],
    Apple: () => ["api.appstoreconnect.apple.com"],
    OAuth: ({ hosts }) => hosts
  })

const renderRemoved = (label: string, access: IntegrationAccess, failure: string | undefined): string => {
  if (failure !== undefined) {
    const hosts = hostsOf(access)
    const again =
      access._tag === "OAuth"
        ? `\`dream access oauth ${access.provider}\``
        : access._tag === "Google"
          ? "`dream access google`"
          : "`dream access`"
    return (
      `Their ${label} connection stopped working: ${failure}.` +
      (hosts.length === 0 ? "" : ` HTTPS requests to ${hosts.join(", ")} no longer carry their credential.`) +
      " Nothing that relies on it works until they connect it again. Your card for it now says it stopped " +
      `working, and they can connect it from there; if this project needs it soon, ask with ${again} so a fresh ` +
      "card reaches them."
    )
  }
  if (access._tag === "File") {
    return (
      `They removed their ${access.service} key, and Dream deleted ${access.path}. Code that reads it fails until ` +
      "they enter one again."
    )
  }
  const hosts = hostsOf(access)
  return (
    `They disconnected ${label} in Settings.` +
    (hosts.length === 0 ? "" : ` HTTPS requests to ${hosts.join(", ")} no longer carry their credential.`) +
    " If this project still needs it, say why when you ask for it again; they chose to remove it."
  )
}

/** One event as a paragraph of the turn prompt. Message and wake ids are included so the agent can refer to them. */
export const renderAgentEvent = (event: AgentEvent, options: RenderOptions = {}): string => {
  const time = formatEventTime(event.at, options)
  const body = AgentEvent.match(event, {
    UserMessage: ({ messageId, text, workstream }) =>
      workstream === undefined
        ? `They wrote (${messageId}):\n${quote(text)}`
        : `They wrote (${messageId}) into your workstream "${workstream.title}" (${workstream.id}):\n${quote(text)}`,
    QuestionAnswered: ({ messageId, question, answer, previous }) =>
      `They answered your question ${messageId}, "${question}", ${renderAnswer(answer)}` +
      (previous === undefined ? "" : `\n(This replaces their earlier answer, ${renderAnswer(previous)}.)`),
    AccessConnected: ({ messageId, label, access, change }) =>
      change === "replaced"
        ? renderReplaced(label, access)
        : change === "restored"
          ? `Their ${label} connection works again: they connected it again. ${renderAccess(label, access)}`
          : `${renderAccess(label, access)} This answers your request ${messageId}.`,
    AccessDeclined: ({ messageId, reason }) =>
      reason === undefined
        ? `They declined your access request ${messageId}.`
        : `They declined your access request ${messageId}, and said why:\n${quote(reason)}\n` +
          "Take that into account: find a way that doesn't need it, ask differently, or wait, whichever fits.",
    AccessRemoved: ({ label, access, failure }) => renderRemoved(label, access, failure),
    WakeDue: ({ wakeId, why, run, task }) => {
      const head = `A wake-up you scheduled came due (${wakeId}): "${why}".`
      if (task !== undefined) {
        const ran = `${head} Its task ran in a session of its own (${task.model}, effort ${task.effort})`
        if (task.result === undefined) return `${ran}.`
        const report = task.result.report === undefined ? "" : ` What it said last:\n${quote(task.result.report)}`
        return `${ran} and failed: ${task.result.reason}.${report}`
      }
      if (run === undefined) return head
      if (run.result === undefined) return `${head} Its command was \`${run.command}\`.`
      return (
        `${head} It ran \`${run.command}\`, which exited with code ${run.result.exitCode}. ` +
        `The end of its output:\n\`\`\`\n${run.result.outputTail}\n\`\`\``
      )
    },
    Alert: ({ reason }) => `Something in the sandbox called \`dream wake\`:\n${quote(reason)}`,
    UsageReset: ({ window }) =>
      window === "fiveHour" ? "Their five-hour usage window has reset." : "Their weekly usage limit has reset.",
    PublishedUrlBroken: ({ url, port, facts }) =>
      `When your last turn ended, Dream loaded your published URL ${url} (port ${port}):\n${quote(facts)}`,
    LinkEdited: ({ linkId, url, title, change, previousTitle, tile }) =>
      change === "renamed"
        ? `They renamed your app link ${linkId} (${url}) on their Home from "${previousTitle ?? "?"}" to "${title}". ` +
          "The name is theirs now, here and on their Home Screen if they add it there."
        : change === "icon"
          ? `They changed the icon of your app link "${title}" (${linkId}, ${url}) to ${tile ?? "one of their own"}. ` +
            "The icon is theirs now."
          : `They removed your app link "${title}" (${url}) from their Home. It stays off: Dream won't take a new ` +
            "link to that URL from this project, though they can put it back themselves."
  })
  return `[${time}] ${body}`
}
