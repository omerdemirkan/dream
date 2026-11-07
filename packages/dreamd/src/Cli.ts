/**
 * The `dream` command: the agent's whole interface to Dream, usable from any
 * process in the sandbox. Each subcommand maps onto one `SandboxRpcs` call
 * (the RPC doc comments name the command and flags) sent through dreamd's
 * Unix socket. Results print as short text, or as JSON with `--json`.
 */
import {
  AgentLinksPerProject,
  AccessMessage,
  AppId,
  AppNotification,
  AppNotifications,
  AppSender,
  AccessRequest,
  accessHostProblem,
  keyFileNameFor,
  keyFileNameProblem,
  BrowserSession,
  type BrowserSessionId,
  Integration,
  LinkColor,
  LinkIcon,
  type LinkId,
  LinkTitleMaxLength,
  linkUrlProblem,
  LiveActivityContent,
  MachineInfo,
  MacStatus,
  ProjectLink,
  ProjectLinks,
  type MediaId,
  MediaRef,
  Message,
  type MessageId,
  Milestone,
  type NotificationId,
  ProjectPhase,
  QuestionMessage,
  questionPreviewsProblem,
  ReasoningEffort,
  DiscordDefaultEvents,
  DiscordDefaultIntents,
  type IntegrationId,
  Relay,
  type RelayId,
  RelaySource,
  relayPathProblem,
  relayUrlProblem,
  StatusCard,
  TextMessage,
  UsageSnapshot,
  Wake,
  type WakeId,
  WakeWhen,
  type WorkstreamId,
  Workstreams,
  WorkstreamTitleMaxLength
} from "@dream/domain"
import { Cause, Console, DateTime, Effect, FileSystem, Option, Path, Redacted, Result, Schema } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { glob } from "node:fs/promises"
import { Dream, newerThanApi, userFacing } from "./cli/Client.ts"
import * as Format from "./cli/Format.ts"
import { measure } from "./cli/MediaInfo.ts"
import { PageCheck, PageLoad } from "./cli/PageCheck.ts"
import * as Parse from "./cli/Parse.ts"
import * as Secrets from "./cli/Secrets.ts"

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const json = Flag.Boolean("json").pipe(Flag.withDescription("Print the result as JSON."), Flag.withDefault(false))

/** Print `value` as JSON (encoded with its schema) or as `text`. */
const show = <S extends Schema.Top>(asJson: boolean, schema: S, value: S["Type"], text: string) =>
  Effect.suspend(() =>
    asJson
      ? Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(value).pipe(
          Effect.orDie,
          Effect.flatMap((encoded) => Console.log(JSON.stringify(encoded, null, 2)))
        )
      : Console.log(text)
  )

const fail = (message: string) => Effect.fail(new CliError.UserError({ cause: message, userMessage: message }))
const fromResult = <A>(result: Result.Result<A, string>) =>
  Result.match(result, { onFailure: fail, onSuccess: Effect.succeed })

/** `Some("")` clears a line, `Some(text)` sets it, `None` leaves it. */
const patch = (value: Option.Option<string>) =>
  Option.match(value, { onNone: () => undefined, onSome: (text) => (text.length === 0 ? null : text) })

const defined = <T extends Record<string, unknown>>(fields: T) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T as undefined extends T[K] ? never : K]: T[K]
  } & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> }

const now = DateTime.now

/** `-`, or leaving the text out while stdin is piped, reads it from stdin; for long messages. */
const textArgument = (name: string, description: string) =>
  Argument.String(name).pipe(
    Argument.withDescription(`${description} Use "-" or leave it out to read it from piped stdin.`),
    Argument.optional
  )

const stdinIsPiped = () => process.stdin.isTTY !== true

const readStdin = Effect.tryPromise({
  try: async () => {
    const chunks: Array<Buffer> = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString("utf8").trim()
  },
  catch: (cause) => new CliError.UserError({ cause, userMessage: "Couldn't read stdin." })
})

const readText = (text: string) => (text === "-" ? readStdin : Effect.succeed(text))

const readOptional = (text: Option.Option<string>) =>
  Option.match(text, { onNone: () => Effect.succeed(undefined), onSome: readText })

/** The text argument, from the command line or stdin; `missing` is the error when there's neither. */
const textFrom = (text: Option.Option<string>, missing: string) =>
  Option.match(text, {
    onNone: () => (stdinIsPiped() ? readStdin : fail(missing)),
    onSome: readText
  })

/**
 * Reserve a media id and upload the file's bytes to where the API says, with its size and length when `dream` can
 * read them. Audio only where `audio` says it can go (an option's preview).
 */
const upload = Effect.fn("dream.upload")(function* (file: string, caption?: string, audio = false) {
  const dream = yield* Dream
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const http = yield* HttpClient.HttpClient
  const contentType = yield* fromResult(Parse.mediaType(file, audio))
  const bytes = yield* fs
    .readFile(file)
    .pipe(Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: `Can't read ${file}.` })))
  if (bytes.byteLength === 0) return yield* fail(`${file} is empty.`)
  const { media, upload: target } = yield* userFacing(
    dream.CreateMediaUpload({
      filename: path.basename(file),
      contentType,
      sizeBytes: bytes.byteLength,
      ...measure(contentType, bytes),
      ...(caption === undefined ? {} : { caption })
    })
  )
  const response = yield* http
    .execute(
      HttpClientRequest.put(target.url).pipe(
        HttpClientRequest.setHeaders(target.headers),
        HttpClientRequest.bodyUint8Array(bytes, contentType)
      )
    )
    .pipe(
      Effect.mapError(
        (cause) => new CliError.UserError({ cause, userMessage: `Uploading ${file} failed: ${cause.message}` })
      )
    )
  if (response.status >= 300) return yield* fail(`Uploading ${file} failed with HTTP ${response.status}.`)
  return media
})

/** The files `pattern` names: itself, or a glob's matches in name order. */
const filesFor = (pattern: string) =>
  Effect.gen(function* () {
    if (!/[*?[{]/.test(pattern)) return [pattern]
    const matches = yield* Effect.tryPromise({
      try: async () => {
        const found: Array<string> = []
        for await (const match of glob(pattern)) found.push(match)
        return found
      },
      catch: (cause) => new CliError.UserError({ cause, userMessage: `Can't read the files ${pattern} names.` })
    })
    if (matches.length === 0) return yield* fail(`No files match ${pattern}.`)
    return matches.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  })

const workFlag = Flag.String("work").pipe(
  Flag.withDescription(
    "The workstream it belongs to (ws_…, from `dream work`). It carries that workstream's label in Chat; a question or access request makes its row wait on them while it's open."
  ),
  Flag.optional
)

const workOf = (work: Option.Option<string>) => Option.getOrUndefined(work)?.trim() as WorkstreamId | undefined

const replyFlag = Flag.String("reply-to").pipe(
  Flag.withDescription(
    "Put it in the thread on this message (msg_…, theirs or yours): Chat folds a thread into one line under its first message, and they read it there. It goes in that message's workstream, so leave out --work."
  ),
  Flag.optional
)

const replyOf = (reply: Option.Option<string>) => Option.getOrUndefined(reply)?.trim() as MessageId | undefined

const mediaFlag = Flag.String("media").pipe(
  Flag.withDescription("Attach a screenshot or recording (png, jpg or mp4). Repeat for more."),
  Flag.atLeast(0)
)

// ---------------------------------------------------------------------------
// Talking to them
// ---------------------------------------------------------------------------

const message = Command.make(
  "message",
  {
    text: textArgument(
      "message",
      "The message, in markdown: paragraphs, lists, bold, italic, code and links (headings show as bold lines). They read it on a phone."
    ),
    media: mediaFlag,
    notify: Flag.Boolean("notify").pipe(
      Flag.withDescription("Also notify them: its first lines, as plain text, on their lock screen."),
      Flag.withDefault(false)
    ),
    work: workFlag,
    replyTo: replyFlag,
    json
  },
  (input) =>
    Effect.gen(function* () {
      const dream = yield* Dream
      const text = yield* textFrom(
        input.text,
        "Say what: `dream message \"…\"`, or pipe it in: `dream message - <<'EOF'`."
      )
      if (text.length === 0) return yield* fail("The message is empty.")
      const media: Array<MediaId> = []
      for (const file of input.media) media.push((yield* upload(file)).id)
      const workstream = workOf(input.work)
      const replyTo = replyOf(input.replyTo)
      const sent = yield* userFacing(
        dream.SendMessage(defined({ text, media, notify: input.notify, workstream, replyTo }))
      )
      yield* show(
        input.json,
        TextMessage,
        sent,
        Format.sent(sent) + Format.unlabeled(workstream, sent) + Format.threaded(replyTo, sent)
      )
    })
).pipe(
  Command.withDescription("Put a message in their Chat (markdown), optionally with media and a notification."),
  Command.withExamples([
    { command: 'dream message "The first version is live: https://…" --media shot.png --notify' },
    { command: 'dream message --reply-to msg_\u2026 "It does now: the 214 came down to 187."' }
  ])
)

/** `--show "<option>=<files>"`: checked against the options, and each file uploaded with its caption. */
const previewsFor = (options: ReadonlyArray<string>, show: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const shows = yield* Effect.forEach(show, (raw) => fromResult(Parse.parseShow(raw)))
    for (const { option } of shows) {
      if (!options.includes(option)) {
        return yield* fail(
          `--show names "${option}", which isn't one of the options (${options.map((o) => `"${o}"`).join(", ")}).`
        )
      }
    }
    const expanded = yield* Effect.forEach(shows, ({ option, files }) =>
      Effect.map(Effect.forEach(files, filesFor), (paths) => ({ option, media: paths.flat() }))
    )
    const problem = questionPreviewsProblem(options, expanded)
    if (problem !== undefined) return yield* fail(problem)
    const previews = yield* Effect.forEach(expanded, ({ option, media: paths }) =>
      Effect.gen(function* () {
        const [first, ...rest] = yield* Effect.forEach(paths, (file) =>
          Effect.map(upload(file, Parse.captionOf(file), true), (m) => m.id)
        )
        return { option, media: [first!, ...rest] as const }
      })
    )
    return previews
  })

const askRevise = Command.make(
  "revise",
  {
    messageId: Argument.String("message-id"),
    question: Flag.String("question").pipe(Flag.withDescription("The question's new wording."), Flag.optional),
    option: Flag.String("option").pipe(
      Flag.withDescription("The new options, all of them, in order (repeat for each). Leave out to keep them."),
      Flag.atLeast(0)
    ),
    show: Flag.String("show").pipe(
      Flag.withDescription(
        "Previews as on `dream ask`, replacing them all. Leave out to keep those of options that stay."
      ),
      Flag.atLeast(0)
    ),
    why: Flag.String("why").pipe(Flag.withDescription('A new reason under it; "" clears it.'), Flag.optional),
    context: Flag.String("context").pipe(
      Flag.withDescription('New context, in markdown; "" clears it, "-" reads it from stdin.'),
      Flag.optional
    ),
    meanwhile: Flag.String("meanwhile").pipe(
      Flag.withDescription('What you keep doing meanwhile; "" clears it.'),
      Flag.optional
    ),
    json
  },
  (input) =>
    Effect.gen(function* () {
      const dream = yield* Dream
      const options = input.option.length === 0 ? undefined : input.option
      const question = Option.getOrUndefined(input.question)?.trim()
      const why = Option.getOrUndefined(input.why)
      const context = yield* readOptional(input.context)
      const meanwhile = Option.getOrUndefined(input.meanwhile)
      const secret = Secrets.requestedSecret([question ?? "", why ?? "", ...input.option, context ?? ""])
      if (Option.isSome(secret)) return yield* fail(Secrets.refusal(secret.value))
      if (input.show.length > 0 && options === undefined) {
        return yield* fail("--show replaces the previews, so list the options too (--option for each).")
      }
      const previews = options === undefined ? [] : yield* previewsFor(options, input.show)
      const clear = (text: string | undefined) => (text === undefined ? undefined : text.trim() === "" ? null : text)
      const revised = yield* userFacing(
        dream.ReviseQuestion(
          defined({
            messageId: input.messageId as MessageId,
            question: question === "" ? undefined : question,
            options,
            why: clear(why),
            context: clear(context),
            meanwhile: clear(meanwhile),
            previews: input.show.length === 0 ? undefined : previews
          })
        )
      ).pipe(
        newerThanApi(
          "Nothing changed: this Dream's API predates `dream ask revise`. Withdraw the question (`dream ask withdraw`) and ask the new one instead."
        )
      )
      yield* show(input.json, QuestionMessage, revised, Format.revised(revised))
    })
).pipe(
  Command.withDescription(
    'Change an open question in place, usually because they asked for a change in its thread. The card says "Changed"; it keeps its place and doesn\'t notify again.'
  ),
  Command.withExamples([
    {
      command:
        'dream ask revise msg_\u2026 --option "A chime that gets louder" --option "Soft chime" --option "Three short buzzes"'
    }
  ])
)

const askWithdraw = Command.make("withdraw", { messageId: Argument.String("message-id"), json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const question = yield* userFacing(dream.WithdrawQuestion({ messageId: input.messageId as MessageId }))
    yield* show(input.json, QuestionMessage, question, Format.withdrawn(question))
  })
).pipe(
  Command.withDescription("Take back a question that no longer needs an answer."),
  Command.withExamples([{ command: "dream ask withdraw msg_\u2026" }])
)

const ask = Command.make(
  "ask",
  {
    question: textArgument(
      "question",
      "The question: the card's heading in large type, also in the notification, so it's the decision itself."
    ),
    option: Flag.String("option").pipe(
      Flag.withDescription(
        "An answer they can pick, shown as a button that cuts off after two lines. Repeat for each."
      ),
      Flag.atLeast(0)
    ),
    why: Flag.String("why").pipe(
      Flag.withDescription('The one-line reason shown under the question; "-" reads it from stdin.'),
      Flag.optional
    ),
    context: Flag.String("context").pipe(
      Flag.withDescription(
        'What they need to know to decide, when that takes more than a line, like the options and their trade-offs. Markdown at body size under the question: a few lines on the card, all of it when they open it. "-" reads it from stdin.'
      ),
      Flag.optional
    ),
    meanwhile: Flag.String("meanwhile").pipe(
      Flag.withDescription('What you\'ll keep doing while you wait; "-" reads it from stdin.'),
      Flag.optional
    ),
    show: Flag.String("show").pipe(
      Flag.withDescription(
        'What an option looks or sounds like: "<option>=<files>", with a file, a glob, or several separated by commas (png, jpg, mp4, mp3, m4a, wav), shown in name order. Each file\'s name becomes its caption ("2-the-clash.png" reads "The clash"). Repeat for each option.'
      ),
      Flag.atLeast(0)
    ),
    work: workFlag,
    replyTo: replyFlag,
    notASecret: Flag.Boolean("not-a-secret").pipe(
      Flag.withDescription("Send it even though it mentions a credential, because it doesn't ask them for one."),
      Flag.withDefault(false)
    ),
    json
  },
  (input) =>
    Effect.gen(function* () {
      const dream = yield* Dream
      const fromStdin = [
        Option.getOrElse(input.question, () => (stdinIsPiped() ? "-" : "")),
        Option.getOrUndefined(input.why),
        Option.getOrUndefined(input.context),
        Option.getOrUndefined(input.meanwhile)
      ].filter((text) => text === "-")
      if (fromStdin.length > 1)
        return yield* fail("Only one of the question, --why, --context and --meanwhile can come from stdin.")
      const question = yield* textFrom(input.question, 'Ask what? `dream ask "question" --option "…" --option "…"`')
      if (question.length === 0) return yield* fail("The question is empty.")
      const why = yield* readOptional(input.why)
      const context = yield* readOptional(input.context)
      const meanwhile = yield* readOptional(input.meanwhile)
      if (!input.notASecret) {
        const secret = Secrets.requestedSecret([question, why ?? "", ...input.option, context ?? ""])
        if (Option.isSome(secret)) return yield* fail(Secrets.refusal(secret.value))
      }
      const previews = yield* previewsFor(input.option, input.show)
      const asked = yield* userFacing(
        dream.AskQuestion(
          defined({
            question,
            options: input.option,
            why,
            context: context === "" ? undefined : context,
            meanwhile,
            previews: previews.length === 0 ? undefined : previews,
            workstream: workOf(input.work),
            replyTo: replyOf(input.replyTo)
          })
        )
      )
      yield* show(
        input.json,
        QuestionMessage,
        asked,
        Format.asked(asked) +
          (previews.length > 0 && asked.previews === undefined
            ? "\nDream's API here doesn't show previews yet, so they see the options as plain buttons."
            : "") +
          Format.unlabeled(workOf(input.work), asked) +
          Format.threaded(replyOf(input.replyTo), asked)
      )
    })
).pipe(
  Command.withDescription(
    "Show them a question card and notify them. Their answer arrives as an event, and shows in Chat, so never ask for a secret here; use `dream access`."
  ),
  Command.withExamples([
    {
      command:
        'dream ask "Which days should it post?" --option "Weekdays" --option "Every day" --why "So it fits your routine"'
    },
    {
      command:
        'dream ask "Which voice should the coach use?" --option "OpenAI voice" --option "Your phone\'s voice" --context "OpenAI\'s voice sounds natural and copes with interruptions, for a few cents a session. Your phone\'s own voice is free but flatter."'
    }
  ]),
  Command.withSubcommands([askRevise, askWithdraw])
)

const accessFlags = {
  why: Flag.String("why").pipe(
    Flag.withDescription(
      "The card's heading, in your words, which they read first and often alone (the lock screen): what you're asking them to connect and what it's for."
    )
  ),
  context: Flag.String("context").pipe(
    Flag.withDescription(
      'How to get it, in markdown, when it\'s a key they make themselves: a link to the exact page and what to tap there. Shown on the card and above the paste field, with links that open in Safari. "-" reads it from stdin.'
    ),
    Flag.optional
  ),
  when: Flag.String("when").pipe(
    Flag.withDescription('Roughly when it\'s needed, e.g. "around Thursday". Shows as upcoming instead of notifying.'),
    Flag.optional
  ),
  work: workFlag,
  replyTo: replyFlag,
  json
}

const requestAccess = (
  request: AccessRequest,
  input: {
    readonly why: string
    readonly context: Option.Option<string>
    readonly when: Option.Option<string>
    readonly work: Option.Option<string>
    readonly replyTo: Option.Option<string>
    readonly json: boolean
  }
) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const context = yield* readOptional(input.context)
    const requested = yield* userFacing(
      dream.RequestAccess(
        defined({
          request,
          why: input.why,
          context: context === "" ? undefined : context,
          when: Option.getOrUndefined(input.when),
          workstream: workOf(input.work),
          replyTo: replyOf(input.replyTo)
        })
      )
    )
    yield* show(
      input.json,
      AccessMessage,
      requested,
      Format.accessRequested(requested) +
        Format.unlabeled(workOf(input.work), requested) +
        Format.threaded(replyOf(input.replyTo), requested)
    )
  })

const access = Command.make("access").pipe(
  Command.withDescription(
    "Ask for access to a service. They connect it once; it works in all their projects (a key file, in this one)."
  ),
  Command.withExamples([
    {
      command:
        'dream access key --service Stripe --host api.stripe.com --header Authorization --format "Bearer {key}" --why "Add your Stripe key so the shop can take payments" --context "Make one at [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys): tap **Create secret key**, then copy it."'
    }
  ]),
  Command.withSubcommands([
    Command.make(
      "google",
      {
        scopes: Flag.String("scopes").pipe(Flag.withDescription("Comma-separated, e.g. gmail.readonly,calendar")),
        ...accessFlags
      },
      (input) => {
        const scopes = input.scopes
          .split(",")
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0)
        const [first, ...rest] = scopes
        return first === undefined
          ? fail("Name at least one scope, e.g. --scopes gmail.readonly")
          : requestAccess(AccessRequest.cases.Google.make({ scopes: [first, ...rest] }), input)
      }
    ).pipe(
      Command.withDescription("Let them sign in with Google and grant these scopes."),
      Command.withExamples([
        {
          command:
            'dream access google --scopes gmail.readonly,calendar --why "Connect Google Calendar so workouts fit around your meetings"'
        }
      ])
    ),
    Command.make(
      "key",
      {
        service: Flag.String("service").pipe(Flag.withDescription("The service's name, as they know it, like Discord")),
        host: Flag.String("host").pipe(
          Flag.withDescription(
            "The API host the key is sent to, like discord.com: a bare DNS name, no https:// or path"
          )
        ),
        header: Flag.String("header").pipe(
          Flag.withDescription("The request header that carries the key, like Authorization")
        ),
        format: Flag.String("format").pipe(
          Flag.withDescription(
            'How the key is written in the header, with {key} for the key, like "Bot {key}" or "Bearer {key}"'
          )
        ),
        ...accessFlags
      },
      (input) => {
        const hostProblem = accessHostProblem(input.host)
        if (hostProblem !== undefined) return fail(hostProblem)
        return input.format.includes("{key}")
          ? requestAccess(
              AccessRequest.cases.Key.make({
                service: input.service,
                host: input.host,
                header: input.header,
                format: input.format
              }),
              input
            )
          : fail('--format must contain {key}, e.g. "Bearer {key}".')
      }
    ).pipe(
      Command.withDescription("Let them paste an API key; Dream adds it to your HTTPS requests to --host."),
      Command.withExamples([
        {
          command:
            'dream access key --service Discord --host discord.com --header Authorization --format "Bot {key}" --why "Add your Discord bot key so it can post quotes to your channel" --context "In the [Developer Portal](https://discord.com/developers/applications), open your app, tap **Bot**, then **Reset Token**, and copy it."'
        },
        {
          command:
            'dream access key --service Stripe --host api.stripe.com --header Authorization --format "Bearer {key}" --why "Add your Stripe key so the shop can take payments" --context "Make one at [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys): tap **Create secret key**, then copy it."'
        }
      ])
    ),
    Command.make(
      "file",
      {
        service: Flag.String("service").pipe(
          Flag.withDescription("The service's name, as they know it, like Telegram")
        ),
        name: Flag.String("name").pipe(
          Flag.withDescription(
            "The key file's name in ~/.dream/keys, like telegram-bot-token (default: from --service)"
          ),
          Flag.optional
        ),
        ...accessFlags
      },
      (input) => {
        const name = Option.getOrElse(input.name, () => keyFileNameFor(input.service))
        const nameProblem = keyFileNameProblem(name)
        return nameProblem === undefined
          ? requestAccess(AccessRequest.cases.File.make({ service: input.service, name }), input)
          : fail(nameProblem)
      }
    ).pipe(
      Command.withDescription(
        "Last resort, for a key that can't go in a header: they enter it, and Dream writes it to ~/.dream/keys/<name> here, readable by any code in this sandbox."
      ),
      Command.withExamples([
        {
          command:
            'dream access file --service Telegram --name telegram-bot-token --why "Add your Telegram bot token so the bot can message you" --context "Message [@BotFather](https://t.me/BotFather), send /newbot, and copy the token it replies with."'
        }
      ])
    ),
    Command.make(
      "oauth",
      {
        provider: Argument.String("provider").pipe(
          Argument.withDescription("The service Dream connects with OAuth, like spotify, github, strava or dropbox")
        ),
        scopes: Flag.String("scopes").pipe(
          Flag.withDescription(
            "Comma-separated, in the provider's own names, e.g. user-read-private,playlist-read-private"
          ),
          Flag.optional
        ),
        ...accessFlags
      },
      (input) => {
        const scopes = Option.match(input.scopes, {
          onNone: () => [],
          onSome: (list) =>
            list
              .split(/[,\s]+/)
              .map((scope) => scope.trim())
              .filter((scope) => scope.length > 0)
        })
        const provider = input.provider.trim().toLowerCase()
        return provider.length === 0
          ? fail("Name the provider, e.g. dream access oauth spotify")
          : requestAccess(AccessRequest.cases.OAuth.make({ provider, scopes }), input)
      }
    ).pipe(
      Command.withDescription(
        "Let them sign in to a service with OAuth (Spotify, GitHub, Strava, Dropbox, Slack, Notion, …). Dream keeps the token fresh on its API hosts."
      ),
      Command.withExamples([
        {
          command:
            'dream access oauth spotify --scopes user-read-private,playlist-modify-private --why "Connect Spotify so I can build playlists from your runs"'
        },
        { command: 'dream access oauth github --scopes repo --why "Connect GitHub so the code lives in your account"' }
      ])
    ),
    Command.make("apple", accessFlags, (input) => requestAccess(AccessRequest.cases.Apple.make({}), input)).pipe(
      Command.withDescription("Ask for their App Store Connect API key, which TestFlight uploads need."),
      Command.withExamples([
        {
          command:
            'dream access apple --why "Add your App Store Connect key so the app can go on TestFlight" --when "around Thursday"'
        }
      ])
    ),
    Command.make("list", { json }, (input) =>
      Effect.gen(function* () {
        const dream = yield* Dream
        const list = yield* userFacing(dream.ListAccess())
        yield* show(input.json, Schema.Array(Integration), list, Format.integrations(list))
      })
    ).pipe(Command.withDescription("What they've already connected. All of it works here."))
  ])
)

// ---------------------------------------------------------------------------
// Notifications from the project's apps
// ---------------------------------------------------------------------------

/** Against an API from before app notifications. */
const notifyUnknown =
  "Nothing was sent: this Dream's API predates notifications from apps, so `dream notify` can't send as an app here yet. Until it can, `dream message --notify` reaches them in your own voice."

const notifying = <A, E, R>(effect: Effect.Effect<A, E, R>) => userFacing(effect).pipe(newerThanApi(notifyUnknown))

const appIdOf = (text: string) =>
  Effect.mapError(
    Schema.decodeUnknownEffect(AppId)(text.trim()),
    () =>
      new CliError.UserError({
        cause: text,
        userMessage: `"${text}" isn't an app id: lowercase words joined by hyphens, 40 characters at most, like fare-watch.`
      })
  )

const appFlag = Flag.String("app").pipe(
  Flag.withDescription("The app it comes from, as set up with `dream notify setup <app>`."),
  Flag.optional
)

const notifySetup = Command.make(
  "setup",
  {
    app: Argument.String("app").pipe(
      Argument.withDescription(
        "An id for the app, lowercase words joined by hyphens (fare-watch); its code sends with --app <id>."
      )
    ),
    name: Flag.String("name").pipe(
      Flag.withDescription("The name its notifications are titled with, as they know the app. 30 characters at most.")
    ),
    why: Flag.String("why").pipe(
      Flag.withDescription(
        `What it will tell them: the card's heading, under "Let <name> notify you", e.g. "When a fare you're watching drops below your target".`
      )
    ),
    often: Flag.String("often").pipe(
      Flag.withDescription('How often, as the card says it: "A few times a week at most", "Once a day, at 7".')
    ),
    icon: Flag.String("icon").pipe(
      Flag.withDescription("Its tile: an SF Symbol name (airplane) or one emoji. Without it, the name's first letter."),
      Flag.optional
    ),
    color: Flag.Literals("color", LinkColor.literals).pipe(
      Flag.withDescription("The tile's colour behind the glyph."),
      Flag.optional
    ),
    url: Flag.String("url").pipe(
      Flag.withDescription(
        "Where a tap goes when a notification names no page: your published URL or a path on it (/today). Without it, a tap opens the notification in the project."
      ),
      Flag.optional
    ),
    work: workFlag,
    json
  },
  (input) =>
    Effect.gen(function* () {
      const dream = yield* Dream
      const app = yield* appIdOf(input.app)
      const name = input.name.trim()
      if (name.length === 0) return yield* fail("--name is empty: it's what their notifications are titled with.")
      if (/[\n\r\t]/.test(name)) return yield* fail("--name has to be one line.")
      if ([...name].length > 30) return yield* fail(`--name "${name}" is ${[...name].length} characters; 30 at most.`)
      const why = input.why.trim()
      const often = input.often.trim()
      if (why.length === 0) return yield* fail("--why is empty: it's what the app will tell them, the card's heading.")
      if (often.length === 0) return yield* fail("--often is empty: say how often it will notify them.")
      const icon = Option.isSome(input.icon) ? yield* iconOf(input.icon.value) : null
      if (icon?._tag === "Image") return yield* fail("--icon is an SF Symbol name or one emoji here, not an image.")
      const result = yield* notifying(
        dream.SetUpAppNotifications(
          defined({
            app,
            name,
            why,
            often,
            icon: icon ?? undefined,
            color: Option.getOrUndefined(input.color),
            url: Option.getOrUndefined(input.url)?.trim() || undefined,
            workstream: workOf(input.work)
          })
        )
      )
      yield* show(
        input.json,
        Schema.Struct({ app: AppSender, card: AccessMessage }),
        result,
        Format.appSetUp(result.app, result.card)
      )
    })
).pipe(
  Command.withDescription(
    "Ready one of your apps to notify them under its own name. It puts a card in Chat asking them to allow it; until they do, nothing it sends reaches them."
  ),
  Command.withExamples([
    {
      command:
        'dream notify setup fare-watch --name "Fare watch" --icon airplane --color blue --why "When a fare you\'re watching drops below your target" --often "A few times a week at most" --url /'
    }
  ])
)

const notifyList = Command.make(
  "list",
  {
    app: appFlag,
    json
  },
  (input) =>
    Effect.gen(function* () {
      const dream = yield* Dream
      const app = Option.isSome(input.app) ? yield* appIdOf(input.app.value) : undefined
      const result = yield* notifying(dream.ListAppNotifications(defined({ app })))
      yield* show(input.json, AppNotifications, result, Format.appNotifications(result, yield* now))
    })
).pipe(
  Command.withDescription(
    "Your apps that notify them, how they've chosen to hear from each, and what each sent in the last 30 days: what happened to it, and which they opened."
  )
)

const notifyWithdraw = Command.make("withdraw", { notificationId: Argument.String("notification-id") }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    yield* userFacing(dream.WithdrawNotification({ notificationId: input.notificationId as NotificationId }))
    yield* Console.log(`Withdrew notification ${input.notificationId}.`)
  })
).pipe(
  Command.withDescription("Remove a notification that no longer applies: one you sent, or one of your apps'."),
  Command.withExamples([{ command: "dream notify withdraw <notification-id>" }])
)

const notify = Command.make(
  "notify",
  {
    text: textArgument("text", "What it tells them, in plain text. The lock screen shows about four lines."),
    app: appFlag,
    title: Flag.String("title").pipe(Flag.withDescription("A bold headline above the text, one line."), Flag.optional),
    url: Flag.String("url").pipe(
      Flag.withDescription(
        "Where a tap goes: a page of your published URL, or a path on it (/routes/lis). Without it, the app's page from setup."
      ),
      Flag.optional
    ),
    key: Flag.String("key").pipe(
      Flag.withDescription(
        "What it's about. A newer one with the same key replaces the older on their lock screen instead of stacking."
      ),
      Flag.optional
    ),
    quiet: Flag.Boolean("quiet").pipe(
      Flag.withDescription("Deliver it to Notification Center without a sound or lighting their screen."),
      Flag.withDefault(false)
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Check it and print what would happen, without sending or keeping anything."),
      Flag.withDefault(false)
    ),
    json
  },
  (input) =>
    Effect.gen(function* () {
      const dream = yield* Dream
      if (Option.isNone(input.app)) {
        return yield* fail(
          'Say which app it comes from: `dream notify --app <app> "…"` (`dream notify setup` readies one). To tell them something yourself, use `dream message --notify`.'
        )
      }
      const app = yield* appIdOf(input.app.value)
      const text = (yield* textFrom(input.text, 'Say what: `dream notify --app <app> "…"`, or pipe it in.')).trim()
      if (text.length === 0) return yield* fail("The text is empty.")
      if ([...text].length > 500) return yield* fail(`The text is ${[...text].length} characters; 500 at most.`)
      const title = Option.getOrUndefined(input.title)?.trim() || undefined
      if (title !== undefined && /[\n\r]/.test(title)) return yield* fail("--title has to be one line.")
      if (title !== undefined && [...title].length > 80) {
        return yield* fail(`--title is ${[...title].length} characters; 80 at most.`)
      }
      const key = Option.getOrUndefined(input.key)?.trim() || undefined
      if (key !== undefined && [...key].length > 64) return yield* fail("--key is 64 characters at most.")
      const sent = yield* notifying(
        dream.SendAppNotification(
          defined({
            app,
            text,
            title,
            url: Option.getOrUndefined(input.url)?.trim() || undefined,
            key,
            quiet: input.quiet,
            dryRun: input.dryRun
          })
        )
      )
      yield* show(input.json, AppNotification, sent, Format.appNotified(sent, input.dryRun))
    })
).pipe(
  Command.withDescription(
    "Notify them as one of your apps, under its own name, from any process here. It exits 0 whenever the app did its part, including when Dream held it back; it fails only when the call is wrong."
  ),
  Command.withExamples([
    {
      command:
        'dream notify --app fare-watch --key lis --title "Lisbon dropped to $412" --url /routes/lis "Round trip May 14–21, down $90 since Monday."'
    }
  ]),
  Command.withSubcommands([notifySetup, notifyList, notifyWithdraw])
)

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const Milestones = Schema.fromJsonString(Schema.toCodecJson(Schema.Array(Milestone)))

const lineFlag = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(`${description} Pass "" to clear it.`), Flag.optional)

const status = Command.make(
  "status",
  {
    phase: Flag.Literals("phase", ProjectPhase.literals).pipe(
      Flag.withDescription("Where the project stands: new, interviewing, exploring, building or live."),
      Flag.optional
    ),
    title: Flag.String("title").pipe(Flag.withDescription("The project's name on their Home screen."), Flag.optional),
    kind: lineFlag("kind", "What it is, e.g. Web app, iOS app, Background worker."),
    icon: lineFlag("icon", "SF Symbol name for the project tile, e.g. dumbbell."),
    now: lineFlag(
      "now",
      "One sentence on what you're doing now, best kept to one line on the card above their Chat (about 35 characters); it shows up to two, then cuts. Large when they open it, and under the project's name on Home."
    ),
    justDid: lineFlag("just-did", "No longer shown in the app; kept so older scripts still run."),
    next: lineFlag("next", "No longer shown in the app; kept so older scripts still run."),
    media: mediaFlag,
    milestones: Flag.String("milestones").pipe(
      Flag.withDescription(
        'A JSON file with the whole milestone list, each shown as its title and date: [{"title","state":"done|current|upcoming","date"?,"needs":[{"what","when"?,"messageId"?}]}]. A need\'s "what" is a short noun phrase, shown as "Needs …" in amber while the question or access request in its messageId is open.'
      ),
      Flag.optional
    ),
    json
  },
  (input) =>
    Effect.gen(function* () {
      const dream = yield* Dream
      const fs = yield* FileSystem.FileSystem
      const milestones = yield* Option.match(input.milestones, {
        onNone: () => Effect.succeed(undefined),
        onSome: (file) =>
          fs.readFileString(file).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Milestones)),
            Effect.mapError(
              (cause) =>
                new CliError.UserError({
                  cause,
                  userMessage: `Couldn't read milestones from ${file}: ${cause.message}`
                })
            )
          )
      })
      const media: Array<MediaId> = []
      for (const file of input.media) media.push((yield* upload(file)).id)
      const update = defined({
        phase: Option.getOrUndefined(input.phase),
        title: Option.getOrUndefined(input.title),
        kind: patch(input.kind),
        icon: patch(input.icon),
        now: patch(input.now),
        justDid: patch(input.justDid),
        next: patch(input.next),
        media: media.length > 0 ? media : undefined,
        milestones
      })
      const card =
        Object.keys(update).length === 0
          ? yield* userFacing(dream.GetStatus())
          : yield* userFacing(dream.UpdateStatus(update))
      yield* show(input.json, StatusCard, card, Format.status(card, yield* now))
    })
).pipe(
  Command.withDescription(
    "Show the Status card, or update it with any of the flags. Either way it prints what they'll see."
  ),
  Command.withExamples([
    { command: 'dream status --now "Building the progress charts"' },
    { command: "dream status --milestones milestones.json --media charts.png" }
  ])
)

// ---------------------------------------------------------------------------
// Workstreams
// ---------------------------------------------------------------------------

/** Against an API from before workstreams. */
const workUnknown =
  "Nothing changed: this Dream's API predates workstreams, so `dream work` isn't available here yet. Until it is, the Status card's --now sentence is the one line they see; say what's going on there, and in your messages."

const work = <A, E, R>(effect: Effect.Effect<A, E, R>) => userFacing(effect).pipe(newerThanApi(workUnknown))

const workstreamId = Argument.String("workstream-id").pipe(Argument.withDescription("The workstream (ws_…)."))

const workTitle = (title: string) =>
  title.trim().length === 0
    ? fail("The title is empty.")
    : [...title.trim()].length > WorkstreamTitleMaxLength
      ? fail(
          `"${title.trim()}" is ${[...title.trim()].length} characters; a workstream's title is ${WorkstreamTitleMaxLength} at most, and a row fits about 30. A few words that name it, like "Double charges".`
        )
      : Effect.succeed(title.trim())

const showWork = (asJson: boolean, report: Workstreams, lead: string) =>
  Effect.gen(function* () {
    yield* show(asJson, Workstreams, report, `${lead}\n${Format.workstreams(report, yield* now)}`)
  })

const workList = Command.make("list", { json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const report = yield* work(dream.ListWorkstreams())
    yield* show(input.json, Workstreams, report, Format.workstreams(report, yield* now))
  })
).pipe(Command.withDescription("Every workstream, and what the card shows of them."))

const workStart = Command.make(
  "start",
  {
    title: Argument.String("title").pipe(
      Argument.withDescription(
        'What it is, in a few words: the row\'s first line and its label in Chat ("Double charges").'
      )
    ),
    now: Flag.String("now").pipe(
      Flag.withDescription("Where it stands, one short line under the title."),
      Flag.optional
    ),
    from: Flag.String("from").pipe(
      Flag.withDescription("The message that started it (msg_…, usually theirs): it's filed under the new workstream."),
      Flag.optional
    ),
    json
  },
  (input) =>
    Effect.gen(function* () {
      const dream = yield* Dream
      const title = yield* workTitle(input.title)
      const report = yield* work(
        dream.StartWorkstream(
          defined({
            title,
            now: Option.getOrUndefined(input.now)?.trim() || undefined,
            from: Option.getOrUndefined(input.from)?.trim() as MessageId | undefined
          })
        )
      )
      const started = report.workstreams.findLast((w) => w.title === title && w.state === "active")
      yield* showWork(input.json, report, `Started ${started?.id ?? title}. Nothing was sent to them.`)
    })
).pipe(
  Command.withDescription(
    "Start a workstream: a line of work they might ask about on its own. With two or more active, the card shows a row for each."
  ),
  Command.withExamples([{ command: 'dream work start "Double charges" --now "Reproducing it" --from msg_\u2026' }])
)

const workUpdate = Command.make(
  "update",
  {
    workstreamId,
    title: Flag.String("title").pipe(Flag.withDescription("A new title."), Flag.optional),
    now: Flag.String("now").pipe(
      Flag.withDescription('Where it stands now, one short line; "" clears it.'),
      Flag.optional
    ),
    json
  },
  (input) =>
    Effect.gen(function* () {
      const dream = yield* Dream
      const title = Option.isSome(input.title) ? yield* workTitle(input.title.value) : undefined
      const nowLine = patch(input.now)
      if (title === undefined && nowLine === undefined) return yield* fail("Say what changes: --now and/or --title.")
      const report = yield* work(
        dream.UpdateWorkstream(defined({ workstreamId: input.workstreamId as WorkstreamId, title, now: nowLine }))
      )
      yield* showWork(input.json, report, `Updated ${input.workstreamId}: only its row changed, with no message.`)
    })
).pipe(
  Command.withDescription("Change a workstream's row. It's silent: nothing reaches Chat or their lock screen."),
  Command.withExamples([{ command: 'dream work update ws_\u2026 --now "Testing the fix on a slow network"' }])
)

const workEnd = (state: "done" | "dropped") =>
  Command.make(
    state === "done" ? "done" : "drop",
    {
      workstreamId,
      result: Flag.String(state === "done" ? "result" : "why").pipe(
        Flag.withDescription(
          state === "done"
            ? 'What came of it, a few words on the card\'s last line ("Fixed, refunds sent").'
            : "Why, for your own record; they don't see it."
        ),
        Flag.optional
      ),
      json
    },
    (input) =>
      Effect.gen(function* () {
        const dream = yield* Dream
        const result = Option.getOrUndefined(input.result)?.trim()
        const report = yield* work(
          dream.EndWorkstream(
            defined({ workstreamId: input.workstreamId as WorkstreamId, state, result: result || undefined })
          )
        )
        yield* showWork(
          input.json,
          report,
          state === "done"
            ? `${input.workstreamId} is done: it folds into the card's last line. Nothing was sent to them; if it's worth their attention, say so in a message.`
            : `Dropped ${input.workstreamId}: it's off the card. Nothing was sent to them.`
        )
      })
  ).pipe(
    Command.withDescription(
      state === "done" ? "Mark a workstream done." : "Drop a workstream that's no longer its own thing."
    ),
    Command.withExamples([
      {
        command:
          state === "done"
            ? 'dream work done ws_\u2026 --result "Fixed, refunds sent"'
            : 'dream work drop ws_\u2026 --why "Folded into the redesign"'
      }
    ])
  )

const workRoute = Command.make("route", { messageId: Argument.String("message-id"), workstreamId, json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const routed = yield* work(
      dream.RouteMessage({
        messageId: input.messageId as MessageId,
        workstreamId: input.workstreamId as WorkstreamId
      })
    )
    yield* show(
      input.json,
      Message,
      routed,
      `Filed ${routed.id} under ${input.workstreamId}: it carries that label in Chat. Nothing was sent to them.`
    )
  })
).pipe(
  Command.withDescription("File a message (usually theirs) under a workstream, so it carries that label."),
  Command.withExamples([{ command: "dream work route msg_\u2026 ws_\u2026" }])
)

const workCommand = Command.make("work", { json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const report = yield* work(dream.ListWorkstreams())
    yield* show(input.json, Workstreams, report, Format.workstreams(report, yield* now))
  })
).pipe(
  Command.withDescription(
    "Workstreams: the separate things you're running at once, each a row on the Status card while two or more are active."
  ),
  Command.withSubcommands([workList, workStart, workUpdate, workEnd("done"), workEnd("dropped"), workRoute])
)

const liveFlags = {
  title: Flag.String("title").pipe(
    Flag.withDescription('The big line, two lines of large type at most, e.g. "Building progress charts" (≤ 80).')
  ),
  detail: Flag.String("detail").pipe(
    Flag.withDescription("A supporting line, shown on one line (≤ 120)."),
    Flag.optional
  ),
  next: Flag.String("next").pipe(Flag.withDescription('Shown as "Next · …" (≤ 80).'), Flag.optional),
  step: Flag.String("step").pipe(Flag.withDescription("Progress through milestones, e.g. 3/5."), Flag.optional),
  badge: Flag.String("badge").pipe(Flag.withDescription('Small corner label, e.g. "Day 3" (≤ 20).'), Flag.optional)
}

const liveContent = (input: {
  readonly title: string
  readonly detail: Option.Option<string>
  readonly next: Option.Option<string>
  readonly step: Option.Option<string>
  readonly badge: Option.Option<string>
}) =>
  Effect.gen(function* () {
    const step = yield* Option.match(input.step, {
      onNone: () => Effect.succeed(undefined),
      onSome: (text) => fromResult(Parse.parseStep(text))
    })
    return yield* Schema.decodeUnknownEffect(LiveActivityContent)(
      defined({
        title: input.title,
        detail: Option.getOrUndefined(input.detail),
        next: Option.getOrUndefined(input.next),
        step,
        badge: Option.getOrUndefined(input.badge)
      })
    ).pipe(Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })))
  })

const live = Command.make("live").pipe(
  Command.withDescription("A Live Activity on their lock screen and Dynamic Island; iOS ends it after about 8 hours."),
  Command.withSubcommands([
    Command.make("start", liveFlags, (input) =>
      Effect.gen(function* () {
        const dream = yield* Dream
        yield* userFacing(dream.StartLiveActivity({ content: yield* liveContent(input) }))
        yield* Console.log("Started the Live Activity.")
      })
    ).pipe(
      Command.withDescription("Start one (replacing any that's running)."),
      Command.withExamples([
        { command: 'dream live start --title "Building progress charts" --step 3/5 --badge "Day 3"' }
      ])
    ),
    Command.make("update", liveFlags, (input) =>
      Effect.gen(function* () {
        const dream = yield* Dream
        yield* userFacing(dream.UpdateLiveActivity({ content: yield* liveContent(input) }))
        yield* Console.log("Updated the Live Activity.")
      })
    ).pipe(
      Command.withDescription("Change what it shows."),
      Command.withExamples([{ command: 'dream live update --title "Deploying" --step 4/5' }])
    ),
    Command.make("end", { ...liveFlags, title: liveFlags.title.pipe(Flag.optional) }, (input) =>
      Effect.gen(function* () {
        const dream = yield* Dream
        const content = yield* Option.match(input.title, {
          onNone: () => Effect.succeed(undefined),
          onSome: (title) => liveContent({ ...input, title })
        })
        yield* userFacing(dream.EndLiveActivity(defined({ content })))
        yield* Console.log("Ended the Live Activity.")
      })
    ).pipe(
      Command.withDescription("End it, optionally with final content."),
      Command.withExamples([{ command: 'dream live end --title "Done: progress charts are live"' }])
    )
  ])
)

// ---------------------------------------------------------------------------
// Waking
// ---------------------------------------------------------------------------

const wakeList = Command.make("list", { json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const list = yield* userFacing(dream.ListWakes())
    yield* show(input.json, Schema.Array(Wake), list, Format.wakes(list, yield* now))
  })
).pipe(Command.withDescription("Show scheduled wake-ups."))

const wakeCancel = Command.make("cancel", { wakeId: Argument.String("wake-id") }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    yield* userFacing(dream.CancelWake({ wakeId: input.wakeId as WakeId }))
    yield* Console.log(`Cancelled ${input.wakeId}.`)
  })
).pipe(
  Command.withDescription("Remove a scheduled wake-up."),
  Command.withExamples([{ command: "dream wake cancel wak_\u2026" }])
)

const wake = Command.make(
  "wake",
  {
    why: Argument.String("why").pipe(Argument.optional),
    at: Flag.String("at").pipe(
      Flag.withDescription("When: an ISO time with a zone (2026-11-05T07:00:00-08:00) or a span (30m, 2h, 1d)."),
      Flag.optional
    ),
    cron: Flag.String("cron").pipe(
      Flag.withDescription('Repeat on a five-field cron schedule, e.g. "0 7 * * *" (7:00 where they are).'),
      Flag.optional
    ),
    timeZone: Flag.String("tz").pipe(Flag.withDescription("Time zone for --cron; defaults to theirs."), Flag.optional),
    run: Flag.String("run").pipe(
      Flag.withDescription("A command to run when it fires; you're only woken if it fails."),
      Flag.optional
    ),
    task: Flag.String("task").pipe(
      Flag.withDescription(
        'A task to run in a session of its own when it fires, from this brief alone: "-" reads it from stdin. ' +
          "Needs --model and --effort. You're only woken if it fails, or if it wakes you."
      ),
      Flag.optional
    ),
    model: Flag.String("model").pipe(
      Flag.withDescription("The task's model, named as your subagents' are."),
      Flag.optional
    ),
    effort: Flag.Literals("effort", ReasoningEffort.literals).pipe(
      Flag.withDescription("The task's reasoning effort."),
      Flag.optional
    ),
    json
  },
  (input) =>
    Effect.gen(function* () {
      const dream = yield* Dream
      const why = Option.getOrUndefined(input.why)
      if (why === undefined || why.trim().length === 0) {
        return yield* fail('Say why: `dream wake "why"`, or `dream wake --at 2h "why"`.')
      }
      if (Option.isSome(input.run) && Option.isSome(input.task)) return yield* fail("Use --run or --task, not both.")
      if (Option.isNone(input.task) && (Option.isSome(input.model) || Option.isSome(input.effort))) {
        return yield* fail("--model and --effort go with --task.")
      }
      if (Option.isNone(input.at) && Option.isNone(input.cron)) {
        if (Option.isSome(input.run)) return yield* fail("--run needs --at or --cron.")
        if (Option.isSome(input.task)) return yield* fail("--task needs --at or --cron.")
        yield* userFacing(dream.WakeNow({ why }))
        return yield* Console.log("Woke the agent.")
      }
      if (Option.isSome(input.at) && Option.isSome(input.cron)) return yield* fail("Use --at or --cron, not both.")
      const when = Option.isSome(input.at)
        ? WakeWhen.cases.At.make({ at: yield* fromResult(Parse.parseAt(input.at.value, yield* now)) })
        : WakeWhen.cases.Cron.make(
            defined({
              expression: yield* fromResult(Parse.checkCron(Option.getOrThrow(input.cron))),
              timeZone: Option.getOrUndefined(input.timeZone)
            })
          )
      const taskText = input.task
      const task = Option.isNone(taskText)
        ? undefined
        : yield* Effect.gen(function* () {
            if (Option.isNone(input.model) || Option.isNone(input.effort)) {
              return yield* fail(
                "A task needs --model and --effort: the model and reasoning effort its session runs on."
              )
            }
            const brief = (yield* readText(taskText.value)).trim()
            if (brief.length === 0) return yield* fail("The task's brief is empty.")
            return { brief, model: input.model.value, effort: input.effort.value }
          })
      const scheduled = yield* userFacing(
        dream.ScheduleWake(defined({ when, why, run: Option.getOrUndefined(input.run), task }))
      )
      yield* show(input.json, Wake, scheduled, Format.scheduled(scheduled, yield* now))
    })
).pipe(
  Command.withDescription(
    'Wake the agent now (`dream wake "why"`, e.g. from an error handler), or schedule a wake-up with --at or --cron.'
  ),
  Command.withExamples([
    { command: 'dream wake --at 2h "Check the deploy"' },
    { command: 'dream wake --cron "0 7 * * *" "Send the morning summary"' },
    {
      command:
        'dream wake --cron "15 5 * * 1" --task - --model sonnet --effort medium "Monday episode" < episode-brief.md'
    }
  ]),
  Command.withSubcommands([wakeList, wakeCancel])
)

// ---------------------------------------------------------------------------
// Relays
// ---------------------------------------------------------------------------

const relayFlags = {
  to: Flag.String("to").pipe(
    Flag.withDescription("The path on your app each event is POSTed to, e.g. /hooks/discord.")
  ),
  port: Flag.Int("port").pipe(
    Flag.withDescription("Your app's port in this sandbox. Leave it out to use the published port."),
    Flag.optional
  ),
  label: Flag.String("label").pipe(Flag.withDescription("A name for it in `dream relay list`."), Flag.optional),
  json
}

const relayTarget = (input: { readonly to: string; readonly port: Option.Option<number> }) =>
  Effect.gen(function* () {
    const problem = relayPathProblem(input.to)
    if (problem !== undefined) return yield* fail(problem)
    return defined({ path: input.to, port: Option.getOrUndefined(input.port) })
  })

const addRelay = (
  source: RelaySource,
  input: {
    readonly to: string
    readonly port: Option.Option<number>
    readonly label: Option.Option<string>
    readonly json: boolean
  }
) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const target = yield* relayTarget(input)
    const added = yield* userFacing(
      dream.AddRelay(defined({ source, target, label: Option.getOrUndefined(input.label) }))
    )
    yield* show(input.json, Relay, added, Format.relayAdded(added, yield* now))
  })

const relayDiscord = Command.make(
  "discord",
  {
    ...relayFlags,
    key: Flag.String("key").pipe(
      Flag.withDescription(
        "The id of their Discord bot key (`dream access list`). Leave it out when they have exactly one."
      ),
      Flag.optional
    ),
    events: Flag.String("events").pipe(
      Flag.withDescription(`Gateway events to forward, comma-separated (default ${DiscordDefaultEvents.join(",")}).`),
      Flag.optional
    ),
    mentions: Flag.Boolean("mentions").pipe(
      Flag.withDescription("Forward only messages that mention the bot, reply to it, or are sent to it directly."),
      Flag.withDefault(false)
    ),
    channel: Flag.String("channel").pipe(
      Flag.withDescription("Forward only events in this channel id. Repeat for more."),
      Flag.atLeast(0)
    ),
    intents: Flag.Int("intents").pipe(
      Flag.withDescription(
        `Gateway intents as a number (default ${DiscordDefaultIntents}: servers, messages, DMs, message content).`
      ),
      Flag.optional
    )
  },
  (input) =>
    Effect.gen(function* () {
      const events = Option.match(input.events, {
        onNone: () => DiscordDefaultEvents,
        onSome: (list) =>
          list
            .split(",")
            .map((event) => event.trim().toUpperCase())
            .filter((event) => event.length > 0)
      })
      const [first, ...rest] = events
      if (first === undefined) return yield* fail("Name at least one event with --events, like MESSAGE_CREATE.")
      yield* addRelay(
        RelaySource.cases.Discord.make(
          defined({
            integrationId: Option.getOrUndefined(input.key) as IntegrationId | undefined,
            intents: Option.getOrElse(input.intents, () => DiscordDefaultIntents),
            events: [first, ...rest] as const,
            mentionsOnly: input.mentions,
            channels: input.channel.length === 0 ? undefined : input.channel
          })
        ),
        input
      )
    })
).pipe(
  Command.withDescription(
    "Hold the bot's Discord Gateway session open from Dream and POST each event (MESSAGE_CREATE by default) to your app."
  ),
  Command.withExamples([{ command: "dream relay discord --to /hooks/discord --port 3000 --mentions" }])
)

const relayWebSocket = Command.make(
  "websocket",
  {
    url: Argument.String("url").pipe(Argument.withDescription("The feed's wss:// URL.")),
    ...relayFlags,
    send: Flag.String("send").pipe(
      Flag.withDescription("A message to send after each connect, like a subscribe. Repeat for more, in order."),
      Flag.atLeast(0)
    ),
    key: Flag.String("key").pipe(
      Flag.withDescription("The id of one of their keys (`dream access list`) whose header goes on the connection."),
      Flag.optional
    ),
    ping: Flag.String("ping").pipe(
      Flag.withDescription("A message to send every --ping-every seconds, for feeds that drop quiet clients."),
      Flag.optional
    ),
    pingEvery: Flag.Int("ping-every").pipe(
      Flag.withDescription("Seconds between pings (default 30)."),
      Flag.withDefault(30)
    ),
    silence: Flag.Int("silence").pipe(
      Flag.withDescription("Reconnect when nothing arrives for this many seconds."),
      Flag.optional
    ),
    match: Flag.String("match").pipe(Flag.withDescription("Forward only messages containing this text."), Flag.optional)
  },
  (input) =>
    Effect.gen(function* () {
      const problem = relayUrlProblem(input.url)
      if (problem !== undefined) return yield* fail(problem)
      yield* addRelay(
        RelaySource.cases.WebSocket.make(
          defined({
            url: input.url,
            send: input.send,
            integrationId: Option.getOrUndefined(input.key) as IntegrationId | undefined,
            ping: Option.match(input.ping, {
              onNone: () => undefined,
              onSome: (message) => ({ message, everySeconds: input.pingEvery })
            }),
            silenceSeconds: Option.getOrUndefined(input.silence),
            match: Option.getOrUndefined(input.match)
          })
        ),
        input
      )
    })
).pipe(
  Command.withDescription("Hold a WebSocket feed open from Dream and POST each message to your app."),
  Command.withExamples([
    {
      command:
        'dream relay websocket wss://ws-feed.exchange.coinbase.com --send \'{"type":"subscribe","product_ids":["BTC-USD"],"channels":["ticker"]}\' --to /hooks/prices --port 3000'
    }
  ])
)

const relayList = Command.make("list", { json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const list = yield* userFacing(dream.ListRelays())
    yield* show(input.json, Schema.Array(Relay), list, Format.relays(list, yield* now))
  })
).pipe(Command.withDescription("Each relay with its state, what's waiting, and recent problems."))

const relayRemove = Command.make("remove", { relayId: Argument.String("relay-id") }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    yield* userFacing(dream.RemoveRelay({ relayId: input.relayId as RelayId }))
    yield* Console.log(`Removed ${input.relayId}; its line is closed and what was waiting is dropped.`)
  })
).pipe(
  Command.withDescription("Close a relay's line and drop what's waiting."),
  Command.withExamples([{ command: "dream relay remove rly_abc123" }])
)

const relayRestart = Command.make("restart", { relayId: Argument.String("relay-id"), json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const restarted = yield* userFacing(dream.RestartRelay({ relayId: input.relayId as RelayId }))
    yield* show(input.json, Relay, restarted, `Restarting.\n${Format.relay(restarted, yield* now)}`)
  })
).pipe(
  Command.withDescription("Open a relay's line afresh, e.g. once a failed one's cause is fixed."),
  Command.withExamples([{ command: "dream relay restart rly_abc123" }])
)

const relay = Command.make("relay", { json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const list = yield* userFacing(dream.ListRelays())
    yield* show(input.json, Schema.Array(Relay), list, Format.relays(list, yield* now))
  })
).pipe(
  Command.withDescription(
    "Have Dream hold a line open while the sandbox sleeps (Discord's Gateway, a WebSocket feed) and POST each event to your app."
  ),
  Command.withSubcommands([relayDiscord, relayWebSocket, relayList, relayRemove, relayRestart])
)

// ---------------------------------------------------------------------------
// Hosting and media
// ---------------------------------------------------------------------------

const publish = Command.make(
  "publish",
  { port: Flag.Int("port").pipe(Flag.withDescription("The local port your app listens on.")), json },
  (input) =>
    Effect.gen(function* () {
      const dream = yield* Dream
      const pages = yield* PageCheck
      const published = yield* userFacing(dream.Publish({ port: input.port }))
      // The check is information for the agent; it never fails the publish.
      const check = yield* pages.check(published.url).pipe(
        Effect.map((load) => ({ load, text: Format.pageCheck(load) })),
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause)
          const reason = error instanceof Error ? error.message : String(error)
          return Effect.succeed({ load: undefined, text: `Couldn't check it from this sandbox: ${reason}.` })
        })
      )
      yield* show(
        input.json,
        Schema.Struct({ url: Schema.String, check: Schema.optionalKey(PageLoad) }),
        check.load === undefined ? published : { ...published, check: check.load },
        `Port ${input.port} is public at ${published.url}. Requests to it wake the sandbox.\n${check.text}`
      )
    })
).pipe(
  Command.withDescription(
    "Give a port the project's stable public URL, then load it from here and print what it answers. Run it again to re-check."
  ),
  Command.withExamples([{ command: "dream publish --port 3000" }])
)

const media = Command.make("media").pipe(
  Command.withDescription("Upload screenshots and recordings."),
  Command.withSubcommands([
    Command.make(
      "upload",
      {
        file: Argument.String("file"),
        caption: Flag.String("caption").pipe(
          Flag.withDescription("A short label: one line under it in Chat, in full when they open it."),
          Flag.optional
        ),
        json
      },
      (input) =>
        Effect.gen(function* () {
          const ref = yield* upload(input.file, Option.getOrUndefined(input.caption))
          yield* show(input.json, MediaRef, ref, `Uploaded ${Format.uploaded(ref)}.`)
        })
    ).pipe(
      Command.withDescription("Upload a png, jpg or mp4 and print its media id."),
      Command.withExamples([{ command: 'dream media upload shot.png --caption "Home screen"' }])
    )
  ])
)

// ---------------------------------------------------------------------------
// App links on their Home
// ---------------------------------------------------------------------------

const linkFlags = {
  title: Flag.String("title").pipe(
    Flag.withDescription(
      `The label under the tile, and the app's name if they add it to their iPhone's Home Screen. ${LinkTitleMaxLength} characters at most; about ten fit under the tile.`
    )
  ),
  icon: Flag.String("icon").pipe(
    Flag.withDescription(
      "What's on the tile: an SF Symbol name (dumbbell), one emoji, or a square png or jpg of at least 180 px that fills the tile edge to edge. Without it, the title's first letter."
    )
  ),
  color: Flag.Literals("color", LinkColor.literals).pipe(
    Flag.withDescription("The tile's colour behind a symbol, emoji or letter. Light and yellow get a dark glyph.")
  )
}

const titleOf = (title: string) => {
  const text = title.trim()
  if (text.length === 0) return fail("--title is empty: it's the label under the tile.")
  if (/[\n\r\t]/.test(text)) return fail("--title has to be one line.")
  if ([...text].length > LinkTitleMaxLength) {
    return fail(
      `--title "${text}" is ${[...text].length} characters; a link's title is ${LinkTitleMaxLength} at most, and about ten fit under its tile.`
    )
  }
  return Effect.succeed(text)
}

const urlOf = (url: string) => {
  const problem = linkUrlProblem(url.trim())
  return problem === undefined ? Effect.succeed(url.trim()) : fail(`The link "${url}" ${problem}.`)
}

/** `--icon` as a tile glyph; a file is checked and uploaded. `null`: clear it (update only). */
const iconOf = (text: string) =>
  Effect.gen(function* () {
    const input = yield* fromResult(Parse.iconInput(text))
    switch (input._tag) {
      case "Clear":
        return null
      case "Symbol":
        return LinkIcon.cases.Symbol.make({ name: input.name })
      case "Emoji":
        return LinkIcon.cases.Emoji.make({ emoji: input.emoji })
      case "File": {
        const fs = yield* FileSystem.FileSystem
        const bytes = yield* fs
          .readFile(input.path)
          .pipe(Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: `Can't read ${input.path}.` })))
        const problem = Parse.iconImageProblem(input.path, Parse.imageSize(bytes))
        if (problem !== undefined) return yield* fail(problem)
        return LinkIcon.cases.Image.make({ media: yield* upload(input.path) })
      }
    }
  })

const linkList = Command.make("list", { json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const result = yield* userFacing(dream.ListLinks())
    yield* show(input.json, ProjectLinks, result, Format.links(result, yield* now))
  })
).pipe(Command.withDescription("This project's links on their Home, theirs too, and the ones they removed."))

const link = Command.make("link", { json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const result = yield* userFacing(dream.ListLinks())
    yield* show(input.json, ProjectLinks, result, Format.links(result, yield* now))
  })
).pipe(
  Command.withDescription(
    "App icons at the top of their Home that open what you've made. With no subcommand, lists this project's."
  ),
  Command.withSubcommands([
    Command.make(
      "add",
      {
        url: Argument.String("url").pipe(
          Argument.withDescription("The https URL it opens, usually your published URL or a page on it.")
        ),
        title: linkFlags.title,
        icon: linkFlags.icon.pipe(Flag.optional),
        color: linkFlags.color.pipe(Flag.optional),
        json
      },
      (input) =>
        Effect.gen(function* () {
          const dream = yield* Dream
          const url = yield* urlOf(input.url)
          const title = yield* titleOf(input.title)
          const icon = Option.isSome(input.icon) ? yield* iconOf(input.icon.value) : null
          if (Option.isNone(input.color) && icon?._tag !== "Image") {
            return yield* fail(
              `--color is missing: the tile behind the ${icon === null ? "letter" : "glyph"}, one of ${LinkColor.literals.join(", ")}.`
            )
          }
          const added = yield* userFacing(
            dream.AddLink({
              url,
              title,
              ...(icon === null ? {} : { icon }),
              color: Option.getOrElse(input.color, () => "graphite" as const)
            })
          )
          yield* show(input.json, ProjectLink, added, Format.linkAdded(added))
        })
    ).pipe(
      Command.withDescription(
        `Put an icon on their Home that opens a URL. A project gets ${AgentLinksPerProject} at most, so it's for what they'll open again and again.`
      ),
      Command.withExamples([
        { command: 'dream link add https://lift-log-x1.omer.build --title "Lift Log" --icon dumbbell --color purple' }
      ])
    ),
    Command.make(
      "update",
      {
        linkId: Argument.String("link-id"),
        url: Flag.String("url").pipe(
          Flag.withDescription("Point it somewhere else; it shows a dot again."),
          Flag.optional
        ),
        title: linkFlags.title.pipe(Flag.optional),
        icon: linkFlags.icon.pipe(Flag.optional),
        color: linkFlags.color.pipe(Flag.optional),
        json
      },
      (input) =>
        Effect.gen(function* () {
          const dream = yield* Dream
          const url = Option.isSome(input.url) ? yield* urlOf(input.url.value) : undefined
          const title = Option.isSome(input.title) ? yield* titleOf(input.title.value) : undefined
          const icon = Option.isSome(input.icon) ? yield* iconOf(input.icon.value) : undefined
          const change = defined({ url, title, icon, color: Option.getOrUndefined(input.color) })
          if (Object.keys(change).length === 0)
            return yield* fail("Give at least one of --url, --title, --icon or --color.")
          const updated = yield* userFacing(dream.UpdateLink({ linkId: input.linkId as LinkId, ...change }))
          yield* show(input.json, ProjectLink, updated, Format.linkUpdated(updated))
        })
    ).pipe(
      Command.withDescription('Change a link you made. `--icon ""` makes the tile the title\'s first letter.'),
      Command.withExamples([{ command: "dream link update lnk_\u2026 --icon figure.strengthtraining.traditional" }])
    ),
    Command.make("remove", { linkId: Argument.String("link-id") }, (input) =>
      Effect.gen(function* () {
        const dream = yield* Dream
        yield* userFacing(dream.RemoveLink({ linkId: input.linkId as LinkId }))
        yield* Console.log(`Removed ${input.linkId} from their Home.`)
      })
    ).pipe(
      Command.withDescription("Take a link you made off their Home."),
      Command.withExamples([{ command: "dream link remove lnk_\u2026" }])
    ),
    linkList
  ])
)

// ---------------------------------------------------------------------------
// Beyond the sandbox
// ---------------------------------------------------------------------------

const browserStart = Command.make("start", { json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const session = yield* userFacing(dream.StartBrowser())
    yield* show(input.json, BrowserSession, session, Format.browser(session))
  })
)

const browser = Command.make("browser", { json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const session = yield* userFacing(dream.StartBrowser())
    yield* show(input.json, BrowserSession, session, Format.browser(session))
  })
).pipe(
  Command.withDescription(
    "Start a real, recorded Chrome in the cloud (billed per minute) for the open web: sites that block headless browsers, sign-ins, recordings. For testing your own app, the local `chromium` and Playwright are free and reach localhost. Prints a CDP URL for Playwright or Stagehand."
  ),
  Command.withSubcommands([
    browserStart.pipe(Command.withDescription("Same as `dream browser`.")),
    Command.make("stop", { sessionId: Argument.String("session-id") }, (input) =>
      Effect.gen(function* () {
        const dream = yield* Dream
        yield* userFacing(dream.StopBrowser({ sessionId: input.sessionId as BrowserSessionId }))
        yield* Console.log(`Stopped ${input.sessionId}.`)
      })
    ).pipe(
      Command.withDescription("End a browser session."),
      Command.withExamples([{ command: "dream browser stop brs_\u2026" }])
    ),
    Command.make(
      "recording",
      {
        sessionId: Argument.String("session-id"),
        out: Flag.String("out").pipe(Flag.withDescription("Where to save it."), Flag.optional)
      },
      (input) =>
        Effect.gen(function* () {
          const dream = yield* Dream
          const fs = yield* FileSystem.FileSystem
          const http = yield* HttpClient.HttpClient
          const recording = yield* userFacing(
            dream.GetBrowserRecording({ sessionId: input.sessionId as BrowserSessionId })
          )
          const extension = recording.contentType.includes("mp4")
            ? "mp4"
            : recording.contentType.includes("webm")
              ? "webm"
              : "bin"
          const out = Option.getOrElse(input.out, () => `recording-${input.sessionId}.${extension}`)
          const response = yield* http.get(recording.url).pipe(
            Effect.flatMap((response) =>
              response.status >= 300 ? Effect.fail(new Error(`HTTP ${response.status}`)) : response.arrayBuffer
            ),
            Effect.flatMap((bytes) => fs.writeFile(out, new Uint8Array(bytes))),
            Effect.mapError(
              (cause) =>
                new CliError.UserError({ cause, userMessage: `Downloading the recording failed: ${cause.message}` })
            )
          )
          void response
          yield* Console.log(`Saved the recording to ${out} (${recording.contentType}).`)
        })
    ).pipe(
      Command.withDescription("Download a session's recording."),
      Command.withExamples([{ command: "dream browser recording brs_\u2026 --out run.mp4" }])
    )
  ])
)

/**
 * Run `ssh` or `scp` against the Mac with a fresh short-lived key: `build` gets
 * the shared options and `user@host`, and returns the program and its arguments.
 */
const onMac = (
  build: (
    options: ReadonlyArray<string>,
    target: string,
    port: string
  ) => readonly [command: string, args: ReadonlyArray<string>]
) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const fs = yield* FileSystem.FileSystem
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const ssh = yield* userFacing(dream.GetMacSsh())
    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "dream-mac-" })
        const key = `${dir}/key`
        yield* fs.writeFileString(key, `${Redacted.value(ssh.privateKey).trimEnd()}\n`, { mode: 0o600 })
        const hostOptions =
          ssh.hostKey === undefined
            ? ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"]
            : yield* fs
                .writeFileString(`${dir}/known_hosts`, `${ssh.hostKey}\n`)
                .pipe(Effect.as(["-o", `UserKnownHostsFile=${dir}/known_hosts`, "-o", "StrictHostKeyChecking=yes"]))
        const options = ["-i", key, "-o", "IdentitiesOnly=yes", "-o", "LogLevel=ERROR", ...hostOptions]
        const [command, args] = build(options, `${ssh.user}@${ssh.host}`, String(ssh.port))
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, { stdin: "inherit", stdout: "inherit", stderr: "inherit", extendEnv: true })
        )
        return yield* handle.exitCode
      })
    ).pipe(Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: `ssh failed: ${cause.message}` })))
    if (exitCode !== 0) process.exitCode = exitCode
  })

const macSsh = Command.make(
  "ssh",
  { command: Argument.String("command").pipe(Argument.withDescription("Run after --"), Argument.variadic()) },
  (input) =>
    input.command.length === 0
      ? fail("Pass a command: `dream mac ssh -- xcodebuild -version`.")
      : onMac((options, target, port) => ["ssh", ["-p", port, ...options, target, "--", ...input.command]])
).pipe(
  Command.withDescription(
    "Run a command on the Mac over a fresh short-lived SSH session; stdin is passed through (e.g. `tar c . | dream mac ssh -- tar x -C app`)."
  ),
  Command.withExamples([{ command: "dream mac ssh -- xcodebuild -version" }])
)

const macCp = Command.make(
  "cp",
  {
    paths: Argument.String("path").pipe(
      Argument.withDescription(
        "Sources, then the destination; prefix the Mac's side with mac: (relative to its home)."
      ),
      Argument.variadic()
    )
  },
  (input) =>
    Effect.gen(function* () {
      const plan = yield* fromResult(Parse.planCopy(input.paths))
      yield* onMac((options, target, port) => {
        const remote = (path: string) => `${target}:${path}`
        const paths =
          plan.direction === "to-mac"
            ? [...plan.sources, remote(plan.destination)]
            : [...plan.sources.map(remote), plan.destination]
        // -O: the legacy protocol runs over exec like `dream mac ssh`; the Mac's SFTP sees a different filesystem.
        return ["scp", ["-O", "-r", "-q", "-P", port, ...options, ...paths]]
      })
    })
).pipe(
  Command.withDescription(
    "Copy files or directories to or from the Mac with scp: `dream mac cp app mac:app`, `dream mac cp mac:shot.png .`."
  ),
  Command.withExamples([{ command: "dream mac cp app mac:app" }])
)

const mac = Command.make("mac", { json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const status = yield* userFacing(dream.GetMac())
    yield* show(input.json, MacStatus, status, Format.mac(status, yield* now))
  })
).pipe(
  Command.withDescription("Rent an Apple-silicon Mac with Xcode and simulators (billed by the minute; idles off)."),
  Command.withSubcommands([
    Command.make("start", { json }, (input) =>
      Effect.gen(function* () {
        const dream = yield* Dream
        const status = yield* userFacing(dream.StartMac())
        yield* show(input.json, MacStatus, status, Format.mac(status, yield* now))
      })
    ).pipe(Command.withDescription("Start the Mac; returns once it's running.")),
    macSsh,
    macCp,
    Command.make("stop", {}, () =>
      Effect.gen(function* () {
        const dream = yield* Dream
        yield* userFacing(dream.StopMac())
        yield* Console.log("Stopped the Mac.")
      })
    ).pipe(Command.withDescription("Stop it when you're done."))
  ])
)

const machine = Command.make("machine", { json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const info = yield* userFacing(dream.GetMachine())
    yield* show(input.json, MachineInfo, info, Format.machine(info))
  })
).pipe(
  Command.withDescription("This sandbox's CPUs and memory, and moving the project to a bigger or smaller one."),
  Command.withSubcommands([
    Command.make(
      "move",
      {
        size: Argument.Literals("size", ["standard", "large"]).pipe(
          Argument.withDescription("standard (2 CPUs, 4 GB) or large (4 CPUs, 8 GB)")
        ),
        why: Argument.String("why").pipe(Argument.withDescription("what needs it, in a sentence")),
        json
      },
      (input) =>
        Effect.gen(function* () {
          const dream = yield* Dream
          const info = yield* userFacing(dream.MoveMachine({ to: input.size, why: input.why }))
          yield* show(input.json, MachineInfo, info, Format.moving(info))
        })
    ).pipe(
      Command.withDescription(
        "Move to that size once this turn ends: about a minute, your files and session come over, your servers restart."
      )
    )
  ])
)

const usage = Command.make("usage", { json }, (input) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const snapshot = yield* userFacing(dream.GetUsage())
    yield* show(input.json, UsageSnapshot, snapshot, Format.usage(snapshot, yield* now))
  })
).pipe(
  Command.withDescription("Their subscription's five-hour and weekly windows: how much is used and when each resets.")
)

export const dream = Command.make("dream").pipe(
  Command.withDescription(
    "Reach the person and Dream from this sandbox: messages, questions, access, notifications from your apps, status, workstreams, wake-ups, relays, publishing, app links on their Home, a browser, a Mac, usage, and this machine's size."
  ),
  Command.withSubcommands([
    message,
    ask,
    access,
    notify,
    status,
    workCommand,
    live,
    wake,
    relay,
    publish,
    link,
    media,
    browser,
    mac,
    usage,
    machine
  ])
)
