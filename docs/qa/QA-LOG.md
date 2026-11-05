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
