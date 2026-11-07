---
name: dream
description: Reaching the person and Dream from this sandbox — messages, questions, access to services, notifications from your apps, the Status card, workstreams, wake-ups, relays, publishing, app links on their Home, a browser, a Mac, and usage. Read it when you need any of these.
---

# `dream`

Everything the person sees from you, and everything that wakes you, goes through `dream`. It works from any process in
this sandbox, including the apps you build. `dream <command> --help` lists every flag.

## Talking to them

- `dream message "…"` puts a message in their Chat. Chat renders paragraphs, lists, bold, italic, code and links;
  headings show as bold lines, and a table as one line per row. `--media <file>` attaches a screenshot or a recording
  (png, jpg, or mp4). `--notify` also puts its opening lines on their lock screen, as plain text.
  - Most messages read best as a few short paragraphs, the way a person writes to someone they work with. A list
    suits things that really are one, such as steps to follow. A list where every item opens with a bold label reads
    as a generated report, however true each item is.
  - `dream message -` (or no text, with stdin piped) reads the message from stdin, so `dream message - <<'EOF'` keeps
    long markdown out of shell quoting. `dream ask` does the same for the question, or for `--why -`, `--context -`
    or `--meanwhile -`.
- They can attach photos and files to what they send, a new idea included. Before your turn, Dream copies each into
  `~/.dream/attachments/<message id>/`, and the event names every path, so you can look at a photo or read a file
  where it is. Photos arrive downscaled to at most 2048 pixels on the long edge. Copy one into the project if your
  app needs it.
- `dream ask "…" --option "…" --option "…"` shows a question card in Chat and sends a notification. The question
  is the card's heading, in large type, and it's what the notification shows, often with nothing around it.
  - `--why` adds the one-line reason shown under the question. When deciding takes more than that, such as two
    options and what each costs them, `--context` adds it in markdown at body size: the card shows its first few
    lines, and all of it when they open the card. `--meanwhile` says what you'll keep doing.
  - They can pick an option, or open the question and write anything, typed or dictated.
  - Their answer arrives as an event. Until they answer, the card stays open in Chat, the Status card carries an
    amber line for it, and their Home screen marks the project as waiting for them.
  - Answers are visible in Chat and arrive in this sandbox, so `dream ask` refuses questions that ask for a token, key,
    password or other credential. Ask for those with `dream access`. `--not-a-secret` sends a question that only
    mentions one.
  - `dream ask withdraw <id>` takes back a question that no longer needs an answer.
- `dream access …` asks for access to a service. It shows up like a question, with a way to connect. `--why` is its
  heading, which they read first and often alone, on the lock screen, so it says what they're connecting and
  what for, as in "Connect Gmail so I can read your newsletters". `--context` adds markdown on the card and just
  above where they paste: for a key they make themselves, the link to the page where it's made and what to tap.
  Links open in Safari, and they come back to paste.
  - `google --scopes …` lets them sign in with Google and grant the scopes you name. Like `oauth` below, it works
    only once whoever runs Dream has registered Dream's Google app, and when they haven't, `dream access google` says
    so before any card reaches them.
  - `key --service … --host … --header … --format "Bearer {key}"` lets them paste a key, and tells Dream where the
    key belongs. `--host` is the real host your requests go to, like `api.stripe.com`. A key card isn't a place to
    keep values you'd send some other way.
  - `apple` asks for their App Store Connect API key, which TestFlight needs. Its card already links Apple's guide
    to making one.
  - `oauth <provider> --scopes …` lets them sign in to a service that uses OAuth and grant the scopes you name, in
    that provider's own names. Dream knows `spotify`, `github`, `strava`, `dropbox`, `slack`, `notion`, `microsoft`
    (Outlook, OneDrive and the rest of Microsoft Graph) and `oura`. Each one works only once whoever runs Dream has
    registered it, and when one isn't, `dream access oauth` says so before any card reaches them.
    - The sign-in happens on their phone, on the provider's own page, so nothing about it needs a redirect URL, a
      client id or a client secret from you or from them.
    - Dream holds the refresh token and keeps the access token current on that provider's API hosts. The event
      names those hosts, the placeholder, and anything else the API needs, such as a version header. A GitHub
      connection also covers git over HTTPS to github.com.
    - Connecting a provider again replaces the earlier connection and keeps the scopes it had.
  - `--when "around Thursday"` marks a need for later. It shows as upcoming, so they can connect it early or wait
    until you ask again.
  - They can decline a request instead, and may say why ("Use a free option instead"); the event carries their
    reason. They can still connect it later from the card.
  - When they connect, you get an event naming the placeholder to use. Dream adds the real value to your HTTPS
    requests to that host, so this works for anything that authenticates with a header.
  - Only a key sent in a header can be swapped in. A key sent in a URL or a request body can't, for example in
    Telegram's bot URLs (`api.telegram.org/bot<token>/…`). Discord's REST API takes `Authorization: Bot …`
    (`--host discord.com --header Authorization --format "Bot {key}"`), and a relay logs in to Discord's Gateway with
    that same key, so a Discord bot needs no more than `key`.
  - `file --service … --name …` is the last resort, for a key that can't go in a header: Telegram's bot token, an
    SMTP password, a secret an API wants in the request body. They type it into a secure field, and Dream writes it
    to `~/.dream/keys/<name>` in this sandbox, outside your project.
    - Their card warns them that the key will live in this sandbox, where any code that runs here can read it, so
      it's worth asking only when no header can carry it.
    - It belongs to this project alone. Their other projects don't get it, and a new sandbox for this project gets
      it again. Entering it again replaces the file, from your card or from their Settings; after a change in
      Settings you get an event, and anything that read the old key needs a restart. If they remove it, Dream
      deletes the file and you get an event.
    - Have your code read the file each time it starts. Don't print it or put it in a command, a log, the project's
      files, its git history, or anything you send: what you see here goes to the model provider. `dream` refuses
      to send text that contains it. Under Claude Code, reading the folder or naming it in a command is refused,
      so put the path in your code or its config.
  - A key also has to last. A pasted OAuth token stops working within hours, which is why services that hand out
    short-lived tokens, such as Spotify, Strava or Dropbox, connect with `dream access oauth` instead. An OAuth
    service Dream doesn't know can't be connected yet.
  - `dream access list` shows what they've already connected. All of it already works here. A sign-in the provider
    stops accepting (they revoked it, or it lapsed) drops out of the list, and requests that relied on it are
    refused until they connect it again.
  - When something this project asked for goes away, because they removed it in Settings or its provider stopped
    accepting it, you get an event, and your card for it says so; they can connect it again from that card. If it
    stopped working and they connect it again from another project, you get an event saying it's back.
- `dream notify withdraw <id>` removes a notification that no longer applies, yours or one of your apps'. An answered
  question withdraws its own.

## Notifications from your apps

An app you build can notify them as itself, with no turn of yours involved, usually from a scheduled job
(`dream wake --cron … --run "curl -fsS http://localhost:<port>/tasks/…"`).

- `dream notify setup <app> --name "Fare watch" --why "…" --often "…"` readies an app to notify them, and puts a
  card in Chat asking them to allow it. The card reads "Let Fare watch notify you", then `--why`, what it will tell
  them, and `--often`, how often ("A few times a week at most"). Nothing from the app reaches them until they allow
  it, and their answer arrives as an event; a decline may say why.
  - `--icon` (an SF Symbol or one emoji) and `--color` draw its tile, as for `dream link`.
  - `--url` is where a tap goes by default: a page of your published URL, opened full screen inside Dream. Without
    one, a tap opens the notification in the project.
  - Running it again for the same app updates its card, or asks again if they declined.
- `dream notify --app <app> "…"` sends one, from any process here.
  - The text is plain, and the lock screen shows about four lines of it. `--title` adds a bold headline above it,
    and `--url` sends a tap to the page about this one.
  - `--key` names what it's about. A newer one with the same key replaces the older on their lock screen instead of
    stacking, so a price that keeps moving stays one notification.
  - `--quiet` puts it in Notification Center without a sound, for what's worth finding but not worth an
    interruption. `--dry-run` prints what would happen without sending.
  - It prints what happened, and exits 0 whenever the app did its part, including when Dream held it back (their
    settings, a limit, a repeat). It fails only when the call is wrong: an app that isn't set up, a URL off your
    published one, or text that contains one of the project's file keys.
- They can make an app quiet, turn it off or mute it for a day, from the notification itself or the project, and you
  get an event when they do. Dream holds back anything past 6 an hour or 24 a day from one app (48 a day across the
  project); those stay in its history, and you hear about it once that day.
- `dream notify list [--app <app>]` shows what your apps sent in the last 30 days, what happened to each, and which
  ones they opened.

## Status

- `dream status` updates the Status card above their Chat, and prints what they'll see of it.
  - `--now` is one sentence, best kept to one line on the card: about 35 characters. The card shows up to two, so a
    sentence that runs a little long stays readable, and past two it's cut. It's large when they open the card, and
    it's also the line under the project's name on Home.
  - `--milestones` shows each milestone as its title and a date, so the titles carry the meaning ("Voice review
    mode", not "Phase 2"). A need on a milestone, with the id of the question or access request that covers it, is
    one short amber phrase on the card while that request is open, such as "Needs your OpenAI API key" from "Your
    OpenAI API key".
  - `--media` shows screenshots and recordings with their captions when they open the card.
  - `--title`, `--kind`, `--icon` and `--phase` set how the project appears on their Home screen: its name, what it
    is (web app, iOS app, background worker, …), its icon, and where it stands.
## Workstreams

When you run several things at once, each one they might ask about on its own can be a workstream. While two or more
are active, the Status card shows a row for each in place of `--now`.

- `dream work start "Double charges" --now "Reproducing it"` starts one and prints its id (`ws_…`). `--from <message-id>`
  files the message that started it, usually theirs, under it.
  - The title is the row's first line, in semibold, and the label on its messages in Chat. About 30 characters fit,
    so a few words that name it read best ("Double charges", "Android?"), not a sentence.
  - `--now` is the line under it: about 35 characters, one line, cut with "…" past that. It's whole when they open
    the card.
- `dream work update <id> --now "…"` changes the row, and only the row: nothing reaches Chat or their lock screen.
  `--title` renames it, and `--now ""` clears the line.
- `dream work done <id> --result "Fixed, refunds sent"` folds it into the card's last line, with the result beside its
  title, for a few days. `dream work drop <id>` takes it off the card when it stopped being its own thing. Neither
  sends anything; when the outcome matters to them, say so in a message.
- `--work <id>` on `dream message`, `dream ask` and `dream access` labels what you send with the workstream. While
  its question or access request is open, the row is amber and sits at the top, showing what you asked instead of
  its line, until they answer.
- Their messages arrive with the workstream when they replied into one. When they didn't, `dream work route
  <message-id> <id>` files one under the workstream it belongs to; it then carries that label too.
- Three rows fit on the card. With four or more active, the first two show (waiting ones first, then the order they
  started) and the third reads "2 more: …" with their titles; opening the card shows them all.
- `dream work` and `dream work list` show every workstream and exactly what the card shows of them.
- Your `--now` sentence still matters: it's the line under the project on Home, and what older versions of the app
  show instead of rows.

## Live Activity

- `dream live start|update|end` controls a Live Activity on their lock screen and Dynamic Island, for a stretch when
  something is actively happening that they might want to glance at: a title of two lines in large type at most,
  with a line of detail. iOS ends it after about eight hours.

## Waking

- Events wake you:
  - their messages and answers
  - a connection completing
  - a wake-up you scheduled
  - a `dream wake` call from one of your apps
  - a relay that stopped, or whose events your app hasn't taken for an hour
  - your usage resetting

  Each turn starts with the events that woke it.
- `dream wake --at <time>` or `--cron "<expr>"` schedules a wake-up, with an optional `--run "<command>"`. The sandbox
  wakes to run the command and stays awake until it finishes, for up to 30 minutes. You're woken if the command
  fails, or right away if there's no command.
  - That's how anything runs on a schedule here, since nothing runs in a sleeping sandbox. To have your app do the
    work, call it on localhost, where the endpoint needn't be public:
    `--run "curl -fsS --max-time 900 http://localhost:3000/tasks/digest"`. Without `-f`, curl succeeds on an error
    status, and you'd never hear about it.
  - For work that should carry on after your turn ends, such as a long import, `--at 1m --run "…"` keeps the sandbox
    awake until it's done.
  - Once the command is done, and nothing else needs the sandbox, it goes back to sleep within seconds. So a quick
    check costs seconds of machine time, and checking every few minutes is fine. A wake-up without a command starts a
    turn, which sends the model your whole session before it does anything, so on a schedule it adds up.
- `dream wake --cron "<expr>" --task "<brief>" --model <model> --effort <effort> "why"` (or `--at`) runs a task in
  a session of its own when it fires, instead of waking you: a new conversation on the model and effort you give,
  named as your subagents' are, that starts from the brief.
  - It knows only the brief and what it finds in the project's files, so the brief carries what the job needs:
    what to do, where things are, how to tell it went right, and whether to tell the person. `--task -` reads the
    brief from stdin.
  - It has the project's files and `dream`. It doesn't wake you when it succeeds. It wakes you with `dream wake`
    when it can't do the job, and you're woken with its last words if it fails outright: an error, half an hour
    without finishing, or a usage limit.
  - Its last message is its report, which `dream wake list` shows under the wake with how the run went.
  - Its tokens count for this project like a turn's, but it starts small instead of re-sending your session, so a
    weekly episode or a morning digest written by a model costs what writing it takes.
- `dream wake "why"` wakes you now. An app can call it, from an error handler say, whenever it's running, which is
  only while the sandbox is awake.
- `dream wake list` and `dream wake cancel <id>` show and remove scheduled wake-ups.

## Hosting

- `dream publish --port <port>` gives a port a stable public URL, `https://<slug>-<random>.<domain>`. A request to it
  wakes the sandbox. From their phone it opens in Safari.
  - The sandbox wakes in under a second and stays up for a minute or two after the last request. Then your server is
    frozen with everything else, and its open connections close.
  - Publishing then loads the URL from this sandbox and tells you what it answers and any page errors; running it again
    re-checks. Dream also loads it when each of your turns ends, and wakes you when that finds a new error status,
    page error, or no answer.
  - Requests reach your server with `Host` set to the sandbox's internal name (`<port>-<sandbox id>.e2b.app`), so a
    server that checks hosts (Vite's dev server does) has to allow it.
  - The public URL works from inside this sandbox too, so you can load exactly what they'll see.
- Services that can push to you instead of being polled, such as Telegram, Slack (every channel message, through its
  Events API), a WhatsApp business number, Discord's interactions, GitHub and Stripe, can send webhooks to the
  published URL, and each one wakes the sandbox. Only one port is published, so the webhook routes go in the same
  server as the app. Some senders want an answer within three seconds, so answer first and do the slow part after.
  A service that only talks down a connection you keep open needs a relay (below).
- A server you start as a background task of your shell stops when your turn ends. To keep one running between
  turns, start it detached, e.g. `setsid nohup npm start > server.log 2>&1 &`.

## Relays

Some services only tell you what happened down a connection you keep open: Discord's Gateway (ordinary messages in a
server; Discord sends no webhooks for those), exchange and market feeds, other WebSocket streams. A sleeping sandbox
can't keep one open, so Dream holds it for you, outside the sandbox, and POSTs each event to your app, which wakes the
sandbox like any request.

- `dream relay discord --to /hooks/discord [--port 3000]` holds the bot's Gateway session, logging in with their
  Discord key (the `key` for discord.com that the bot's REST calls use). It forwards `MESSAGE_CREATE` unless you name
  others with `--events`. `--mentions` forwards only messages that mention the bot, reply to it, or are sent to it
  directly, and `--channel <id>` only those in a channel. The bot's own messages never come back.
  - Reading what people write needs Message Content Intent switched on for the bot, in the Developer Portal under
    Bot. Without it the relay fails and says so.
  - Slash commands and buttons can come over a relay too (`INTERACTION_CREATE`), but Discord wants an answer within
    three seconds, so its interactions endpoint, a webhook to your published URL, is the surer way for those.
- `dream relay websocket wss://… --to /hooks/feed` holds any WebSocket feed. `--send` subscribes after every connect.
  `--key <id>` puts one of their keys' header on the connection, and only to that key's own host. `--ping` and
  `--ping-every` keep a feed that drops quiet clients, `--silence <seconds>` reconnects one that goes quiet, and
  `--match` forwards only messages containing that text.
- Each event arrives as a POST to `http://localhost:<port><path>`: the published port, or the one you give with
  `--port`, which needn't be published. The JSON body has `id`, `relay`, `source`, `type` (Discord's event name),
  `at` and `data`, which is Discord's event as it sent it, or the feed's message, parsed if it's JSON. Answer 2xx once
  you've handled it; the sandbox stays awake while you do, and goes back to sleep soon after. Anything else, or no
  answer within two minutes, and it's tried again later, so a broken route holds back the events behind it. Events
  wait up to a day.
  - Delivery is at least once, so drop an `id` you've already handled.
  - The route may also be reachable on your public URL, so check that a request came from Dream.
    `Dream-Signature` is `v1=` and the hex HMAC-SHA256, keyed with the contents of `~/.dream/relay.key`, of
    `Dream-Timestamp`, a dot, and the raw body:
    ```js
    const key = readFileSync(join(homedir(), ".dream/relay.key"), "utf8").trim()
    const signed = `${req.headers["dream-timestamp"]}.${rawBody}`
    const expected = `v1=${createHmac("sha256", key).update(signed).digest("hex")}`
    // Compare with timingSafeEqual, and refuse a timestamp more than five minutes old.
    ```
- `dream relay list` shows each relay's state (connecting, connected, retrying or failed), what it has delivered,
  what's waiting, and recent problems. One that fails for a reason retrying can't fix, such as a revoked token or an
  intent that isn't switched on, wakes you once with why. `dream relay restart <id>` tries again once it's fixed, and
  it restarts by itself when they connect a new key. You also hear when your app hasn't taken its events for an hour.
  `dream relay remove <id>` closes it.
- A project can have three. Each holds a connection open around the clock, so use one when no webhook or schedule
  would do. A feed has no memory: what it sends during a reconnect (seconds) is missed, so a relay suits live updates
  more than a record you can't lose. Discord's Gateway does replay what was missed, for a few minutes.
- Relays stop while the project is archived and start again when it's restored.

## App links on their Home

The first thing on their Home, under the Dream header and above their projects, is a row of app icons, like a second
dock: rounded tiles with a short label under each, and an Add tile at the end. About five fit across before the row
scrolls, and all their projects share it, since only agents put links there. So a link is for something they'll
open again and again, like the app itself or a page they check every morning, not for each page or each update. A
project gets three at most. A tap opens the page full screen inside Dream.

- `dream link add <url> --title … --icon … --color …` puts one at the end of the row, usually your published URL or a
  page on it.
  - The title is the label: one line of small type under the tile. About ten characters show, and a longer title is
    cut short with "…".
  - The tile is an SF Symbol or an emoji on one of ten colours, or a square png or jpg of yours (at least 180 px)
    that fills it edge to edge, since iOS rounds the corners. Without `--icon` it shows the title's first letter. It
    sits among icons like their real apps', where one clear glyph reads best.
  - Until they first open it, a small dot sits before the label, as on a newly installed app.
  - That's all the row shows. Holding a tile lifts it and opens a menu headed "Made by" and this project's name, over
    the link's host, with Open, Share, Add to Home Screen, Rename, Change icon and Remove.
  - Every `dream link` command prints what they'll see: the label as it shows, the tile, and the menu's header.
- They can rename a link, change its icon to a symbol or emoji and a colour, or remove it, and you get an event when
  they do. What they changed stays theirs: `dream link update` can't change it back, and this project can't add a URL
  they removed again. Only they can put a removed one back, from the Add tile, and then it's yours to update again.
  `dream link list` shows each link and what they've done with it.
- Add to Home Screen puts a link on their iPhone's own Home Screen, through Safari, as a web app that opens full
  screen. For your published URL, Dream gives Safari the link's title and tile, so they become your app's name and
  icon on their phone. A link to another site gets that site's own name and icon.
- Share sends the link through Messages, WhatsApp, Mail and the like, and the preview the recipient sees comes from
  the page's Open Graph tags. Where your published page sets no `og:title` or `og:image`, Dream uses the link's title
  and tile, so set your own only when you have better, such as a 1200×630 image of the app, with `og:description`.
- An archived project's links leave their Home until it's restored, and a deleted project's links go with it.

## Beyond this sandbox

- This sandbox has a local headless Chromium and Playwright 1.64.1 with its browsers installed (a project that adds
  `playwright@1.64.1` uses them without a download). They're free, fast, reach localhost, and suit testing what you
  build: `chromium --headless --screenshot=shot.png --window-size=390,844 <url>`, or `npx playwright screenshot`.
  Each browser with a typical page takes roughly 150 MB of the sandbox's memory. Pillow and basic fonts are
  installed.
- `dream browser` starts a real Chrome in the cloud, on Dream's Browserbase account, billed by the minute. It's for
  the open web when the local one isn't enough: sites that block headless browsers or cloud IPs, signing in
  somewhere, pages with no API, and recordings worth showing them. It prints a CDP URL for Playwright or Stagehand,
  plus a live-view URL. Each session is recorded, and `dream browser recording <id>` downloads the recording.
  `dream browser stop <id>` ends it.
- `dream mac start` rents an Apple-silicon Mac with Xcode and simulators. Use `dream mac ssh -- <cmd>` to run commands
  and `dream mac stop` when you're done.
  - It costs money by the minute, and it stops itself after 20 idle minutes. Each start is a fresh Mac, so nothing
    on it survives `dream mac stop`.
  - `dream mac cp <src>... mac:<dst>` and `dream mac cp mac:<src>... <dst>` copy files and directories (paths after
    `mac:` are relative to its home). `dream mac ssh` passes stdin through, so `tar c . | dream mac ssh -- tar x -C app`
    works too.
  - There's no GUI session, so `screencapture` fails. `xcrun simctl io booted screenshot <file>` and `recordVideo
    <file>` capture the simulator.
  - It has Homebrew, so tools such as XcodeGen are a `brew install` away.
  - It runs macOS 27 with several Xcodes in /Applications (26.6 and 27.x). `xcodebuild -version` shows the selected
    one, and `DEVELOPER_DIR` picks another for one command. Expo SDK 58 needs Xcode 26.4 or newer.
- `dream usage` shows the five-hour and weekly windows of their subscription: how much is used and when each resets.
