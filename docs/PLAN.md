# Dream: implementation plan (v1)

## 1. What we're building

Dream is an iPhone app (TestFlight). You say or type an idea, and an agent takes it from there. The agent runs in its
own cloud sandbox and asks you sharp questions only when it must. It builds the idea at high fidelity over hours to
weeks, hosts it from the sandbox, and keeps it healthy afterwards. Each project has one agent, one sandbox, and two
views: **Status** (a live roadmap) and **Chat** (only what the agent chose to send).

The design is locked: Deck v3 (`mocks/deck`, commit `d3ba192`). Two changes: "Something else…" appears only in the
expanded view, and Home has no needs-you deck (questions and access requests stay in their project; Home marks the
projects waiting for them in their rows).

**Out of scope for v1:**
- live voice calls
- private apps (web apps use unguessable public URLs)
- code hosting outside the sandbox (no GitHub or code.storage until the agent asks for GitHub)
- billing
- the $100+ plan gate
- Android

## 2. Architecture

```
 iPhone app (Expo SDK 58, React Native, Effect)
   │ HTTPS: Effect RPC                    │ WebSocket while a project is open
   ▼                                      ▼
 Cloudflare Worker "api" (Effect, deployed with Alchemy)
   ├─ D1 (global): users, invites, devices, model connections, integrations,
   │               projects, open questions (for Home), usage ledger
   ├─ ProjectDO ×N (SQLite): chat, questions, status card, schedules, sandbox
   │               state, Live Activity, sent notifications; alarms; WS fan-out
   ├─ gateway: <slug>-<rand>.<domain> → project's sandbox port (wakes it)
   ├─ APNs: notifications + Live Activities (ES256 JWT via WebCrypto)
   └─ R2: screenshots and recordings
   │ POST event to the sandbox (wakes it)   ▲ `dream` calls (project token)
   ▼                                        │
 E2B sandbox ×N (custom template, Pro plan; lifecycle pause + autoResume)
   ├─ dreamd: the event loop. Runs HarnessAgent locally (Claude Code or Codex),
   │          one turn at a time; serves the `dream` CLI; reports usage
   ├─ the code, the running app(s), logs
   └─ egress: E2B network.rules inject real headers (values decrypted by the Worker)
   │                │                   │
 Browserbase    Namespace macOS
 (CDP sessions)  (SSH, short-lived)
```

**Principles:**
- **Source of truth.** Anything that spans projects lives in D1. Each project's own state lives in its
  ProjectDO. Agent memory is the harness session plus the sandbox's files.
- **Event-driven turns.** Nothing wakes the agent unless the user writes or the agent arranged it. Dream never
  nudges it to "continue".
- **Secrets never enter a sandbox.** The sandbox holds placeholders. E2B's egress proxy swaps in real headers
  per host. Dream stores user credentials AES-GCM encrypted in D1 (the key is only a Worker secret) and pushes values
  to E2B on create, on wake, and on token refresh. Operator keys are Cloudflare Worker secrets. The fallback if
  injection falls short is Infisical Agent Vault. The one exception is a key that no header can carry (a Telegram bot
  token, an SMTP password): as a last resort, and with a warning on its card, Dream writes it into that one
  project's sandbox as a file under `~/.dream/keys` (`dream access file`).
- **Effect v4 everywhere:**
  - Workers and the DO: HttpApi/RPC, `@effect/sql-d1`, `@effect/sql-sqlite-do`
  - dreamd and the CLI
  - the mobile app: `@effect/atom-react` and the RPC client
  - one shared `domain` package with all schemas

## 3. Repository layout (bun workspaces, TypeScript strict)

```
apps/mobile            Expo app: expo-router, @effect/atom-react, Live Activity target (@bacons/apple-targets)
apps/api               Worker: RPC + HTTP routes, ProjectDO, gateway, APNs, crons
packages/domain        Effect Schemas + RPC contracts shared by app, Worker and dreamd
packages/dreamd        sandbox daemon + `dream` CLI (Node, Effect)
packages/sandbox-template  E2B template build (Node 24, pnpm, Playwright deps, dreamd, harness prerequisites)
packages/agent-context system prompt + `dream` skill (markdown) — see docs/agent-context.md
infra/alchemy.run.ts   Cloudflare resources + E2B template as a custom Alchemy resource
```

## 4. Key versions (checked on npm, 2026-11-04)

| Package | Version |
|---|---|
| effect, @effect/atom-react, @effect/sql-d1, @effect/sql-sqlite-do, @effect/vitest | 4.1.2 |
| alchemy | 2.0.0-beta.85 |
| ai | 7.0.162 |
| @ai-sdk/harness, harness-claude-code, harness-codex | 1.0.17x (experimental) |
| e2b | 2.63.0 |
| @browserbasehq/sdk | 2.25.0 |
| @browserbasehq/stagehand | 4.4.0 |
| expo | 58.0.23 |
| expo-speech-recognition | 58.0.1 |

## 5. Data

**D1 tables:**
- `users`
- `invites` (allowlisted emails)
- `devices` (APNs token, Live Activity push-to-start token)
- `model_connections` (claude or chatgpt, status, secret id, last usage snapshot)
- `integrations` (kind: google_oauth, api_key, or apple_asc; hosts; scopes; secret id; status)
- `secrets` (AES-GCM ciphertext + nonce, owner, kind; decrypted only inside the Worker)
- `projects` (owner, title, slug, harness, phase, headline, sandbox id, public URL, updated_at)
- `open_asks` (a copy of each project's open questions and access requests, for older builds' Home deck)
- `usage_events` (sandbox, browser and Mac minutes per project)

**ProjectDO tables:**
- `messages`: kind is text, question or access; holds body, media, options, state, and the answer
- `status`: phase, now, just_did, next, milestones with pinned needs
- `schedules`: one-off and cron
- `sandbox`: id, state, endpoints
- `live_activity`
- `notifications`: sent ones, so stale ones can be withdrawn
- `events`: the inbox delivered to the agent

## 6. The `dream` command (the agent's whole interface to Dream)

dreamd serves it on localhost and forwards to the API with a project-scoped token. The apps the agent builds can
call it too, for example `dream wake` from an error handler. It is documented in the agent-context skill and in
`--help`.

```
dream message [--notify] [--media file…] "text"
dream ask "question" --option "…" [--option …] [--why "…"] [--meanwhile "…"]
dream access google --scopes gmail.readonly,calendar --why "…"
dream access key --service Stripe --host api.stripe.com --header Authorization --format "Bearer {key}" --why "…"
dream access apple --why "…"
dream status --now "…" --just-did "…" --next "…" --milestones milestones.json
dream wake --at <time>|--cron "<expr>" [--run "<command>"] "why"
dream publish --port 3000            → https://<slug>-<rand>.<domain>
dream browser                        → Browserbase CDP URL + live view, recording on close
dream mac start|ssh|stop             → Namespace macOS with short-lived SSH; idles off
dream live start|update|end          → Live Activity on their lock screen
dream notify withdraw <id>
dream media upload <file>            → R2, attachable to messages
dream usage                          → subscription windows, % left, reset times
```

## 7. Key flows

1. **Sign in.**
   - The phone does Google Sign-In and sends the ID token to the API.
   - The API verifies it against Google's keys, checks the invite list, and issues a Dream session (a JWT that
     SecureStore keeps on the phone).
2. **Connect Claude or ChatGPT, once per person.** The API starts a short-lived "auth" sandbox:
   - **Claude:** it runs `claude setup-token` in a PTY. The phone opens Anthropic's page, the user taps Authorize and
     pastes the code back, and the token is stored encrypted in D1.
   - **ChatGPT:** it runs `codex login --device-auth`, and the phone shows the code and opens OpenAI's page. Dream
     keeps the tokens and refreshes them centrally, because refresh tokens rotate on each use. Fresh values are pushed
     to every live sandbox.
3. **New idea.**
   - The API creates the D1 row and the ProjectDO.
   - The DO creates the E2B sandbox from the template (pause and autoResume, network rules for the model token and
     the user's integrations) and starts dreamd.
   - The first message is delivered as an event. The agent researches, then talks to the user through `dream`.
4. **Messages and answers.**
   - The phone sends to the API, which writes to the ProjectDO, which broadcasts over WS.
   - The DO POSTs the event to dreamd's port. That request wakes the sandbox, and dreamd starts a turn, or queues
     the event if a turn is already running.
5. **Access.**
   - `dream access` creates an access message and sends a push.
   - The user connects with OAuth, a pasted key, or an App Store Connect key. The secret is stored encrypted in D1, and the
     E2B rules are updated for all of that user's live sandboxes.
   - The agent receives an event naming the placeholder to use.
   - A file key (`dream access file`) belongs to the asking project only. Its DO writes it into the sandbox before
     the agent hears about it, writes it again into a recreated sandbox, and deletes the file when it's removed.
   - When a connection goes (removed in Settings, or an OAuth provider refuses the refresh token), every sandbox
     loses it, the cards connected to it turn `Disconnected` (they can connect again from them), and the projects
     with such a card tell their agent. Projects that never asked for it aren't woken.
6. **Hosting and schedules.**
   - The gateway maps the host to the project's sandbox port URL. E2B auto-resumes the sandbox on traffic.
   - DO alarms fire scheduled wakes. The sandbox wakes and dreamd runs the command or starts a turn.
7. **Usage.**
   - dreamd reads usage and rate-limit events from the harness and reports them.
   - When a limit is hit, the DO sets an alarm for the reset time, and the agent is woken then.
   - Machine minutes go to `usage_events` for billing later.
8. **Notifications.**
   - They're sent direct from the Worker to APNs, with categories and deep links to the message.
   - To withdraw one, the Worker sends a silent push and the app removes the notification. The app also cleans up
     when it's opened, since APNs has no remote delete.
   - Live Activities use push-to-start, update and end, under the agent's control.

## 8. Mobile app (Deck v3)

**Screens:**
- Home: the project rows (a row says when its project is waiting for them)
- Project: Status | Chat
- The expanded message (question or access) that shrinks back to its place in Chat, with a highlight
- New idea: composer and dictation
- Sign-in and the subscription connect flow
- Settings: connections and integrations
- The Lock-screen Live Activity and Dynamic Island

**Deep links** open the expanded message, and Back lands on the message in Chat. Built web apps open in Safari.

## 9. How I'll build it (subagents)

- **Phase 0, me (Opus):**
  - the repo skeleton and the `domain` package (every schema and RPC contract, so parallel work can't drift)
  - `agent-context`
  - the Alchemy infra skeleton
  - CI (typecheck plus tests)
- **Phase 1, three Sonnet threads in parallel, on their own branches:**
  - **A. Control plane:** Worker, D1 migrations, ProjectDO, RPC/WS, auth, gateway, APNs, R2, alarms, usage ledger,
    secrets encryption, E2B rule sync, Google OAuth, model-connect flows, Browserbase and Namespace brokers.
  - **B. Sandbox runtime:** dreamd, the `dream` CLI, HarnessAgent local mode for Claude Code and Codex, the event
    queue, usage parsing, and the E2B template.
  - **C. Mobile:** the Deck v3 UI in React Native, the RPC client, WS, push and deep links, dictation, and the
    Live Activity widget.
- **Haiku threads** look up API details as they come up.
- **Phase 2, me:** integrate, end-to-end runs (real accounts needed), fix.
- **Phase 3:** I hand it to you. UX review rounds come after, as you asked.

**Verification:**
- Unit and contract tests with `@effect/vitest`.
- A local Worker through Alchemy dev. APNs can only be tested on a deployed Worker, because local workerd can't
  speak HTTP/2.
- The app in an iOS simulator here.
- Real E2B, Claude Code and Codex runs once keys exist.

## 10. What I need from you, and when

| When | What | Cost |
|---|---|---|
| Early, to allow real end-to-end testing during the build | Cloudflare account + domain; E2B (Pro) API key | ~$5 + $150/mo |
| Phase 1 | Google Cloud project: iOS OAuth client (sign-in) and a web OAuth client with Gmail/Calendar/Drive/Sheets scopes, consent screen in production (unverified) | free |
| Phase 1 | Browserbase API key + project | ~$20/mo |
| Phase 1 | Namespace token (plan with macOS) | ~$100/mo + $0.04–$0.20/min while a Mac runs |
| Before TestFlight | Apple Developer account for Dream: bundle id, APNs key (.p8), App Store Connect; an Expo account for EAS | $99/yr |
| First run | Your Claude and/or ChatGPT sign-in in the app; the invite list | — |

Without the early keys, I build against fakes, and your first real run becomes the end-to-end test.

## 11. Risks

- **The harness is experimental.** `@ai-sdk/harness` is labeled experimental, and running it locally inside the
  sandbox isn't the main path it was designed for. Delivering a message to a long turn mid-flight may need
  harness-specific steering.
- **Placeholder credentials are unproven.** Claude Code and Codex might check the token format locally, and Codex
  might try to refresh its own tokens.
- **Claude `setup-token` in a PTY** inside a sandbox hasn't been tried end to end. Friends' Claude tokens are a
  terms-of-service exposure.
- **E2B network rules:** one rule per host, header-only, HTTPS-only. Signed APIs need a different approach.
- **Withdrawing notifications** is best-effort, since APNs has no remote delete.
- **Alchemy v2 is still in beta**, and Namespace macOS plan gating is unclear.
