# Handoff: continuing Dream in a new environment

Written 2026-11-09 by the coordinating agent that built and ran Dream in Outerloop, for whoever picks the work up
next. Dream is live and in daily use. Read this first, then `AGENTS.md` (the project guide; `CLAUDE.md` is a link to
it) and `docs/PLAN.md`.

## 1. Get the code

The code lives at **https://github.com/omerdemirkan/dream** (private). Its `main` is the same as the Outerloop
workspace's `main` as of this document. From now on, treat GitHub as the source of truth.

```sh
git clone https://github.com/omerdemirkan/dream.git && cd dream
```

`AGENTS.md` says `main` is "mirrored" to GitHub after each deploy. That was true while Outerloop's own git storage was
the origin. In the new environment GitHub *is* the origin, so `git push origin main` is all that step means now.

## 2. Install the tools

- **Bun 1.4.4.** The repo pins it in `packageManager`. Install with `curl -fsSL https://bun.sh/install | bash`, and
  make sure `~/.bun/bin` is on `PATH`.
- **Node 24 or newer.** dreamd runs on Node 24 inside the sandboxes. Scripts run fine on newer versions; the last
  environment had Node 26.
- **git**, **curl** and **python3** (a few one-off commands use it).

Then:

```sh
bun install
bun run check
```

`bun run check` runs the format check, typechecks every package, then runs all tests (about 950; around three
minutes). The typecheck runs all packages in parallel, and on machines with little memory the mobile package gets
killed. If that happens, typecheck one package at a time, then run the tests:

```sh
for p in packages/domain packages/agent-context packages/sandbox-template packages/dreamd apps/api infra apps/mobile; do
  (cd $p && bun run typecheck) || echo "FAILED: $p"
done
bun run format:check && bun run test
```

## 3. Credentials

In Outerloop no credential was ever in an environment variable. Outerloop's proxy added them to outgoing requests by
host, which is why `AGENTS.md` says `CLOUDFLARE_API_TOKEN=anything`. In a new environment you supply the real values.
The scripts read them from the environment when set, and some only gained that ability in the commit that added this
document.

### The root `.env`

`.env` is gitignored and was never committed. Create it at the repo root:

```sh
DREAM_DOMAIN=omer.build
DREAM_R2_ENABLED=true          # without it, a deploy unbinds media storage
DREAM_EMAIL_ENABLED=true       # agent email (dream email); without it a deploy drops the mail subdomain
DREAM_OPERATORS=<the founder's email>   # who sees everyone's costs in the app; it's a plain var, so it must be here
CLOUDFLARE_ACCOUNT_ID=2d98de7c4511e98d2f774c4fcc9b9b93
CLOUDFLARE_API_TOKEN=<real Cloudflare API token>
E2B_API_KEY=<E2B team API key>
NAMESPACE_TOKEN=<Namespace API token>
BROWSERBASE_API_KEY=<Browserbase API key>   # only the daily cost review reads it
```

Scripts expect it loaded into the shell: `set -a; . ./.env; set +a`.

| Credential | What uses it | Where to get it |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Deploys (`bun run infra:deploy`), reading D1 from scripts (costs, review, `qa.ts`), OTA publishing (reads `UPDATES_PUBLISH_SECRET` from D1) | Cloudflare dashboard → My Profile → API Tokens. It needs Workers Scripts, Workers Routes, D1 and R2 edit, Email Sending edit, and DNS and Zone access on `omer.build`. The "Edit Cloudflare Workers" template plus D1, R2 and Email Sending edit covers it. |
| `E2B_API_KEY` | Template builds (`bun run template:build`), every `*-check.ts` script, the cost scripts | e2b.dev dashboard → Team → API keys. It's the same key as the Worker secret of that name. |
| `NAMESPACE_TOKEN` | Mac scripts (`apps/api/scripts/mac-check.ts`, `apps/mobile/scripts/testflight-namespace.ts`), the review's Mac listing | cloud.namespace.so, Dream's workspace `lso1fm36nm1rq` → tokens. Same as the Worker secret of that name. |
| `BROWSERBASE_API_KEY` | The review's open-browser check | Browserbase dashboard → Settings. |
| GitHub | Clone and push | The founder's fine-grained token for `omerdemirkan/dream` expires **2026-12-09**. Make a new one, or use the new environment's own GitHub integration. |

**Credentials you don't need to supply.** These already live where Dream needs them and survive deploys:

- **Worker secrets in Cloudflare**, readable by name only: `APNS_*`, `ASC_TESTFLIGHT_KEY_P8`, `BROWSERBASE_*`,
  `DEV_LOGIN_SECRET`, `DREAM_ENCRYPTION_KEY`, `DREAM_SIGNING_KEY`, `E2B_API_KEY`, `GOOGLE_*`, `NAMESPACE_TOKEN`,
  `UPDATES_PUBLISH_SECRET`, and a few flags. `OPENAI_API_KEY` is deliberately not set yet (see section 6).
- **D1 `dream-ops`** (uuid `3f029b08-1f70-4f63-be13-6dc90ffd5f03`): its `settings` table holds `DEV_LOGIN_SECRET`
  and `UPDATES_PUBLISH_SECRET` for scripts. `qa.ts` and `updates.ts` read them with the Cloudflare token.
- **Namespace's vault** holds the App Store Connect key used for TestFlight builds (`docs/setup/testflight.md`).

**Never rotate `DREAM_ENCRYPTION_KEY`.** Every stored user credential (Claude and ChatGPT tokens, Google tokens,
pasted keys) is encrypted with it, and a new key makes them all unreadable. `infra/scripts/ensure-secrets.ts` never
replaces it.

## 4. Deploying from a new machine

Read "Deploying" in `AGENTS.md`. What's different on a fresh machine:

- **Alchemy state.** It was kept locally in `.alchemy/`, which is gitignored and not in the repo. `infra:deploy`
  already passes `--adopt`, and the D1 database and R2 bucket names are pinned in `apps/api/src/Resources.ts`. So a
  fresh machine adopts the live Worker, DO classes, D1, R2, routes and DNS instead of creating new ones.
- **Run a plan before the first deploy.** Run `bun run infra:plan` first and read it. Expect "update" and "adopt"
  lines. If it plans to *create* or *delete* a D1 database, an R2 bucket, the zone or the Worker, stop and find out
  why before deploying.
- **Deploy only from an up-to-date `main`.** Every deploy replaces the whole Worker, so deploying from a stale branch
  rolls back other people's fixes.

| What changed | Command | Then |
| --- | --- | --- |
| Worker (`apps/api`, domain shapes it uses) | `bun run infra:deploy` | `curl https://dream.omer.build/health` returns 200 |
| dreamd, `dream` CLI, prompts, skills (`packages/dreamd`, `packages/agent-context`, `docs/prompts`) | `bun run template:build` (about 5 min; runs a turn on each harness against fake models before making the build current) | Running sandboxes pick it up between turns |
| App JavaScript (`apps/mobile`) | `node apps/mobile/scripts/updates.ts publish` | Phones get it on next launch. Native changes need a TestFlight build, and `publish` says so. |

Pushing to GitHub is part of every deploy (`git push origin main`).

Live identifiers, in case something needs checking:

- **API:** `https://dream.omer.build`. Published apps are served at `*.omer.build`.
- **Cloudflare:** Worker `dream-api`. Main D1 is `Dream-Database-prod-kccyzam25lk62vk7` (uuid
  `9bb56e9d-a0b2-47f9-a10c-a18d51c7d86f`). R2 buckets are `dream-media` and `dream-updates`.
- **E2B templates:** `dream-sandbox` and `dream-sandbox-large`. The current build is `release-bb73d2abe8f5f223`.
  Roll back with `bun run template:build promote <release>`.
- **App:** the iPhone app is TestFlight build `26858598`. The latest OTA on `production` is `44d5d908`
  (commit `8024c2d`, Settings B). Commits after it change only docs and scripts.

## 5. Where we left off

### Shipped on Nov 8–9 (all live)

- **Reply crash.** Reply on an expanded question or access card no longer crashes the app. A test
  (`apps/mobile/test/worklets.test.ts`) catches the cause.
- **App crash and error reports.** These go to `POST /client-errors` and are stored in D1 `client_errors`. Read them
  at `GET /admin/client-errors` with header `x-dream-dev-secret: <DEV_LOGIN_SECRET>`.
- **Keyboard.** Chat and threads show a "Hide the keyboard" button while typing. Opening a question or thread puts
  the keyboard away.
- **Advanced button.** On New idea it's now a round icon button like the mic, paperclip and send buttons.
- **Agent observability.**
  - Each project keeps a log. dreamd writes the sandbox half to `~/.dream/logs/*.jsonl`; the ProjectDO keeps the
    gateway's requests, notifications, relay alerts and refreshes.
  - `dream logs` merges both halves.
  - "Dream noticed a problem" alerts fire for a failing published app, a scheduled job failing repeatedly, and low
    memory or disk.
  - Each turn reports memory and swap peaks into D1 `turn_usage`.
  - The system prompt now makes the agent own the experience after shipping (`docs/prompts/system/opening.md`,
    `success.md`, `once-its-live.md`).
- **Resource telemetry and a daily review.**
  - D1 `sandbox_usage` stores hourly CPU, memory and disk per sandbox. `sandbox_wakes` records why a sandbox woke
    between turns.
  - `node packages/sandbox-template/scripts/resource-review.ts` is the daily review. It exits 2 when something needs
    action.
- **Live-loading state.** The project screen no longer goes blank while its live connection reconnects. It shows the
  last view, then "Catching up", then "Can't reach Dream".
- **Settings B.** Settings was redesigned as an index of rows, each opening a page. The founder picked this direction
  from three mocks.
- **Mac costs.** Mac idle-stop is based on probes (stops after 15 min unused) and logged in D1 `mac_activity`. This
  came out of the Mac cost investigation.
- **GitHub mirror.** The repo was pushed to GitHub.

### Open items, most important first

1. **Namespace's command service has been down since about 23:00 UTC Nov 8.**
   - **Symptom:** `RunCommandSync` times out (`dial tcp 10.1.135.x:41xx`) on every new Mac.
   - **Effect:** the Mac idle probe can't see use, so a forgotten Mac stops 60 minutes after its last SSH instead of
     15. That's at most about $3.60 a Mac, and nothing during the trial.
   - **Next:** retest with a read-only `uptime` on a Mac that isn't a project agent's. If it's still failing, build
     the planned fallback: dreamd probes the Mac over the SSH it already has and reports busy or idle to the
     ProjectDO, used when the command service fails.
2. **Namespace's free trial ends around Dec 6.** After that a project's Mac costs about $3.60/h (list price). The
   founder keeps Namespace on the trial (one Mac at a time, shared with project agents). Don't propose upgrading, but
   tell them before real charges start.
3. **The GitHub token expires Dec 9.** Pushes stop until there's a new credential.
4. **The OpenAI gateway is built but switched off.** It waits for the founder to add an `OPENAI_API_KEY` Worker
   secret, ideally with a spend limit. Then:
   - set `DREAM_AI_GATEWAY_ENABLED=true` in `.env`,
   - redeploy,
   - run `node packages/sandbox-template/scripts/gateway-live-check.ts`.
5. **Optional credential hygiene the founder may still do.** On Nov 8 a sub-agent read a sandbox's details from
   E2B's API. The response contained Anki Voice's injected credentials (its OpenAI key and the founder's Claude token)
   in plain text, inside that agent's transcript. Nothing leaked outside, and `AGENTS.md` now forbids printing that
   response. Replacing the OpenAI key is optional; the founder knows and decides.
6. **Smaller known gaps:**
   - `turn_usage` cost is null for turns stopped at a usage limit.
   - The Codex half of `scripts/prompt-refresh-check.ts` never ran (proxy trouble in Outerloop).
   - The Morning Build sits on a large sandbox (4 vCPU, 8 GB) it rarely needs, about $2 a month. Only its agent can
     move it.
   - The `dream-updates` R2 bucket has no pruning. It grows about 150 MB a day and stays inside R2's free 10 GB for
     roughly two months.
   - E2B is on the Hobby plan (1-hour run cap, handled by pausing and resuming). Pro is optional; see
     `docs/setup/e2b-pro.md`.
   - Not covered in the Settings B Simulator pass: swipe-to-delete on archived projects, the restart-to-update row,
     and a removal run to completion.

### Recurring duties

- **Daily cost and resource review (was 15:00 UTC).** Run it with `.env` loaded:

  ```sh
  node packages/sandbox-template/scripts/costs.ts --days 1 --budget 5
  node packages/sandbox-template/scripts/resource-review.ts
  ```

  Chase each finding to its root cause and fix it. Only bring the founder genuine decisions. The founder made the
  agent own cost and resource monitoring and doesn't want routine findings.
- **Reminder on Dec 8:** the GitHub token. **Reminder before Dec 6:** the Namespace trial.

## 6. How the founder works

These are standing preferences, learned over the build. Follow them without being asked.

- **Ship without asking.** Build, test and deploy whatever they ask for. Offer options or design docs only when they
  ask for them. For a substantial new feature, ask questions one at a time, then show mocks: several only if the
  directions are truly divergent. Settings went that way: three directions, they picked one, then it was built.
- **Platform fixes over prompt workarounds.** When the agent in a sandbox misbehaves, fix Dream itself if you can.
- **Agent prompts give context and goals, not rules.** Keep them model-agnostic. Edit sections in `docs/prompts/`,
  then run `bun run sync-prompts`.
- **User-facing text is sparing and natural.** Brevity should come from choosing what matters, not from clipped
  fragments or "Label: value" lines.
- **"Add" affordances** are dashed tiles shaped like the items they add, never a small standalone "+".
- **Vendor-neutral billing design.** Metering is built so a usage-billing vendor can be added later. Don't name a
  vendor or adopt one's shapes until they choose one.
- **Restate open questions.** Their UI collapses messages, so repeat any open question at the end of each message.
- **Settled calls.** Claude and ChatGPT terms-of-service risk in Dream is decided; don't re-raise it.

## 7. Safety rules

- **Never print, log or commit a secret.** That includes:
  - sandbox output, which can contain the founder's Claude token,
  - E2B's `GET /sandboxes/{id}`, which returns injected credentials in plain text,
  - the founder's email in public places.
- **Keys never pass through chat.** Ask the founder to put credentials into a secret store or the environment, not to
  paste them.
- **Leave the founder's real projects alone.** Don't message them, start turns in them, or change their files:
  - Anki Voice (`prj_fc22f93d64294d6b9ba03eda1eda0ac1`)
  - Arabic conversation partner (`prj_50afbb8354364385a4bac4bcf6380bbc`)
  - The Morning Build (`prj_07bb28f6d1524f67830c55ba4396b5e8`)

  Read-only checks are fine. Never stop or touch a project agent's Namespace Mac.
- **Don't spend the founder's Claude or ChatGPT subscription on tests.** The checks run against fake model servers
  (`packages/dreamd/scripts/fake-*.ts`). `qa.ts` signs in as the founder by default, and `qa.ts idea` starts a real
  turn on their subscription, so don't use it for testing. End any QA run with `qa.ts done`.
- **Throwaway sandboxes** carry `devSandboxMetadata(...)`, and the Worker reaps orphans after an hour. Dev Macs on
  Namespace are labelled `dream=sim-check` or `dream=mac-check`. Destroy them when done; there's one Mac slot.
- **One deployer at a time.** If several agents work in parallel, only one deploys, from an up-to-date `main`.

## 8. What doesn't carry over from Outerloop

- **Credentials** came from Outerloop's proxy. Now they come from `.env` (section 3).
- **Sub-agents, timers and background jobs** used `ol threads`, `ol listen` and `ol jobs`. Use whatever the new
  environment offers, or a person and a calendar. The duties in section 5 are what those timers were for.
- **iOS Simulator checks** ran on a Namespace Mac (Xcode 26.4 or newer), because Outerloop's Simulator only has Expo
  Go. See "Screens" and "TestFlight" in `apps/mobile/README.md`; the scripts need `NAMESPACE_TOKEN`. Every screen
  state has a fixtures link (`DREAM_BACKEND=fixtures`).
- **Showing mocks to the founder** used a temporary public link from the sandbox. The Settings mocks are in
  `mocks/screens/settings-directions/` on branch `settings-directions`, with PNGs, for reference.
- **The agent's memory notes** for this founder are folded into section 6.
