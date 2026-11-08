/**
 * Everything that can wake the agent. The ProjectDO keeps an inbox of these
 * and delivers them to dreamd (`DaemonRpcs.Deliver`); dreamd starts a turn with
 * them, or queues them if a turn is running. Each turn's prompt is the
 * plain-text rendering of the events that woke it (see `renderAgentEvent`).
 */
import { DateTime, Schema } from "effect"
import { AppNotificationLimits } from "./AppNotifications.ts"
import { IntegrationAccess } from "./Connections.ts"
import { AppId, EventId, LinkId, type MediaId, MessageId, WakeId } from "./Ids.ts"
import { Trouble } from "./Logs.ts"
import { Attachment, attachmentPath, formatBytes, isImageAttachment } from "./Media.ts"
import { QuestionAnswer } from "./Message.ts"
import { UsageLimits, UsageWindowName, WindowShare } from "./Usage.ts"
import { TaskFailure, WakeTask } from "./Wake.ts"
import { SandboxSize, SandboxSizes } from "./Sandbox.ts"
import { ThreadRef } from "./Thread.ts"
import { WorkstreamRef } from "./Workstream.ts"

const EventFields = {
  id: EventId,
  at: Schema.DateTimeUtc
}

/** The result of a scheduled `--run` command, filled in by dreamd after running it. */
export const RunResult = Schema.Struct({
  exitCode: Schema.Int,
  /** The last few KB of combined stdout and stderr. */
  outputTail: Schema.String,
  /**
   * The command failed before this, in a row, without waking the agent: Dream wakes it for a failing command once,
   * then again only after a cool-down or a different exit code, and logs each run (`dream logs --source run`).
   * `count` runs since `since`. Added November 2026; made and read by dreamd alone.
   */
  failedBefore: Schema.optionalKey(Schema.Struct({ count: Schema.Int, since: Schema.DateTimeUtc }))
})
export type RunResult = typeof RunResult.Type

export const AgentEvent = Schema.TaggedUnion({
  /**
   * They wrote in Chat. A project's first event is the idea itself. `workstream`: they wrote it into one of the
   * agent's workstreams (a reply to it); added in November 2026, older dreamd builds ignore it. `attachments`: photos
   * and files they attached, which dreamd copies to `attachmentPath` before the turn; also November 2026, and
   * older dreamd builds ignore them. `thread`: they wrote it in the thread on that message (`Thread.ts`); also
   * November 2026, and older dreamd builds render the message without it.
   */
  UserMessage: {
    ...EventFields,
    messageId: MessageId,
    text: Schema.String,
    workstream: Schema.optionalKey(WorkstreamRef),
    thread: Schema.optionalKey(ThreadRef),
    attachments: Schema.optionalKey(Schema.Array(Attachment))
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
  /**
   * `dream wake "why"` from anywhere in the sandbox, typically an app's error handler. With `noticed`, Dream itself
   * noticed trouble (the published app failing, the machine short of memory or disk) and `reason` says what it saw;
   * the ProjectDO makes the published app's, dreamd the machine's, at most once per problem. Added November 2026:
   * older dreamd builds ignore `noticed` and render it as a `dream wake` with the reason, which still reads right.
   */
  Alert: { ...EventFields, reason: Schema.String, noticed: Schema.optionalKey(Trouble) },
  UsageReset: { ...EventFields, window: UsageWindowName },
  /**
   * They set, changed or cleared the usage limits on this project (`limits` as they are now, `previous` as they
   * were), with where the project stood in the week then. Added November 2026; only dreamd builds whose
   * `dream usage` shows limits get it.
   */
  UsageLimitsChanged: {
    ...EventFields,
    limits: UsageLimits,
    previous: UsageLimits,
    week: Schema.optionalKey(WindowShare)
  },
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
  },
  /**
   * They decided about one of the project's apps that notify (`dream notify setup`): allowed or declined its card,
   * or changed how it reaches them. Their choice stays theirs. Added in November 2026; only projects whose agent set
   * up an app (so a dreamd that knows it) get it.
   */
  AppNotificationsChanged: {
    ...EventFields,
    app: AppId,
    name: Schema.String,
    change: Schema.Literals(["allowed", "declined", "immediate", "quiet", "off", "muted"]),
    /** `declined`: why, if they said. */
    reason: Schema.optionalKey(Schema.String),
    /** `muted`: until when. */
    until: Schema.optionalKey(Schema.DateTimeUtc)
  },
  /**
   * Dream moved the project to a sandbox of another size, as the agent asked (`dream machine move`), or couldn't
   * (`failure`, and it's still on `from`). Everything in the home directory came over; processes didn't, so Dream
   * restarted the servers that were listening (`restarted`, their command lines) and lists the other processes it
   * left (`notRestarted`). Added November 2026; only sandboxes built with `dream machine` get it.
   */
  MachineMoved: {
    ...EventFields,
    from: SandboxSize,
    to: SandboxSize,
    why: Schema.String,
    restarted: Schema.Array(Schema.String),
    notRestarted: Schema.Array(Schema.String),
    failure: Schema.optionalKey(Schema.String)
  },
  /** One of the project's apps went over a limit, so Dream is holding back what it sends. At most once a day an app. */
  AppNotificationsHeld: {
    ...EventFields,
    app: AppId,
    name: Schema.String,
    limit: Schema.Literals(["hour", "day", "project"])
  },
  /**
   * Background work the agent started (a subagent, a command or a Monitor running in the background) was stopped
   * before it reported back, so the agent can start it again. Made by dreamd itself, never by the API.
   * `reason`: `quiet`, Dream stopped it after its turn had waited `minutes` with nothing from it; `long`, after the
   * turn had waited on background work for `minutes` in all; `ended`, the turn ended another way (an error, a usage
   * limit) with it running; `restart`, dreamd restarted during the turn; `earlier`, a turn ended before Dream waited
   * for background work (found in the session once, after the update). Added November 2026.
   */
  BackgroundStopped: {
    ...EventFields,
    reason: Schema.Literals(["quiet", "long", "ended", "restart", "earlier"]),
    tasks: Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["subagent", "command", "monitor", "other"]),
        description: Schema.String
      })
    ),
    minutes: Schema.optionalKey(Schema.Int)
  }
})
export type AgentEvent = typeof AgentEvent.Type

/** Where `dream logs` shows the trouble behind an `Alert` Dream made. */
const troubleLogs: Record<Trouble, string> = {
  "server-errors": "dream logs --source gateway,app --errors",
  unreachable: "dream logs --source gateway,app,dream",
  memory: "dream logs --source machine",
  "out-of-memory": "dream logs --source machine,app",
  disk: "dream logs --source machine",
  failing: "dream logs --source run --errors"
}

// ---------------------------------------------------------------------------
// Plain-text rendering for the turn prompt
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /** Their IANA time zone; times are shown in it. Defaults to UTC. */
  readonly timeZone?: string | undefined
  /** Attachments dreamd couldn't copy into the sandbox; the prompt says so instead of giving a path. */
  readonly missingAttachments?: ReadonlySet<MediaId> | undefined
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

/** The message a thread is on, as in "They wrote (…) in the thread on your question msg_…, "…", which is still open". */
const renderThread = ({ messageId, from, kind, excerpt, open }: ThreadRef): string => {
  switch (kind) {
    case "text":
      return `${from === "agent" ? "your" : "their own"} message ${messageId} ("${excerpt}")`
    case "question":
      return `your question ${messageId}, "${excerpt}"${open === true ? ", which is still open (a reply doesn't answer it)" : ""}`
    case "access":
      return `your access request ${messageId}, "${excerpt}"${open === true ? ", which is still open" : ""}`
  }
}

const renderAnswer = (answer: QuestionAnswer): string =>
  QuestionAnswer.match(answer, {
    Choice: ({ option, note }) => (note === undefined ? `"${option}"` : `"${option}", adding:\n${quote(note)}`),
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

const describeAttachment = (attachment: Attachment): string => {
  const pixels =
    attachment.width !== undefined && attachment.height !== undefined
      ? `${attachment.width}×${attachment.height}, `
      : ""
  return `${isImageAttachment(attachment) ? "photo" : attachment.contentType}, ${pixels}${formatBytes(attachment.sizeBytes)}`
}

/** "a photo, now at …" or "3 files, now in the sandbox:" and a list. Empty without attachments. */
const renderAttachments = (messageId: string, attachments: ReadonlyArray<Attachment>, options: RenderOptions) => {
  if (attachments.length === 0) return ""
  const line = (attachment: Attachment) =>
    options.missingAttachments?.has(attachment.id) === true
      ? `${attachment.name} (${describeAttachment(attachment)}), which Dream couldn't copy into the sandbox; ask them to send it again if you need it`
      : `${attachmentPath(messageId, attachment)} (${describeAttachment(attachment)})`
  const only = attachments.length === 1 ? attachments[0] : undefined
  if (only !== undefined) return `${isImageAttachment(only) ? "a photo" : "a file"}: ${line(only)}`
  const kind = attachments.every(isImageAttachment) ? "photos" : "files"
  return `${attachments.length} ${kind}:\n${attachments.map((a) => `- ${line(a)}`).join("\n")}`
}

const renderUsageLimits = (
  limits: UsageLimits,
  previous: UsageLimits,
  week: WindowShare | undefined,
  options: RenderOptions
): string => {
  const { projectWeekPercent: cap, planLeftPercent: floor } = limits
  if (cap === undefined && floor === undefined) {
    return "They cleared the usage limits on this project, so it runs on their plan as before, up to the plan's own limits."
  }
  const parts = [
    ...(cap === undefined ? [] : [`it may use up to ${cap}% of their plan's week`]),
    ...(floor === undefined
      ? []
      : [`Dream stops it when the plan has ${floor}% of its week left, so their other work keeps some room`])
  ]
  const changed =
    previous.projectWeekPercent === undefined && previous.planLeftPercent === undefined ? "set" : "changed"
  const where =
    week === undefined
      ? ""
      : ` So far this week it has used about ${Math.round(week.projectPercent)}%, and the plan has ` +
        `${Math.max(0, 100 - Math.round(week.usedPercent))}% left` +
        (week.resetsAt === undefined ? "." : `; the week resets ${formatEventTime(week.resetsAt, options)}.`)
  return (
    `They ${changed} the usage limits on this project: ${parts.join(", and ")}.${where}\n` +
    "At a limit, Dream lets the turn under way finish, then holds new turns, wake-ups and relay deliveries until " +
    "they raise or clear it or the week resets, and tells them on their phone. Its share is an estimate from how " +
    "the plan moved while you worked, read after a turn's first model call and when it ends, so one long turn can " +
    "run past a limit. `dream usage` shows where you stand against them; worth a look now and then, and before " +
    "starting something big."
  )
}

/** One event as a paragraph of the turn prompt. Message and wake ids are included so the agent can refer to them. */
export const renderAgentEvent = (event: AgentEvent, options: RenderOptions = {}): string => {
  const time = formatEventTime(event.at, options)
  const body = AgentEvent.match(event, {
    UserMessage: ({ messageId, text, workstream, thread, attachments = [] }) => {
      const where = thread === undefined ? "" : ` in the thread on ${renderThread(thread)}`
      const into = workstream === undefined ? "" : ` into your workstream "${workstream.title}" (${workstream.id})`
      const files = renderAttachments(messageId, attachments, options)
      const revise =
        thread?.kind === "question" && thread.open === true
          ? `\nIf they're asking you to change it, \`dream ask revise ${thread.messageId}\` changes the card in place.`
          : ""
      if (text.trim().length === 0 && files !== "") return `They sent (${messageId})${where}${into} ${files}${revise}`
      return (
        `They wrote (${messageId})${where}${into}:\n${quote(text)}` +
        `${files === "" ? "" : `\nThey attached ${files}`}${revise}`
      )
    },
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
      const before = run.result.failedBefore
      const again =
        before === undefined || before.count === 0
          ? ""
          : ` It had failed ${before.count === 1 ? "once" : `${before.count} times`} in a row before this, since ` +
            `${formatEventTime(before.since, options)}, without waking you again; \`dream logs --source run --name ` +
            `${wakeId}\` shows each run.`
      return (
        `${head} It ran \`${run.command}\`, which exited with code ${run.result.exitCode}.${again} ` +
        `The end of its output:\n\`\`\`\n${run.result.outputTail}\n\`\`\``
      )
    },
    Alert: ({ reason, noticed }) =>
      noticed === undefined
        ? `Something in the sandbox called \`dream wake\`:\n${quote(reason)}`
        : `Dream noticed a problem:\n${quote(reason)}\n\`${troubleLogs[noticed]}\` shows what it saw. Dream says ` +
          "this once per problem, and again only if it's still happening hours from now.",
    UsageReset: ({ window }) =>
      window === "fiveHour" ? "Their five-hour usage window has reset." : "Their weekly usage limit has reset.",
    UsageLimitsChanged: ({ limits, previous, week }) => renderUsageLimits(limits, previous, week, options),
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
            "link to that URL from this project, though they can put it back themselves.",
    AppNotificationsChanged: ({ app, name, change, reason, until }) => {
      const who = `${name} (${app})`
      switch (change) {
        case "allowed":
          return `They allowed ${who} to notify them. What it sends with \`dream notify --app ${app}\` reaches their phone now.`
        case "declined":
          return (
            `They declined notifications from ${who}` +
            (reason === undefined ? "." : `, and said why:\n${quote(reason)}\n`) +
            " Nothing it sends reaches them. They can still allow it from its card, and `dream notify setup` asks " +
            "again, which is worth it only with something different to offer."
          )
        case "immediate":
          return `They set ${who} to notify them as usual again, with a sound.`
        case "quiet":
          return `They set ${who} to notify them quietly: its notifications go to Notification Center without a sound.`
        case "off":
          return (
            `They turned off notifications from ${who}. Nothing it sends reaches them until they turn it back on; ` +
            "Dream keeps what it sends in its history."
          )
        case "muted":
          return `They muted ${who}${until === undefined ? "" : ` until ${formatEventTime(until, options)}`}.`
      }
    },
    MachineMoved: ({ from, to, why, restarted, notRestarted, failure }) => {
      const machine = (size: SandboxSize) =>
        `the ${size} machine (${SandboxSizes[size].cpus} CPUs, ${SandboxSizes[size].memoryGb} GB)`
      if (failure !== undefined) {
        return `Dream couldn't move this project to ${machine(to)} you asked for ("${why}"): ${failure}. You're still on ${machine(from)}, with everything as it was.`
      }
      const list = (commands: ReadonlyArray<string>) => commands.map((command) => `- \`${command}\``).join("\n")
      return (
        `Dream moved this project to ${machine(to)}, as you asked ("${why}"). Everything in your home directory came ` +
        "over: the project, your session, ~/.dream. Processes can't move, so it was a fresh boot: " +
        (restarted.length === 0
          ? "no servers were listening, so nothing was restarted."
          : `Dream restarted the servers that were listening, from the same directories:\n${list(restarted)}`) +
        (notRestarted.length === 0
          ? ""
          : `\nThese were running too and weren't restarted; start again any you still need:\n${list(notRestarted)}`) +
        "\nAnything installed outside your home directory (apt packages, files under /opt or /etc) needs installing " +
        "again. Check your published app answers, then carry on."
      )
    },
    BackgroundStopped: ({ reason, tasks, minutes }) => {
      const kind = { subagent: "subagent", command: "command", monitor: "Monitor", other: "task" } as const
      const list = tasks.map((task) => `- ${kind[task.kind]}: ${task.description}`).join("\n")
      const waited = minutes === undefined ? "" : ` ${minutes} minutes`
      const why =
        reason === "quiet"
          ? `Your last turn waited${waited} on background work that showed no sign of progress, so Dream stopped it:`
          : reason === "long"
            ? `Your last turn had waited${waited} on background work, Dream's limit, so Dream stopped what was still running:`
            : reason === "ended"
              ? "Your last turn ended another way while background work was still running, which stopped it:"
              : reason === "restart"
                ? "Dream restarted during your last turn, which stopped the background work it was waiting on:"
                : "When your last turn ended, the background work you'd started was stopped with it before it " +
                  "reported back (Dream didn't keep turns going for background work then; it does now):"
      const after =
        reason === "quiet" || reason === "long"
          ? " A server you want running between turns goes outside your turn (`setsid nohup … &`); a long job, in " +
            '`dream wake --at 1m --run "…"` or `--task`.'
          : ""
      return (
        `${why}\n${list}\nNothing it hadn't written down reached you. Start again what you still need, and if you ` +
        `told them you'd come back with its results, follow through.${after}`
      )
    },
    AppNotificationsHeld: ({ app, name, limit }) =>
      `${name} (${app}) went over Dream's limit of ` +
      (limit === "hour"
        ? `${AppNotificationLimits.perAppHour} notifications an hour`
        : limit === "day"
          ? `${AppNotificationLimits.perAppDay} notifications a day`
          : `${AppNotificationLimits.perProjectDay} notifications a day across this project's apps`) +
      ", so what it sends past that stays in its history without reaching their phone. You hear this once a day " +
      "at most. Check whether it sends more than it should."
  })
  return `[${time}] ${body}`
}
