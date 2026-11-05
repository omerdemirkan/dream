/**
 * Everything that can wake the agent. The ProjectDO keeps an inbox of these
 * and delivers them to dreamd (`DaemonRpcs.Deliver`); dreamd starts a turn with
 * them, or queues them if a turn is running. Each turn's prompt is the
 * plain-text rendering of the events that woke it (see `renderAgentEvent`).
 */
import { DateTime, Schema } from "effect"
import { IntegrationAccess } from "./Connections.ts"
import { EventId, MessageId, WakeId } from "./Ids.ts"
import { QuestionAnswer } from "./Message.ts"
import { UsageWindowName } from "./Usage.ts"

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
  /** They wrote in Chat. A project's first event is the idea itself. */
  UserMessage: { ...EventFields, messageId: MessageId, text: Schema.String },
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
    messageId: MessageId,
    label: Schema.String,
    access: IntegrationAccess
  },
  AccessDeclined: { ...EventFields, messageId: MessageId },
  /**
   * They removed something they had connected. Sent for `File` keys, whose file Dream deleted from this sandbox;
   * only dreamd builds that can request one ever receive it.
   */
  AccessRemoved: { ...EventFields, label: Schema.String, access: IntegrationAccess },
  /** A wake the agent scheduled came due. With `run`, the agent only sees it if the command failed. */
  WakeDue: {
    ...EventFields,
    wakeId: WakeId,
    why: Schema.String,
    run: Schema.optionalKey(Schema.Struct({ command: Schema.String, result: Schema.optionalKey(RunResult) }))
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
      `They connected their App Store Connect API key (issuer id ${issuerId}, key id ${keyId}).`
  })

const renderRemoved = (label: string, access: IntegrationAccess): string =>
  access._tag === "File"
    ? `They removed their ${access.service} key, and Dream deleted ${access.path}. Code that reads it fails until ` +
      "they enter one again."
    : `They disconnected ${label}.`

/** One event as a paragraph of the turn prompt. Message and wake ids are included so the agent can refer to them. */
export const renderAgentEvent = (event: AgentEvent, options: RenderOptions = {}): string => {
  const time = formatEventTime(event.at, options)
  const body = AgentEvent.match(event, {
    UserMessage: ({ text }) => `They wrote:\n${quote(text)}`,
    QuestionAnswered: ({ messageId, question, answer, previous }) =>
      `They answered your question ${messageId}, "${question}", ${renderAnswer(answer)}` +
      (previous === undefined ? "" : `\n(This replaces their earlier answer, ${renderAnswer(previous)}.)`),
    AccessConnected: ({ messageId, label, access }) =>
      `${renderAccess(label, access)} This answers your request ${messageId}.`,
    AccessDeclined: ({ messageId }) => `They declined your access request ${messageId}.`,
    AccessRemoved: ({ label, access }) => renderRemoved(label, access),
    WakeDue: ({ wakeId, why, run }) => {
      const head = `A wake-up you scheduled came due (${wakeId}): "${why}".`
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
      `When your last turn ended, Dream loaded your published URL ${url} (port ${port}):\n${quote(facts)}`
  })
  return `[${time}] ${body}`
}
