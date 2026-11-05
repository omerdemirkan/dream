# QA summary for the founder (2026-11-05, rounds 1–3 and follow-ups)

Details and evidence are in QA-LOG.md; the calls I made while you were away are in ASSUMPTIONS.md.

## Verified end to end on the live stack

- Projects: create → sandbox → dreamd → Haiku turns on your Claude subscription, with questions, access cards, Status,
  and Chat. The phone shows live updates over the project socket.
- Hosting: `dream publish`, the gateway, auto-resume of paused sandboxes, WebSockets, webhooks, the publish self-check,
  and the post-turn URL watch.
- Scheduling: cron and one-shot wakes, `--run` commands that wake the agent only on failure, and app-initiated
  `dream wake`.
- Continuity: a sandbox paused mid-turn is resumed by the keepalive and the turn finishes (the same path as the 1-hour
  cap cycle). The durable inbox survives dreamd restarts.
- Credentials: a pasted key is injected by header, `dream ask` refuses to ask for secrets, and real keys never enter
  the sandbox.
- iOS: a native app built on a Namespace Mac (XcodeGen, simulator screenshots).
- The iPhone app against the live API: every main flow, with real agent output. Retries are now idempotent and slow
  writes fail visibly.

## Decisions for you

1. **Model egress.** Every request from a sandbox to api.anthropic.com carries your subscription token, so an app an
   agent publishes could run on your plan for anyone with its link. A person's own Anthropic key also can't work
   there (two credentials). Same for chatgpt.com on Codex. My recommendation: route the harness through a Dream-owned
   host so api.anthropic.com carries nothing. The alternative is to keep it and say so to the agent.
2. **OAuth for other services.** Spotify, Strava, Dropbox and others hand out only short-lived tokens, so they can't be
   connected today. Generic OAuth connections (Dream holds and refreshes the token, like ChatGPT) would cover them.
3. **Updating live sandboxes.** A sandbox keeps the dreamd, CLI and prompt it was created with, so long-lived projects
   never get fixes. Either the DO refreshes /opt/dream on wake, or Dream recreates the sandbox and keeps /home/user.
4. **Keys pasted in Chat.** The prompt states why keys stay out, and `dream ask` refuses to ask for them. Haiku still
   asks for secrets in plain messages. Options: the composer detects key-shaped text and offers the secure field;
   decide whether gateway bots and URL-token APIs (Telegram) should ever be allowed a key inside the sandbox.

## Needed from you

- Enable R2 (media: screenshots and recordings in Chat).
- APNs key secrets (push, Live Activities), Google OAuth clients, Apple Team ID, and the bundle id (placeholder
  `com.omer.dream`).
- Browserbase: the free plan's minutes are used up, so `dream browser` fails (agents fall back to local Chromium).
- Xcode 26.4+ for TestFlight builds of Dream. Namespace's newest image is 26.3, and Expo SDK 58 needs 26.4. Agents'
  Expo apps hit the same error there; native Swift apps don't.
- Optional: rotate your Claude token. Part of it was printed into my session log when I read an E2B sandbox's details
  (nowhere else). Run `claude setup-token`, and I'll make a fresh connect link.

## Agent behaviour on Haiku (left as a model matter)

- Strengths: it asks good clarifying questions and fixes concrete bug reports fast and properly. It uses cron,
  publish and access cards correctly most of the time.
- Recurring problems:
  - It claims features that aren't there (a turn timer, "email notifications" through a test inbox).
  - It ends a turn promising more work, with no wake-up scheduled.
  - It ignores constraints it was given up front ("phones will lock").
  - It skips the Status card and media, and asks for secrets in Chat.
- The prompt already states the facts behind each of these. I added only facts a model couldn't know from outside
  Dream: keys stay out of the sandbox; a key has to last (OAuth-only services); `--host` is the real host.
- One calibration run with Opus or Sonnet as the in-sandbox agent would show how much of this is the model and how
  much is the prompt. I didn't run one, per your testing rule.
