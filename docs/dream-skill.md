---
name: dream
description: Reaching the person and Dream from this sandbox — messages, questions, access to services, the Status card, wake-ups, publishing, a browser, a Mac, and usage. Read it when you need any of these.
---

# `dream`

Everything the person sees from you, and everything that wakes you, goes through `dream`. It works from any process in
this sandbox, including the apps you build. `dream <command> --help` lists every flag.

## Talking to them

- `dream message "…"` puts a message in their Chat. Chat renders paragraphs, lists, bold, italic, code and links;
  headings show as bold lines, and a table as one line per row. `--media <file>` attaches a screenshot or a recording
  (png, jpg, or mp4). `--notify` also puts its opening lines on their lock screen, as plain text.
  - `dream message -` (or no text, with stdin piped) reads the message from stdin, so `dream message - <<'EOF'` keeps
    long markdown out of shell quoting. `dream ask` does the same for the question, or for `--why -`, `--context -`
    or `--meanwhile -`.
- `dream ask "…" --option "…" --option "…"` shows a question card in Chat and sends a notification. The question
  is the card's heading, in large type, and it's what Home and the notification show, often with nothing around it.
  - `--why` adds the one-line reason shown under the question. When deciding takes more than that, such as two
    options and what each costs them, `--context` adds it in markdown at body size: the card shows its first few
    lines, and all of it when they open the card. `--meanwhile` says what you'll keep doing.
  - They can pick an option, or open the question and write anything, typed or dictated.
  - Their answer arrives as an event. Until they answer, the question also sits at the top of their Home screen.
  - Answers are visible in Chat and arrive in this sandbox, so `dream ask` refuses questions that ask for a token, key,
    password or other credential. Ask for those with `dream access`. `--not-a-secret` sends a question that only
    mentions one.
  - `dream ask withdraw <id>` takes back a question that no longer needs an answer.
- `dream access …` asks for access to a service. It shows up like a question, with a way to connect. `--why` is its
  heading, which they read first and often alone, on Home or the lock screen, so it says what they're connecting and
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
  - When they connect, you get an event naming the placeholder to use. Dream adds the real value to your HTTPS
    requests to that host, so this works for anything that authenticates with a header.
  - Only a key sent in a header can be swapped in. A key sent in a URL or a request body can't, for example in
    Telegram's bot URLs (`api.telegram.org/bot<token>/…`) or in Discord's gateway login. Discord's REST API takes
    `Authorization: Bot …` (`--host discord.com --header Authorization --format "Bot {key}"`), so a bot that only
    calls it needs no more than `key`.
  - `file --service … --name …` is the last resort, for a key that can't go in a header: Telegram's bot token,
    Discord's gateway login, an SMTP password, a secret an API wants in the request body. They type it into a
    secure field, and Dream writes it to `~/.dream/keys/<name>` in this sandbox, outside your project.
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
- `dream notify withdraw <id>` removes a notification that no longer applies. An answered question withdraws its own.

## Status

- `dream status` updates the Status card: now, just did, next, and milestones. Each milestone can carry needs, meaning
  what you'll need from them and roughly when. "Now" is the card's large line, and their Home screen shows its first
  line under the project's name.
  - `--title`, `--kind`, `--icon` and `--phase` set how the project appears on their Home screen: its name, what it
    is (web app, iOS app, background worker, …), its icon, and where it stands.
- `dream live start|update|end` controls a Live Activity on their lock screen and Dynamic Island, for a stretch when
  something is actively happening that they might want to glance at: a title of two lines in large type at most,
  with a line of detail. iOS ends it after about eight hours.

## Waking

- Events wake you:
  - their messages and answers
  - a connection completing
  - a wake-up you scheduled
  - a `dream wake` call from one of your apps
  - your usage resetting

  Each turn starts with the events that woke it.
- `dream wake --at <time>` or `--cron "<expr>"` schedules a wake-up, with an optional `--run "<command>"`. The sandbox
  wakes to run the command. You're woken if the command fails, or right away if there's no command.
- `dream wake "why"`, run from anywhere such as an app's error handler, wakes you now.
- `dream wake list` and `dream wake cancel <id>` show and remove scheduled wake-ups.

## Hosting

- `dream publish --port <port>` gives a port a stable public URL, `https://<slug>-<random>.<domain>`. A request to it
  wakes the sandbox. From their phone it opens in Safari.
  - It then loads the URL from this sandbox and tells you what it answers and any page errors; running it again
    re-checks. Dream also loads it when each of your turns ends, and wakes you when that finds a new error status,
    page error, or no answer.
  - Requests reach your server with `Host` set to the sandbox's internal name (`<port>-<sandbox id>.e2b.app`), so a
    server that checks hosts (Vite's dev server does) has to allow it.
  - The public URL works from inside this sandbox too, so you can load exactly what they'll see.
- A server you start as a background task of your shell stops when your turn ends. To keep one running between
  turns, start it detached, e.g. `setsid nohup npm start > server.log 2>&1 &`.

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
