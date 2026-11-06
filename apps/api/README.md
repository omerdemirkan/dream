# @dream/api — the control plane

One Cloudflare Worker (`dream-api`) with one Durable Object class (`ProjectDO`), D1, and (once enabled) R2.
Deployed with alchemy from `infra/alchemy.run.ts`; live at `https://dream.omer.build`.

## What runs where

| Piece | File | What it does |
| --- | --- | --- |
| Worker | `src/Api.ts`, `src/http/Router.ts` | Dispatches by host. The API host serves `/rpc` (AppRpcs), `/sandbox/rpc` (SandboxRpcs), `/projects/:id/live` (ticket check, then the DO's socket), `/media/:id` (GET) and `/media/:id/upload` (PUT), `/oauth/google/callback`, `/health`, `POST /admin/projects/:id/archive` (deletes a project for good: the operator's cleanup, the same as `DeleteProject`), and the app's over-the-air updates (`/updates/manifest`, `/updates/assets/:hash`, `/updates/certificate`, and `/admin/updates/*` behind `UPDATES_PUBLISH_SECRET`; `src/http/Updates.ts`). Every other `*.<domain>` host is the gateway. |
| Cron (every 5 min) | `src/WorkerLayer.ts` `maintenance` | Refreshes ChatGPT access tokens, Google access tokens and App Store Connect JWTs that expire within 10 minutes, pushes them to the person's sandboxes, and ends sign-ins left pending. |
| ProjectDO | `src/ProjectDO.ts`, `src/project/*` | One per project, on its own SQLite: chat, asks, Status card, wakes, sandbox, Live Activity, notifications, the agent's inbox, browser sessions, the Mac, timers. Two surfaces on `fetch`: `/live` (WebSocket, `ProjectLiveRpcs` only) and `/internal/rpc` (`ProjectRpcs` + `SandboxRpcs`, reached only by the Worker). |
| D1 | `migrations/0001_init.sql`, `src/db/*` | Users, invites, devices, encrypted secrets, model connections, integrations, OAuth states, and the projections Home reads (projects, open asks), plus notifications, media and the usage ledger. |
| Providers | `src/e2b/*`, `src/brokers/*`, `src/push/Apns.ts`, `src/integrations/Google.ts`, `src/connect/ChatGpt.ts` | E2B REST and envd (Connect JSON, PTY), dreamd's DaemonRpcs, Browserbase, Namespace, APNs, Google, OpenAI's token endpoint. Plain fetch; no Node SDKs. |

## Flows worth knowing

- **Sandbox lifecycle.** The first event (the idea) is delivered by the DO's alarm. If there's no sandbox, the DO
  creates one from `E2B_TEMPLATE` (default `dream-sandbox`) with `autoPause` + `autoResume`, a 5-minute idle timeout,
  `allowPublicTraffic: false`, and egress rules carrying the person's credentials. It writes dreamd's environment to
  `DaemonEnvFile` (`/home/user/.dream/dreamd.env`, dotenv) and waits for `DaemonRpcs.Health` on
  `https://4747-<sandbox>.e2b.app/daemon/rpc`. If dreamd doesn't answer within 45 s it runs `DREAMD_COMMAND` itself.
  While a turn runs (`ReportTurn started`) the DO keeps the E2B timeout 60 minutes ahead; when it finishes, back to 5.
- **Delivery** is at least once: events stay in the DO's inbox until dreamd lists them in `accepted`. Failures back
  off 5 s, 15 s, 45 s … up to 15 min. If E2B says the sandbox is gone, the next delivery creates a new one; if dreamd
  isn't answering, the env file is rewritten (dreamd's supervisor restarts it).
- **Credentials** never enter a sandbox. Claude: `Authorization: Bearer <token>` on `api.anthropic.com`. ChatGPT:
  `Authorization: Bearer <access>` + `ChatGPT-Account-ID` on `chatgpt.com` (both via `ModelEgress`). Google: bearer on
  the scopes' API hosts. Pasted keys: `header: format` on their host. App Store Connect: a fresh ES256 JWT on
  `api.appstoreconnect.apple.com`. Rules are pushed whenever anything changes; a paused sandbox can't take new rules,
  so they're marked dirty and pushed on the next resume (delivery or gateway).
- **Model connections** run each CLI's own sign-in in a short-lived sandbox (`E2B_AUTH_TEMPLATE`, else the project
  template): `claude setup-token` in a 500-column PTY (URL scraped from its OSC 8 link; the pasted `CODE#STATE` is typed
  into the PTY; the printed `sk-ant-oat…` token is stored) or `codex login --device-auth` (code relayed;
  `~/.codex/auth.json` read when the phone polls `GetModelConnection`). Both install the CLI with npm if the template
  lacks it.
- **Usage limits.** `ReportUsage` with `limitedUntil` pauses this project (deliveries held) and every other project of
  the person, and sets the Status card's `pausedUntil`. At the reset the reporting project gets `UsageReset`; the others
  just resume delivering whatever arrived.
- **Notifications.** Questions and access requests (without `when`) always notify; messages with `--notify`. The
  `apns-id` is the message's `notificationId`; answering, withdrawing, connecting or declining withdraws it with a silent
  push and marks it stale for `FilterStaleNotifications`.
- **Live Activity.** `dream live start` sends push-to-start to every device with a token; `RegisterLiveActivity` adds
  the activity's update token (and sends the current content at once). While an ask is open the content gets
  `needsYou` and the update goes out at priority 10.
- **Mac.** Namespace macOS 26.x, 4 vCPU / 7 GB, created with a 90-minute deadline that `GetMacSsh` keeps 30 minutes
  ahead; destroyed after 20 minutes without `GetMac`/`GetMacSsh` (the CLI should call `GetMac` every few minutes during
  a long ssh session). Minutes go to `usage_events`.

## Operating it

```sh
bun run infra:plan
bun run infra:deploy                       # stage prod, local alchemy state, --adopt
node infra/scripts/ensure-secrets.ts       # generates DREAM_ENCRYPTION_KEY / DREAM_SIGNING_KEY once; lists missing secrets
node infra/scripts/invite.ts a@b.com …     # adds people to the invite list
node infra/scripts/dev-login.ts ensure     # DEV_LOGIN_SECRET in the Worker and in D1 dream-ops
node infra/scripts/dev-login.ts session a@b.com   # a session token for the deployed API
```

The scripts read `DREAM_DOMAIN`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the root `.env` (export it
first, e.g. `set -a; . ./.env; set +a`). With the Outerloop cloudflare-api connection the token value can be anything.

**State.** Alchemy keeps state in `.alchemy/state/Dream/prod` (gitignored). Its Cloudflare state store needs the API
token to have Secrets Store access; until then, a deploy from a fresh machine re-imports the live resources with
`--adopt` (the deploy script passes it), because physical names are fixed by stack, stage and logical id. Set
`ALCHEMY_STATE=cloudflare` to move to the shared store once the token allows it. No secret values live in alchemy
state: the generated keys are Worker secrets set by `ensure-secrets.ts`.

**R2.** Set `DREAM_R2_ENABLED=true` in the root `.env` and redeploy once R2 is enabled on the account; until then
`CreateMediaUpload` fails with a clear `InvalidRequest`.

## Worker secrets

Set in the Cloudflare dashboard → Workers & Pages → dream-api → Settings → Variables and Secrets, type **Secret**
(plain variables set there would be removed by the next deploy; secrets are kept).

| Name | What | Needed for |
| --- | --- | --- |
| `DREAM_ENCRYPTION_KEY`, `DREAM_SIGNING_KEY` | generated by `ensure-secrets.ts`; never change them | everything |
| `DEV_LOGIN_SECRET` | generated by `dev-login.ts ensure` | DevSignIn |
| `BROWSERBASE_PROJECT_ID` | set | browser sessions |
| `E2B_API_KEY` | E2B API key (Pro plan) | sandboxes, model sign-in |
| `BROWSERBASE_API_KEY` | Browserbase API key | `dream browser` |
| `NAMESPACE_TOKEN` | Namespace token with instance actions incl. `ssh` | `dream mac` |
| `GOOGLE_IOS_CLIENT_ID` | iOS OAuth client id (comma-separate several) | SignIn |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | web OAuth client; redirect URI `https://dream.omer.build/oauth/google/callback` | Google integrations |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY` | the .p8 key (whole PEM text), its id, the team, the app's bundle id | notifications, Live Activities |

Optional: `APNS_ENVIRONMENT=development` (Xcode builds; default production for TestFlight), `E2B_TEMPLATE`,
`E2B_AUTH_TEMPLATE`, `DREAMD_COMMAND`, `APP_URL_SCHEME` (default `dream`), `DREAM_API_HOST` (deploy-time, in `.env`).

## Tests

`bun run test` runs `test/flow.test.ts` (the Worker and ProjectDOs in memory over real RPC, D1 and DO SQLite on
Node's SQLite, providers faked) and `test/units.test.ts`. `DREAM_LIVE_E2B=1 bunx vitest run --project @dream/api
test/live` runs envd, egress rules and both CLI sign-in flows against real E2B.
