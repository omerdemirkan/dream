---
name: dream
description: Reaching the person and Dream from this sandbox — messages, questions, access to services, the Status card, wake-ups, publishing, a browser, a Mac, and usage. Read it when you need any of these.
---

# `dream`

Everything the person sees from you, and everything that wakes you, goes through `dream`. It works from any process in
this sandbox, including the apps you build. `dream <command> --help` lists every flag.

## Talking to them

- `dream message "…"` puts a message in their Chat, with markdown rendered. `--media <file>` attaches a screenshot or
  a recording (png, jpg, or mp4). `--notify` also puts it on their lock screen.
  - `dream message -` (or no text, with stdin piped) reads the message from stdin, so `dream message - <<'EOF'` keeps
    long markdown out of shell quoting. `dream ask` does the same for the question, or for `--why -` or `--meanwhile -`.
- `dream ask "…" --option "…" --option "…"` shows a question card in Chat and sends a notification.
  - `--why` adds the one-line reason shown under the question. `--meanwhile` says what you'll keep doing.
  - They can pick an option, or open the question and write anything, typed or dictated.
  - Their answer arrives as an event. Until they answer, the question also sits at the top of their Home screen.
  - Answers are visible in Chat and arrive in this sandbox, so `dream ask` refuses questions that ask for a token, key,
    password or other credential. Ask for those with `dream access`. `--not-a-secret` sends a question that only
    mentions one.
  - `dream ask withdraw <id>` takes back a question that no longer needs an answer.
- `dream access …` asks for access to a service. It shows up like a question, with a way to connect.
  - `google --scopes …` lets them sign in with Google and grant the scopes you name.
  - `key --service … --host … --header … --format "Bearer {key}"` lets them paste a key, and tells Dream where the
    key belongs.
  - `apple` asks for their App Store Connect API key, which TestFlight needs.
  - `--when "around Thursday"` marks a need for later. It shows as upcoming, so they can connect it early or wait
    until you ask again.
  - When they connect, you get an event naming the placeholder to use. Dream adds the real value to your HTTPS
    requests to that host, so this works for anything that authenticates with a header.
  - Only a key sent in a header can be swapped in. A key sent in a URL or a request body can't, for example in
    Telegram's bot URLs (`api.telegram.org/bot<token>/…`) or in Discord's gateway login. Discord's REST API takes
    `Authorization: Bot …` (`--host discord.com --header Authorization --format "Bot {key}"`).
  - `dream access list` shows what they've already connected. All of it already works here.
- `dream notify withdraw <id>` removes a notification that no longer applies. An answered question withdraws its own.

## Status

- `dream status` updates the Status card: now, just did, next, and milestones. Each milestone can carry needs, meaning
  what you'll need from them and roughly when. Their Home screen shows your "now" line.
  - `--title`, `--kind`, `--icon` and `--phase` set how the project appears on their Home screen: its name, what it
    is (web app, iOS app, background worker, …), its icon, and where it stands.
- `dream live start|update|end` controls a Live Activity on their lock screen and Dynamic Island, for a stretch when
  something is actively happening that they might want to glance at. iOS ends it after about eight hours.

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

## Beyond this sandbox

- `dream browser` starts a real Chrome. It prints a CDP URL for Playwright or Stagehand, plus a live-view URL. Each
  session is recorded, and `dream browser recording <id>` downloads the recording. `dream browser stop` ends it.
- This sandbox also has a local headless Chromium, unrecorded, for quick screenshots: `chromium --headless
  --screenshot=shot.png --window-size=390,844 <url>`, or `npx playwright screenshot`. Pillow and basic fonts are
  installed.
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
- `dream usage` shows the five-hour and weekly windows of their subscription: how much is used and when each resets.
