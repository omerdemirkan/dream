# QA log

Newest at the bottom. Each entry: archetype, what was done, result, issues (platform vs agent behaviour), fix.

## 0. First end-to-end run — to-do web app (2026-11-05 03:17 UTC)
- Project `prj_yPdr2HMIiO6tmBkrCYUppX`, Claude Code default model (before the Haiku setting).
- Pass: sandbox create, dreamd start, real Claude token via E2B egress, `dream publish`, `dream status`, `dream message`.
- Agent behaviour: built in ~45 s without asking anything (the idea said "keep it small; quick test"); tested only via
  API; the page served a JSON-serialized Buffer instead of HTML. It said it hadn't opened it on a phone.

## 1. Fix loop on the to-do app — message → wake → fix (03:28 UTC)
- Sent "the page shows {"type":"Buffer"...}". Gateway auto-resumed the paused sandbox (1.4 s on a later GET).
- PLATFORM BUG: the env rewrite (adding DREAM_MODEL for Haiku) raced the delivery. The old dreamd started the turn,
  then saw the env change and hung forever in shutdown (bridge child alive), so the supervisor never restarted it and
  the project was stuck. Unblocked by killing dreamd; the supervisor restarted it, and the on-disk inbox requeued the
  event (durability OK). Fix dispatched: `fix/dreamd-restart` (bounded shutdown + DO waits for the new dreamd).

## 2. QA wave 1 — Haiku agent, 6 projects so far (03:36–03:45 UTC)
Projects: band site prj_18wb3OQHcZyClaQAg1aagi · habit tracker prj_lnKBBJI8Q4Pda4CGdv0E3w · price checker
prj_VDYnpk45jepGnYk1sX3mwJ · Python CSV tool prj_rFe6FMBDM78yVGCcffZYsK · HN email worker prj_JUa4VgukbqL8GHVK0raP02 ·
Google Calendar dashboard prj_915FpseXBVojq18HAErvZZ.

Root cause behind most "silent project" reports: the agent talked through channels nobody sees.
- Asked questions with Claude Code's built-in AskUserQuestion (band site) → vanished.
- Asked/answered in final assistant text instead of `dream ask`/`dream message` (habit tracker, CSV tool, HN worker,
  Google dashboard after decline) → person saw nothing.
- Used Claude Code's bundled `schedule` skill (claude.ai routines) instead of `dream wake --cron`; it failed and the
  agent told the empty session to retry (HN worker).
Fixes: prompt now states the session never reaches the person (context, model-agnostic); runtime fix dispatched
(`fix/session-channel`): convert AskUserQuestion → Dream questions, disable bundled skills that can't work here,
safety net posts final text when a turn sent nothing to the person.

Other findings:
- Status defaults: projects whose agent never runs `dream status` stay "New idea"/phase new forever → fix dispatched
  (`fix/status-defaults`: provisional title from the idea, phase advances on first turn).
- Price checker: `dream wake --cron` works (daily 0 9 * * *, `--run` command). Agent used fetch+cheerio rather than the
  cloud browser — reasonable for a static page.
- Google dashboard: Google access card created correctly; decline recorded. Agent's message claimed "real-time
  updates" before any data access — overclaiming (agent honesty; watch after prompt changes).
- Gateway, publish, auto-resume all fine wherever the agent published.

## 3. QA wave 1 — protocols (03:40–03:50 UTC)
- Tic-tac-toe prj_eFOk8NKZZhdS2UiPc4vDGZ: WebSocket realtime through the gateway works; two clients saw each other's
  moves instantly. PASS.
- URL shortener prj_DTxj1b6a5ZxkNJz9cyjDUN: POST/GET/DELETE and 302 redirect through the gateway all work; UI works.
  PASS. The tester killed a 2m45s first turn as a "hang" — inconclusive (it may have been working); inbox recovery
  re-ran it in 18 s. No CORS headers (not needed same-origin).
- Prompt: added one line of context about honesty ("they act on what you tell them … an honest 'not yet'") after the
  Google dashboard overclaim. Model-agnostic.

## 4. Native iOS (tip calculator, prj_f0kxtUZlB37GGR1GKMwH0J) — interim, from the transcript
- PASS: `dream mac start` → Mac up; `dream mac ssh` works; Xcode 26.1.1; `dream mac stop` at the end.
- Agent struggled to make an Xcode project from scratch (hand-written .pbxproj, then SwiftPM `--type app`, both failed).
- `screencapture` over SSH fails (no GUI session); the agent didn't find `xcrun simctl io booted screenshot`.
- Sandbox had no Chromium on PATH, no PIL, no fonts → couldn't render a preview image. SVG rejected by `--media`
  (clear error). A long `dream message` with box-drawing characters broke shell quoting.
- Agent then claimed "Here's your Tip Calculator app running on iOS" over a mockup — overclaiming (honesty line was added
  to the prompt after this project started).
- Fixes dispatched (`fix/sandbox-env`): stdin for `dream message`, Chromium on PATH + fonts + PIL in the template,
  Mac facts in the skill (simctl screenshots, Homebrew/XcodeGen, file copy) and `dream mac cp` if missing.
- Merged `fix/status-defaults` (provisional titles, phase → exploring on first turn); deployed from main.
- QA 5's final report said "no Dream RPC attempts". The transcript says otherwise: the agent ran `dream message` twice,
  and both failed (an .svg attachment was rejected; a long message broke bash quoting). So the plumbing is fine, and
  the fixes above (stdin for messages, the final-text safety net) cover this.

## 5. Merged fix/session-channel (04:10 UTC)
- AskUserQuestion → Dream questions (turn continues with a result saying where they went).
- Safety net: a completed turn that sent nothing to the person posts its final text to Chat (skips boilerplate).
- Claude Code built-ins that can't work here are turned off via ~/.claude/settings.json (schedule/loop/cron tools,
  plan mode, push notifications, …); `dream` skill kept. Verified on a real Haiku project.
- Kept the prompt sentence "anything you write here … never reaches them": it shapes the right behaviour; the safety
  net is a fallback, not a channel.

## 6. Round 2 started (04:14 UTC)
- main @ 8e2e652 deployed (Worker) and dream-sandbox rebuilt from main (build 92928ef1-15e7-422d-af6f-6f89cc3c771a):
  restart fix, session channel fix, status defaults, sandbox env (stdin messages, local Chromium, fonts, PIL,
  `dream mac cp`), two prompt context lines (session never reaches them; honest "not yet").
- Five Haiku QA threads, 9 projects: band site (questions + Home deck), habit tracker (pause/resume persistence),
  HN email worker (cron + decline), Discord bot (pasted fake key → connected), Python CLI, Chrome extension,
  iOS tip calculator (XcodeGen/simctl/mac cp), weather+AQI dashboard (public APIs), finance tracker (multi-turn status).
- R2 / QA2.3: Python CLI prj_xKH2gAasQzOo4LYxwbqswV — PASS: tool works, README + usage in chat, title from idea,
  safety net posted the final text. Agent didn't run `dream status` (phase stayed "exploring", no kind).
  Chrome extension prj_XZCCv9SuFZncDWfFRqbWLN — PASS: valid MV3 extension, status kept (kind "Chrome Extension",
  phase live, headline with load instructions), clear load steps in chat.
- R2 / QA2.4: iOS tip calculator prj_PwQkmMO3vZje99blwmowRA — PASS: XcodeGen project, built, booted iPhone 15 simulator,
  three real simctl screenshots (1179×2556), Mac stopped at the end, final message with next steps. Didn't attach
  screenshots (media storage needs R2 anyway). Round 1's iOS failure modes are gone.
- R2 / QA2.1: band site prj_jgPfLU7y4WthTVGLky8xi8 — PASS (published, dark theme as asked; the idea carried enough detail
  that it built without questions; didn't open its own URL). Habit tracker prj_rRkhIPendhk5Vrw0q5Vlmx — FAIL: agent
  published a Vite dev server, which rejects the gateway's Host (`3000-<id>.e2b.app`) with "Blocked request"; agent
  said "live" without loading its own URL. It asked 4 good questions in plain text; the safety net delivered them.
  Fix (skill facts, model-agnostic): published servers see Host = the e2b name (Vite must allow it), and the public URL
  is reachable from inside the sandbox, so it can load exactly what they'll see. Ships with the next template build.
- R2 / QA2.2: HN digest prj_bg5PZZbmQ5sa6XUYplhiri — PASS: asked about email, got declined, pivoted to a web page,
  `dream wake --cron "0 8 * * *"` scheduled, published, status live. Discord bot prj_K4rmAMnEMDnMdEBfjuhvpG — SECURITY
  ISSUE: `dream access key` without --host → CLI dumped help text → agent fell back to `dream ask` for the token, and
  the (fake) token was typed into Chat. Fix dispatched (`fix/secret-asks`): errors lead with the problem; `dream ask`
  refuses credential requests (with an escape hatch); skill facts on header-only swapping (Telegram URL tokens and
  Discord gateway can't be swapped; Discord REST can). Known limitation logged: services that put tokens in the URL or
  body can't use Dream's header swap yet (possible v2: a URL-template credential proxy in the Worker).
- R2 / QA2.5: weather + AQI dashboard prj_YjVF570gj2z5ia6bRLNaBn — FAIL: React runtime error (pm2_5 of undefined);
  agent said "live" without loading it. Finance tracker prj_yc1yyU1wakbqPG1PVvywZd — multi-turn and Status card worked
  well (question card with options, two follow-ups, status updated each time), but Vite dev server Host block again.
  Fix dispatched (`feat/publish-check`): `dream publish` loads the public URL in the local headless Chromium and prints
  status, title and page errors, so the facts are in front of the agent at the moment it publishes.
- Fix loop on broken apps (04:27–04:41): finance tracker — agent fixed the Vite host block; page loads (screenshot).
  Habit tracker — agent said "Fixed! I updated Vite to allow all hosts" but the URL still answers 403. Weather — agent
  claimed fixed; page still shows a (different) React runtime error. → Extended `feat/publish-check` with a post-turn
  health check that delivers an agent-only event when the published URL is broken (deduped, never notifies the person).
- Merged `fix/secret-asks` into main.

## 7. Round 3 started (04:58 UTC)
- Merged `feat/publish-check` (publish self-check + post-turn published-URL watch + safety-net scope) and
  `fix/secret-asks`. main deployed; dream-sandbox rebuilt (build 58e37c71-e7bc-4351-8017-06147d76d3dc). 162 tests.
- Five Haiku QA threads: ISS map (Vite) + offline recipe PWA · Telegram bot (URL token) + Discord bot (header key) ·
  ~90-minute cabin booking site (long-running autonomy, E2B 1-hour cap) · HN clone + GitHub webhook viewer ·
  uptime monitor on an always-down URL + COVID data analysis.
- R3 / QA3.5: COVID dashboard prj_L7kMWMUeJgg3CZ61htc5xJ — PASS (numbers spot-checked against the CSV, charts via React +
  Recharts). Uptime monitor prj_snUUtnD2Mmjxy85sSLltF8 — the tester reported "sandbox network isolation"; wrong:
  httpstat.us itself is down (000 from my sandbox too), while example.com and api.github.com answer 200 from the project
  sandbox. The cron wake `*/10 * * * *` with `--run monitor.sh` is scheduled correctly; checking that it fires at 05:10.
- R3 / QA3.2: Telegram bot prj_kjXhWnJjluf4QgTRceq9GA — agent used `dream access key` (Authorization: Bearer, which is
  wrong for Telegram's URL token), then after a decline built a local setup script. Discord bot prj_V59vTXtmDqXCkzPQqyIkIT
  — `dream access key` with `Bot {key}` (correct); fake key connected fine (card → Connected, agent notified). The agent
  built on discord.py (gateway login, which can't use a header swap), saw it fail, then asked the person to paste the
  token in Chat "to store it locally", and the tester did. `dream ask`'s guard didn't apply (asked via message).
  Fix (prompt, model-agnostic context): the person trusts Dream with keys on the promise that they stay out of the
  sandbox; a key pasted into Chat or written to a file here is readable by any code that runs here.
  Recommendations for the founder (not built): (1) the app's composer could detect key-shaped text (sk-, ghp_, xoxb-,
  Discord token shape) and offer the secure field; (2) decide whether Dream should ever support keys that must live in
  the sandbox (gateway bots, URL tokens), with an explicit warning on the access card.
- R3 / QA3.4: GitHub webhook viewer prj_oZBwugUU2wW24vbU0jqI9V — PASS: POSTs through the public URL (202), events streamed
  live over WebSocket, agent pre-sent test events itself. HN clone prj_npL1bW4W6Dab0XfHBQZtFj — signup works, then the
  page goes blank after login (app bug, not platform); the agent claimed all features worked. The post-turn URL check
  only loads the landing page, so bugs behind a login are beyond it — that verification is on the agent (model
  capability; not adding Haiku-specific prompting).
- R3 / scheduled path VERIFIED end to end: at 05:10:00 the ProjectDO alarm woke the paused sandbox, dreamd ran the
  `--run` command (monitor.sh, exit 1 because the site is down), that woke the agent, and it messaged "🚨
  https://httpstat.us/503 is now DOWN" at 05:10:13. Watching 05:20 for repeat alerts.
- R3 / QA3.1: ISS tracker prj_3ZUroKEzkWGgWC0lms8KxP — PASS (React + Leaflet, live position, agent wrote Playwright
  checks, claims matched reality). Offline recipe PWA prj_ggrXh3fBSF1BD5GsGjCtDv — PASS (manifest, service worker
  registered, cache populated, IndexedDB); minor form-validation bug. Both agents asked clarifying questions as chat
  text rather than question cards (still delivered; cards would also reach Home and send a notification).
- 05:20 cron run: monitor.sh exited 0 (state unchanged), so the agent wasn't woken and no repeat alert was sent — the
  agent designed its script to exit non-zero only on a change. No spam.
- R3 / QA3.3: cabin booking site prj_AfAC2cpCmnGEKnRLzH6iLQ — the tester rated it "excellent", but it kept prompting the
  agent every few minutes, so autonomy and the 1-hour cap were never exercised, and it took the agent's claims at face
  value. Reading the code: magic-link and approve/decline emails go to an Ethereal test inbox (nobody receives them;
  the agent's first message said "requesters get notified"), so the only way in is the four login links posted in
  Chat, which expire after 24 hours; approve/decline have no server-side admin check; "screenshots captured" were
  never sent (no `--media` attempt; R2 is off anyway). The agent never mentioned needing an email service, which the
  prompt already asks for ("what you'll need from them along the way") — model capability, no prompt change.
  Lesson for the QA method: Haiku testers echo the agent; I verify claims myself (code, URL, data).
- Mid-turn pause VERIFIED (05:41–05:48): asked the cabin agent to run a foreground `sleep 240`, then paused its sandbox
  through E2B's API at 05:44:10, two minutes in. The ProjectDO's next keepalive tick (05:46:47) found it paused and
  resumed it; the sleep and the Claude Code session carried on, and the turn finished at 05:48:32 with both timestamps
  (6m36s wall clock = 4 min of sleep + ~2.6 min paused). The proactive cycle before E2B's 1-hour cap uses the same
  pause → connect → revive path. (The agent replied in final text; the safety net posted it.)
