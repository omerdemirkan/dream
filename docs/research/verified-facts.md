# Verified facts (checked against primary sources, 2026-11-04)

## Subscriptions / ToS
- Anthropic (code.claude.com/docs/en/legal-and-compliance): a platform MAY host the unmodified Claude Code
  binary in sandboxes, and an end user MAY sign in to it with their own Claude subscription, via Anthropic's
  own sign-in flow. Developers may NOT offer Claude.ai login in their own apps, route requests through
  Pro/Max credentials on users' behalf, or collect/store/intermediate Claude.ai credentials or session tokens.
  Agent SDK products should use API keys. Hosting requires agreeing to Commercial Terms; no reselling usage.
  => pi-durable / Agent SDK on a Claude subscription is not allowed. Claude token must not go through Dream's vault.
- OpenAI "Sign in with ChatGPT" plan usage (DevDay 2026-09-29, limited preview, 16 partners incl. Pi, OpenCode):
  third-party apps can spend a Plus/Pro user's plan allowance. Access token 1h, refresh 30d (rotating).
  Per-app weekly caps set by user. Apps expected to show "Using ChatGPT plan" + Manage usage link.
  Source: thenewstack.io/sign-in-with-chatgpt/
- OpenAI Realtime API (voice) is API-key billed only; ChatGPT plans don't cover it.

## Packages (npm, 2026-11-04)
- effect 4.1.2 (v4 stable). @effect/atom-react 4.1.2, @effect/platform-browser 4.1.2, @effect/vitest 4.1.2.
- alchemy 2.0.0-beta.85 (Effect-based v2 line).
- [DROPPED by user 2026-11-04 — do not use] @earendil-works/pi-durable 1.5.0 (experimental): durable harness; SQLite/JSONL/memory storage; tasks with
  checkpoints; durable sleep/wake; child tasks/subagents; usage+cost docs; built on pi-ai + chord.
- @earendil-works/pi-ai 1.5.0: providers incl. OpenAI w/ Sign in with ChatGPT OAuth, Anthropic, etc.
- ai 7.0.162; @ai-sdk/harness 1.0.173 (HarnessAgent, experimental) + @ai-sdk/harness-claude-code
  (backed by claude-agent-sdk), @ai-sdk/harness-codex (backed by @openai/codex-sdk), @ai-sdk/harness-pi.
  Sandbox providers: @e2b/ai-sdk-sandbox 0.3.0 (official E2B), ai-sdk-sandbox-local, @ai-sdk/sandbox-vercel.
- durable-harness 0.0.1 (vercel-labs): runs Claude Code/Codex only in Vercel Sandbox -> not usable with E2B.
- e2b 2.63.0; @browserbasehq/sdk 2.25.0; @browserbasehq/stagehand 4.4.0; expo 58.0.23; @infisical/sdk 5.0.2.

## Infra behaviors (from research, verify again during build)
- E2B: lifecycle onTimeout:"pause" + autoResume:true; HTTP to exposed port resumes paused sandbox.
  Public URL https://<port>-<id>.e2b.app; allowPublicTraffic:false requires e2b-traffic-access-token header.
  E2B network rules can transform requests at egress (header injection) — verify.
- Infisical Agent Vault: HTTPS_PROXY forward proxy, sandbox holds session token, proxy injects real creds.
  Header swap can't do SigV4 / HMAC-signed / JWT-assertion auth without proxy-side re-signing.
- Namespace: macOS (M4 Pro / M5 Max) instances via API/CLI, Xcode + simulators, SSH. Billed per unit-minute.
- Browserbase: CDP/Playwright connect, recordings, live view URL, persistent contexts.
- APNs: collapse-id only coalesces undelivered; removing delivered notifications needs on-device code
  (silent push -> removeDeliveredNotifications). Live Activities: push-to-start (iOS 17.2+) / update tokens,
  direct APNs (not Expo push), 4KB payload, ~8h active / 12h lock screen.
- Competitors: Lovable (chat + Details timeline), Replit Agent (task board kanban), Devin (progress tab),
  Instinct (Noah Shinn; personal agent over text/phone; user sees only messages it chooses to send),
  Meta Muse (personal agent, surfaces outcomes not steps).
- Prompting: Claude Code system prompt cut ~80% for Fable 5 ("this new class of models want a smaller system
  prompt; examples tend to constrain it"). Principles: context over rules, goals over procedures, explain why,
  no conflicting rules, progressive disclosure via skills.

## Decisions so far
- v1 audience: the user + a few friends; operator pays infra. Record per-project machine time from day one
  so credits / pass-through billing can be added later.
- Harness: Vercel AI SDK `@ai-sdk/harness` HarnessAgent with Claude Code and Codex adapters. No pi-durable.
- Support both Claude and ChatGPT subscriptions. Sign-in runs through each CLI's own login flow inside the
  sandbox, with Dream relaying the link/code (Codex device code; Claude paste-back code).
- Voice: option 1 (voice model leads, foreman listens in and can inject notes). ChatGPT users: Codex app-server
  experimental `thread/realtime/*` (WebRTC SDP from phone, billed to ChatGPT plan, appendText for notes).
  Claude-only users: OpenAI Realtime/GPT-Live on operator API key, Dream builds the listen-in bridge.
- Code lives in code.storage (Pierre): repo per project via @pierre/sdk, JWT-authenticated git remotes usable
  from E2B, ephemeral branches / forks (good for throwaway prototypes), GitHub sync for export, webhooks.
  Docs: https://code.storage/docs/llms.txt
- Claude sign-in: user-scoped token in Infisical, injected by egress proxy (sandbox gets a placeholder).
  One sign-in per user via Anthropic's flow run by Dream (`claude setup-token` in a throwaway sandbox, user
  taps Authorize + pastes code once). Plan as of 2026-11-04; friends' tokens are the residual ToS exposure.

## Scope cut (2026-11-04, founder): test core assumptions, not the whole product
- Codex / ChatGPT only. Claude Code is out for now (simplicity; voice via Codex realtime).
- Project repo lives only in the E2B sandbox. No code.storage, no GitHub. Publishing to GitHub = agent requests
  a GitHub integration through the normal credential flow.
- Integrations and the ChatGPT sign-in are user-scoped: entered once, shared by all of a user's projects.
  Note: ChatGPT refresh tokens rotate on each refresh, so a shared login must be refreshed centrally (proxy holds
  real tokens; sandboxes get placeholders) or sandboxes will invalidate each other.
- REVERSED same day: Claude Code is back, built upfront alongside Codex (operator already pays for sandboxes,
  browsers, simulators, so paying for voice for Claude users is fine). Claude sign-in: user-scoped, once.
- Proposed: one voice path for everyone — OpenAI realtime (GPT-Live / gpt-realtime) on the operator's API key,
  with Dream's own listen-in bridge to whichever foreman (Claude Code or Codex). Avoids depending on Codex's
  undocumented experimental realtime API.
- v1 scope adds (founder): Namespace Mac for iOS apps; Live Activities; Google OAuth integration
  (interpreted as: Google is the first one-tap integration — Gmail/Calendar/Drive/Sheets; everything else by
  pasted key with header swap). Google OAuth app will show "unverified app" warning until verified (fine for
  friends; verify 100-user cap / restricted-scope behavior during build; avoid "Testing" status because its
  refresh tokens expire after 7 days).

## Design decisions (2026-11-04)
- Direction: Deck (dark, decisions-first home, project = roadmap with needs pinned to milestones).
- Project screen = two tabs: Status (default, live-updating roadmap card) | Chat.
- Chat is Instinct/Muse-style: only messages the agent explicitly chooses to send (plus the user's). Never tool
  calls, thinking, or streamed output. Implies a `send_message`-style tool for the agent.
- Never expose "foreman" or the orchestrator concept to the user.
- NO live voice conversation (GPT-Live dropped entirely). Input everywhere = keyboard + dictation (speech to
  text into the composer, then send). Rationale (founder): no foreground agent filling the air; the background
  agent researches as much as it can and asks sharp, direct questions; long pauses are fine.
- Dictation engine: on-device iOS speech recognition (no API key) unless quality forces otherwise.
- iOS distribution: each person's own Apple Developer account ($99/yr), connected once as an integration
  (App Store Connect API key: issuer ID + key ID + .p8), requested by the agent when the first iOS app is ready to
  install. User is their own internal tester → no TestFlight review. Builds expire after 90 days → agent
  re-uploads as maintenance. Open design issue: xcodebuild/altool need the .p8 on the Mac; either place it on the
  ephemeral Namespace Mac only for the signing/upload step (pragmatic exception to "no secrets in sandbox"), or
  have the proxy mint the ES256 JWT for api.appstoreconnect.apple.com and keep signing assets server-side.
- Design LOCKED: Deck v3 (mocks/deck on origin, commit d3ba192). Change: "Something else…" (free text + dictation)
  only in the expanded full-screen view, not inline on chat cards.

## Implementation research (verified 2026-11-04)
- @ai-sdk/harness-claude-code: backed by claude-agent-sdk; ships a bridge process inside the sandbox that talks to
  the host over WebSocket on a loopback port. Installs its own pinned claude CLI with pnpm (~1.5 GB peak; template
  needs pnpm + >=2 GB RAM). @ai-sdk/harness-codex: runs `codex app-server` in the sandbox over JSON-RPC.
- HarnessAgent host can run on the same machine via a local sandbox provider (ai-sdk-sandbox-local 0.1.2,
  ai-sandbox-local 0.1.1; "no isolation", fine inside the E2B VM). Resume: session.detach()/stop() return resume
  state; createSession({ sessionId, resumeFrom }).
- E2B (e2b 2.63.0): lifecycle { onTimeout: "pause", autoResume: true }; resume triggered by SDK ops AND HTTP to
  exposed ports; after resume min 5-min timeout. Pro $150/mo: 24h max continuous runtime (pause/resume resets it),
  paused sandboxes retained indefinitely (Hobby too), 100 concurrent. allowPublicTraffic + trafficAccessToken exist.
- E2B egress: network.rules = per-host (exact or *.wildcard) header-injection transforms applied by E2B's egress
  proxy (HTTPS only; headers only; values resolved client-side, never enter the VM); allowOut/denyOut;
  egressProxy = BYO SOCKS5 tunneled on host (sandbox can't bypass). Rules updatable on a running sandbox.
  => Credential injection can be E2B-native, with Infisical as the vault of record.
- Namespace macOS: $0.04–$0.20/min by shape; plan gating unclear (pricing page: Team $100/mo+; limits doc lists
  Developer too). Access: nsc ssh / native ssh with key / GetSSHConfig API short-lived creds.
- APNs: no server-side way to remove delivered notifications; best effort = silent push -> app removes by id,
  plus cleanup on app open. Live Activities: build widget target via @bacons/apple-targets (expo-live-activity
  deprecated per npm — verify); APNs direct from Worker (ES256 JWT via WebCrypto).
- Dictation: expo-speech-recognition 58.0.1.

## Architecture decisions (2026-11-04, founder)
- Global relational DB for everything above a project (users, invites, devices/push tokens, model connections,
  integrations metadata, projects index, usage ledger, cross-project projections like open asks for Home).
  Per-project state (chat, asks, status card, schedules, sandbox lifecycle, live activity) in one Durable Object
  per project. No per-user DO for data. Proposed global DB: Cloudflare D1 via @effect/sql-d1 4.1.2;
  DO SQLite via @effect/sql-sqlite-do 4.1.2.
- Agent context (not a rule): users may later turn a project into something serving millions. Keep a clean seam
  between product code that would survive and the single-sandbox scaffolding that would be torn out (local DB,
  local queues/cron, process supervision, hosting from the sandbox).
- Credential injection: E2B egress network.rules header transforms; Infisical is the vault of record; Dream backend
  pushes values to E2B on sandbox create/resume and on token refresh. Fallback if trouble: Infisical Agent Vault
  proxy (via E2B egressProxy/HTTPS_PROXY + CA).
- Private apps PUNTED. Web apps are public at an unguessable URL: https://<slug>-<random>.<domain> via a small
  gateway Worker → the project's E2B port URL (stable across sandbox re-creation; wakes the sandbox). Agent context:
  anyone with the link can open it; protect sensitive data inside the app if needed.
- Agent continuity: event-driven turns. The agent works within a turn as long as it wants; when it stops it sleeps
  until something wakes it (user message/answer, a self-scheduled wake, an alert from its app via `dream wake`,
  usage reset). Dream never auto-"continues" it. Agent reaches Dream through one `dream` CLI in the sandbox, usable
  by apps it builds too.

## Build kickoff (2026-11-04)
- Founder approved the plan. Implementation subagents: Opus. No per-step review / UX review rounds; target is
  functional and matching Deck v3.
- Credentials requested via ol connections (workspace scope): cloudflare-api (api.cloudflare.com, bearer),
  e2b-api (api.e2b.app, X-API-KEY), infisical-api (app.infisical.com, bearer, Token Auth identity),
  browserbase-api (api.browserbase.com, X-BB-API-Key), namespace-compute (us.compute.namespaceapis.com, bearer),
  expo-api (api.expo.dev, bearer). Test each before building on it.
- Production runtime secrets live in Infisical (operator folder); the deployed Worker gets one Infisical
  credential. ol connections are for dev/testing only and can't be read by the deployed Worker.
- Cloudflare verified 2026-11-04: account 2d98de7c4511e98d2f774c4fcc9b9b93, zone omer.build (7607e25c5b01b03ce152488e2dffb0cc,
  Free plan, no DNS records). Worker upload/delete OK, D1 create/delete OK, DO namespaces list OK, routes/DNS OK.
  R2 NOT enabled (needs dashboard enable). No workers.dev subdomain yet. Universal SSL covers only first-level
  wildcard (*.omer.build), so app hosts should be first-level: <slug>-<rand>.omer.build.
- E2B verified 2026-11-04 (account on HOBBY plan: "Timeout cannot be greater than 1 hours" → needs Pro):
  * Node E2B SDK bypasses env proxies (own undici Agent); pass `proxy: process.env.HTTPS_PROXY` in opts when the key
    is injected by an HTTPS proxy (dev only; production Worker has the real key).
  * network.rules header injection WORKS: placeholder Authorization replaced, secret absent from sandbox env.
  * Setting `network` makes public URLs require `e2b-traffic-access-token` (sbx.trafficAccessToken). Gateway adds it.
  * HTTP to exposed port of a PAUSED sandbox (with token) auto-resumed in ~180 ms; background server process survived.
  * Base template = 2 vCPU / 512 MB / Node 20 → npm i of CLIs OOM-killed. Custom template via
    Template().fromNodeImage('24')...; Template.build(tpl, name, {cpuCount, memoryMB}) built in ~52 s.
  * Claude Code 2.1.318 with placeholder CLAUDE_CODE_OAUTH_TOKEN: no local validation, reaches API → 401 "OAuth access
    token is invalid" (so header swap on api.anthropic.com should work). Codex 0.166.0 without auth.json uses
    api.openai.com/v1/responses; ChatGPT-auth path (chatgpt.com/backend-api/codex) still to test.
- INFISICAL DROPPED (founder, 2026-11-04). User credentials (Claude token, ChatGPT tokens, Google OAuth tokens,
  pasted keys, App Store Connect keys) are stored AES-GCM encrypted in D1 (`secrets` table; envelope key held only
  as a Worker secret). Operator keys (E2B, Browserbase, Namespace, APNs .p8, Google client secret) are Cloudflare
  Worker secrets entered by the founder in the dashboard. Infisical Agent Vault remains the fallback only if E2B
  egress injection falls short.
- Namespace verified 2026-11-04: Connect JSON over HTTPS to us.compute.namespaceapis.com works with the bearer
  token (Node fetch through proxy). CreateInstance {shape:{virtualCpu:4,memoryMegabytes:7168,os:"macos",
  machineArch:"arm64",selectors:[{name:"macos.version",value:"26.x"}]}, deadline} → RUNNING in ~17 s.
  GetSSHConfig {instanceId} returns sshPrivateKey (base64 bytes), username, endpoint — needs the token's "ssh"
  action (first token lacked it → 403). DestroyInstance works.
- Browserbase verified 2026-11-04: project 4f21c650-4b2a-4f5d-b890-e2c0d5b3404e ("Personal project", concurrency 3,
  defaultTimeout 300 s — looks like the free plan). POST /v1/sessions {projectId,timeout} → connectUrl (CDP, signed,
  no API key needed to connect); GET /v1/sessions/:id/debug → debuggerFullscreenUrl (live view);
  playwright-core connectOverCDP works; POST /v1/sessions/:id {projectId,status:"REQUEST_RELEASE"} ends it.
- Namespace SSH verified with the new token (instance actions "*"): GetSSHConfig → endpoint ssh.iad2-a.namespace.so
  (port 22), username = instance id, sshPrivateKey base64. Plain `ssh -i key user@endpoint` works. Image
  macos.version=26.x: macOS 26.3.1, Xcode 26.1.1, iOS/visionOS simulator runtimes present. RUNNING in ~12 s.
- NO EAS / Expo account (founder, 2026-11-04). Dream's own iOS builds use the same path as users' iOS apps:
  `expo prebuild` → xcodebuild archive/export on a Namespace Mac with an App Store Connect API key
  (-allowProvisioningUpdates -authenticationKey*) → upload to TestFlight. Expo the open-source framework stays.
  Open: how the ASC .p8 reaches the Mac without passing through a sandbox (candidates: Worker writes it via Namespace
  CommandService; Namespace's own vault secrets).
- ASC key path (docs, not yet tested): Namespace Vault secrets (dashboard/`nsc vault add`/VaultService API) are
  injected as env vars at instance creation via `env_vars: [{name, from_secret_id}]` on ContainerRequest
  (check ApplicationRequest for macOS). Founder's ASC .p8 for Dream's own TestFlight builds → Namespace Vault; never
  passes through a sandbox. For users' ASC keys, the Worker could create per-user Vault secrets via VaultService.
- Namespace quota (2026-11-05): macOS limit on the founder's plan is 6 vCPU / 14 GB TOTAL across instances
  ("0th instance limit ... used all of 6 vCPU 14 GB RAM"), so only one 6x14 Mac at a time. 8x14 is rejected (429).
  Mac image has Homebrew, node 25, CocoaPods 1.16.2, xcbeautify, ruby 3.4, git; NO rsync (use tar over ssh), no bun.
  New workspace connections DO appear in an existing child thread on its next turn.

## Control plane research (2026-11-05, ws/control-plane; source-read and run against real binaries/APIs)
- E2B (live): a background process started over envd `process.Process/Start` (Connect+JSON) keeps running after the
  stream is dropped. `PUT /sandboxes/{id}/network` on a PAUSED sandbox → 404 (update rules only while running; the
  ProjectDO marks rules dirty and pushes them on the next resume). `GET /sandboxes/{id}` echoes the rules, values included.
- Codex 0.166.0 (codex-rs): device auth prints to stdout (no TTY needed): URL https://auth.openai.com/codex/device and
  code like `054Q-3BC5A` (15 min); exit 0 + stderr "Successfully logged in"; writes $CODEX_HOME/auth.json (dir must exist).
  Refresh: POST https://auth.openai.com/oauth/token JSON {client_id:"app_EMoamEEZ73f0CkXaXp7hrann",
  grant_type:"refresh_token", refresh_token, refresh_reason} → {id_token?, access_token?, refresh_token?}; refresh
  tokens are single-use (`refresh_token_reused`). Env CODEX_REFRESH_TOKEN_URL_OVERRIDE redirects Codex's own refreshes.
  Placeholder auth.json that never refreshes and still sends the header: access_token = JWT-shaped with exp 4102444800,
  id_token = any valid 3-part JWT carrying the REAL chatgpt_account_id/plan/email claims (no signature check),
  account_id = real id, last_refresh = any RFC 3339 time (if absent, NO Authorization header is sent). A backend 401
  → Codex refreshes via the override URL; if that fails the turn dies. Model traffic: chatgpt.com/backend-api
  (codex/responses tries a WebSocket first, then HTTPS), headers `authorization: Bearer <access>` and
  `chatgpt-account-id`. GET /backend-api/wham/accounts/check must list the account id.
- Claude Code 2.1.318: `claude setup-token` needs a PTY (no flags); headless it prints the URL at once:
  https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&…; wrapped lines are
  OSC 8 hyperlinks carrying the full URL; prompt "Paste code here if prompted >"; paste `CODE#STATE` + CR (masked);
  success prints "Your OAuth token (valid for 1 year):" then the `sk-ant-oat…` token; exit 0. With
  CLAUDE_CODE_OAUTH_TOKEN set (no local validation) all bearer traffic goes to api.anthropic.com
  (`authorization: Bearer`, `anthropic-beta: …oauth-2025-04-20…`).
- Browserbase (live): projectId optional on create (inferred from key); recording on by default; connectUrl embeds a
  signing key (no API key needed to connect); GET /v1/sessions/{id}/debug → debuggerFullscreenUrl (shareable, ≤6 h);
  POST /v1/sessions/{id} {status:"REQUEST_RELEASE"} is synchronous and idempotent. rrweb recordings are GONE (410):
  MP4 via POST /v1/sessions/{id}/recording/downloads (202) then GET same path until COMPLETED → signed downloadUrl (6 h,
  no key), only after the session ended. Billing per minute, 1-minute minimum.
- Namespace (live): shape {virtualCpu:4, memoryMegabytes:7168, os:"macos", machineArch:"arm64",
  selectors:[{name:"macos.version",value:"26.x"}]}; CreateInstance is non-blocking (RUNNING in 8–18 s; poll
  DescribeInstance); GetSSHConfig → {sshPrivateKey (b64), username (= instance id), endpoint "ssh.<site>.namespace.so",
  sshHostKeys[b64]}, no expiry, same key per instance; ExtendInstance {instanceId, ensureMinimum:"1800s"};
  DestroyInstance idempotent. No idle auto-stop: only `deadline` (Developer plan max 3 h). macOS allowed on every plan
  (Developer: 12 vCPU / 28 GB concurrent).
