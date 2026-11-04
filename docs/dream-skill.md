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
- `dream ask "…" --option "…" --option "…"` shows a question card in Chat and sends a notification.
  - `--why` adds the one-line reason shown under the question. `--meanwhile` says what you'll keep doing.
  - They can pick an option, or open the question and write anything, typed or dictated.
  - Their answer arrives as an event. Until they answer, the question also sits at the top of their Home screen.
- `dream access …` asks for access to a service. It shows up like a question, with a way to connect.
  - `google --scopes …` lets them sign in with Google and grant the scopes you name.
  - `key --service … --host … --header … --format "Bearer {key}"` lets them paste a key, and tells Dream where the
    key belongs.
  - `apple` asks for their App Store Connect API key, which TestFlight needs.
  - When they connect, you get an event naming the placeholder to use. Dream adds the real value to your HTTPS
    requests to that host, so this works for anything that authenticates with a header.
  - `dream access list` shows what they've already connected. All of it already works here.
- `dream notify withdraw <id>` removes a notification that no longer applies. An answered question withdraws its own.

## Status

- `dream status` updates the Status card: now, just did, next, and milestones. Each milestone can carry needs, meaning
  what you'll need from them and roughly when. Their Home screen shows your "now" line.
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

## Hosting

- `dream publish --port <port>` gives a port a stable public URL, `https://<slug>-<random>.<domain>`. A request to it
  wakes the sandbox. From their phone it opens in Safari.

## Beyond this sandbox

- `dream browser` starts a real Chrome. It prints a CDP URL for Playwright or Stagehand, plus a live-view URL. Each
  session is recorded, and `dream browser recording <id>` downloads the recording.
- `dream mac start` rents an Apple-silicon Mac with Xcode and simulators. Use `dream mac ssh -- <cmd>` to run commands
  and `dream mac stop` when you're done.
  - It costs money by the minute, and it stops itself after 20 idle minutes.
  - `xcrun simctl io booted recordVideo` records the simulator.
- `dream usage` shows the five-hour and weekly windows of their subscription: how much is used and when each resets.
