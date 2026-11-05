/**
 * The `dream` command: the agent's whole interface to Dream, usable from any
 * process in the sandbox. Each subcommand maps onto one `SandboxRpcs` call
 * (the RPC doc comments name the command and flags) sent through dreamd's
 * Unix socket. Results print as short text, or as JSON with `--json`.
 */
import {
  AccessMessage,
  AccessRequest,
  accessHostProblem,
  BrowserSession,
  type BrowserSessionId,
  Integration,
  LiveActivityContent,
  MacStatus,
  type MediaId,
  MediaRef,
  type MessageId,
  Milestone,
  type NotificationId,
  ProjectPhase,
  QuestionMessage,
  StatusCard,
  TextMessage,
  UsageSnapshot,
  Wake,
  type WakeId,
  WakeWhen
} from "@dream/domain"
import { Cause, Console, DateTime, Effect, FileSystem, Option, Path, Redacted, Result, Schema } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Dream, userFacing } from "./cli/Client.ts"
import * as Format from "./cli/Format.ts"
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
const textArgument = (name: string) =>
  Argument.String(name).pipe(
    Argument.withDescription(`The ${name}; markdown. Use "-" or leave it out to read it from piped stdin.`),
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

/** Reserve a media id and upload the file's bytes to where the API says. */
const upload = Effect.fn("dream.upload")(function* (file: string, caption?: string) {
  const dream = yield* Dream
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const http = yield* HttpClient.HttpClient
  const contentType = yield* fromResult(Parse.mediaType(file))
  const bytes = yield* fs
    .readFile(file)
    .pipe(Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: `Can't read ${file}.` })))
  if (bytes.byteLength === 0) return yield* fail(`${file} is empty.`)
  const { media, upload: target } = yield* userFacing(
    dream.CreateMediaUpload({
      filename: path.basename(file),
      contentType,
      sizeBytes: bytes.byteLength,
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
    text: textArgument("message"),
    media: mediaFlag,
    notify: Flag.Boolean("notify").pipe(
      Flag.withDescription("Also put it on their lock screen."),
      Flag.withDefault(false)
    ),
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
      const sent = yield* userFacing(dream.SendMessage({ text, media, notify: input.notify }))
      yield* show(input.json, TextMessage, sent, Format.sent(sent))
    })
).pipe(
  Command.withDescription("Put a message in their Chat (markdown), optionally with media and a notification."),
  Command.withExamples([{ command: 'dream message "The first version is live: https://…" --media shot.png --notify' }])
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
    question: textArgument("question"),
    option: Flag.String("option").pipe(
      Flag.withDescription("An answer they can pick. Repeat for each."),
      Flag.atLeast(0)
    ),
    why: Flag.String("why").pipe(
      Flag.withDescription('The one-line reason shown under the question; "-" reads it from stdin.'),
      Flag.optional
    ),
    meanwhile: Flag.String("meanwhile").pipe(
      Flag.withDescription('What you\'ll keep doing while you wait; "-" reads it from stdin.'),
      Flag.optional
    ),
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
        Option.getOrUndefined(input.meanwhile)
      ].filter((text) => text === "-")
      if (fromStdin.length > 1)
        return yield* fail("Only one of the question, --why and --meanwhile can come from stdin.")
      const question = yield* textFrom(input.question, 'Ask what? `dream ask "question" --option "…" --option "…"`')
      if (question.length === 0) return yield* fail("The question is empty.")
      const why = yield* readOptional(input.why)
      const meanwhile = yield* readOptional(input.meanwhile)
      if (!input.notASecret) {
        const secret = Secrets.requestedSecret([question, why ?? "", ...input.option])
        if (Option.isSome(secret)) return yield* fail(Secrets.refusal(secret.value))
      }
      const asked = yield* userFacing(
        dream.AskQuestion(
          defined({
            question,
            options: input.option,
            why,
            meanwhile
          })
        )
      )
      yield* show(input.json, QuestionMessage, asked, Format.asked(asked))
    })
).pipe(
  Command.withDescription(
    "Show them a question card and notify them. Their answer arrives as an event, and shows in Chat, so never ask for a secret here; use `dream access`."
  ),
  Command.withExamples([
    {
      command:
        'dream ask "Which days should it post?" --option "Weekdays" --option "Every day" --why "So it fits your routine"'
    }
  ]),
  Command.withSubcommands([askWithdraw])
)

const accessFlags = {
  why: Flag.String("why").pipe(Flag.withDescription("What it's for, in your words; the card's heading.")),
  when: Flag.String("when").pipe(
    Flag.withDescription('Roughly when it\'s needed, e.g. "around Thursday". Shows as upcoming instead of notifying.'),
    Flag.optional
  ),
  json
}

const requestAccess = (
  request: AccessRequest,
  input: { readonly why: string; readonly when: Option.Option<string>; readonly json: boolean }
) =>
  Effect.gen(function* () {
    const dream = yield* Dream
    const requested = yield* userFacing(
      dream.RequestAccess(defined({ request, why: input.why, when: Option.getOrUndefined(input.when) }))
    )
    yield* show(input.json, AccessMessage, requested, Format.accessRequested(requested))
  })

const access = Command.make("access").pipe(
  Command.withDescription("Ask for access to a service. They connect it once; it works in all their projects."),
  Command.withExamples([
    {
      command:
        'dream access key --service Stripe --host api.stripe.com --header Authorization --format "Bearer {key}" --why "Take payments"'
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
        { command: 'dream access google --scopes gmail.readonly,calendar --why "Plan workouts around your calendar"' }
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
            'dream access key --service Discord --host discord.com --header Authorization --format "Bot {key}" --why "Post quotes to your channel"'
        },
        {
          command:
            'dream access key --service Stripe --host api.stripe.com --header Authorization --format "Bearer {key}" --why "Take payments"'
        }
      ])
    ),
    Command.make("apple", accessFlags, (input) => requestAccess(AccessRequest.cases.Apple.make({}), input)).pipe(
      Command.withDescription("Ask for their App Store Connect API key, which TestFlight uploads need."),
      Command.withExamples([
        { command: 'dream access apple --why "Put the app on TestFlight" --when "around Thursday"' }
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

const notify = Command.make("notify").pipe(
  Command.withDescription("Manage notifications you've sent."),
  Command.withSubcommands([
    Command.make("withdraw", { notificationId: Argument.String("notification-id") }, (input) =>
      Effect.gen(function* () {
        const dream = yield* Dream
        yield* userFacing(dream.WithdrawNotification({ notificationId: input.notificationId as NotificationId }))
        yield* Console.log(`Withdrew notification ${input.notificationId}.`)
      })
    ).pipe(
      Command.withDescription("Remove a notification that no longer applies."),
      Command.withExamples([{ command: "dream notify withdraw <notification-id>" }])
    )
  ])
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
    now: lineFlag("now", "What you're doing now (Home shows this line)."),
    justDid: lineFlag("just-did", "What you just did."),
    next: lineFlag("next", "What's next."),
    media: mediaFlag,
    milestones: Flag.String("milestones").pipe(
      Flag.withDescription(
        'A JSON file with the whole milestone list: [{"title","state":"done|current|upcoming","date"?,"detail"?,"needs":[{"what","when"?,"messageId"?}]}]'
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
  Command.withDescription("Show the Status card, or update it with any of the flags."),
  Command.withExamples([
    { command: 'dream status --now "Building progress charts" --just-did "Set up sign-in" --next "Deploy"' }
  ])
)

const liveFlags = {
  title: Flag.String("title").pipe(Flag.withDescription('The big line, e.g. "Building progress charts" (≤ 80).')),
  detail: Flag.String("detail").pipe(Flag.withDescription("A supporting line (≤ 120)."), Flag.optional),
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
    json
  },
  (input) =>
    Effect.gen(function* () {
      const dream = yield* Dream
      const why = Option.getOrUndefined(input.why)
      if (why === undefined || why.trim().length === 0) {
        return yield* fail('Say why: `dream wake "why"`, or `dream wake --at 2h "why"`.')
      }
      if (Option.isNone(input.at) && Option.isNone(input.cron)) {
        if (Option.isSome(input.run)) return yield* fail("--run needs --at or --cron.")
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
      const scheduled = yield* userFacing(
        dream.ScheduleWake(defined({ when, why, run: Option.getOrUndefined(input.run) }))
      )
      yield* show(input.json, Wake, scheduled, Format.scheduled(scheduled, yield* now))
    })
).pipe(
  Command.withDescription(
    'Wake the agent now (`dream wake "why"`, e.g. from an error handler), or schedule a wake-up with --at or --cron.'
  ),
  Command.withExamples([
    { command: 'dream wake --at 2h "Check the deploy"' },
    { command: 'dream wake --cron "0 7 * * *" "Send the morning summary"' }
  ]),
  Command.withSubcommands([wakeList, wakeCancel])
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
        caption: Flag.String("caption").pipe(Flag.withDescription("A short label under it."), Flag.optional),
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
  Command.withDescription("Start a real, recorded Chrome; prints a CDP URL for Playwright or Stagehand."),
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
    "Reach the person and Dream from this sandbox: messages, questions, access, status, wake-ups, publishing, a browser, a Mac, and usage."
  ),
  Command.withSubcommands([message, ask, access, notify, status, live, wake, publish, media, browser, mac, usage])
)
