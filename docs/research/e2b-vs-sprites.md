# E2B vs Fly.io Sprites for Dream (research, 2026-11-06)

The question: is Dream's core model (one agent per project for hours to weeks, keeping the project's server running,
watching for errors and feedback, improving it continuously) better served by Fly.io's Sprites than by the E2B
sandboxes it runs on today?

Everything about Sprites below comes from Fly's own docs, API spec, blog, pricing page, release notes, infra log and
community forum, read on 2026-11-06, unless marked otherwise. Nothing was run on Sprites: the workspace has no Fly.io
connection, and signing up was out of scope (see "Trying Sprites for real" for what a test would take). E2B facts are
from `docs/research/verified-facts.md` (measured 2026-11-04/05) and E2B's docs and pricing page (read 2026-11-06).

## Executive summary

**Recommendation: stay on E2B. Don't migrate the dev sandbox to Sprites now.** Revisit in about three months (early
February 2027), or sooner if one of the conditions at the end comes true.

- **Sprites are better at what the founder's model asks for over time.** They have no run cap (an agent holds a
  Sprite awake with a renewable task), they bill for CPU and memory actually used rather than allocated, and they
  come with 8 vCPUs, memory that grows under pressure, 100 GB of disk and fast filesystem checkpoints. At
  "founder and a few friends" scale they'd cost roughly a fifth of E2B (about $75–100 a month against $360–510). For
  apps kept running around the clock, the gap is about 14× (about $200 against $2,900 a month).
- **They're worse at what Dream's current design stands on:**
  1. **Credential safety.** Sprites have no egress header injection. Connectors are a gateway URL the code inside
     has to call in place of the real host. Dream would have to point both harnesses, and every app the agent
     builds, at Fly's gateway, and give Fly the users' tokens. The other route is building its own egress proxy.
  2. **Images.** There are no custom images, and forking from a template isn't in the public API (staff, 2026-05-19:
     "there isn't a forking functionality in general that is available"). A new project would go from E2B's 1.4 s
     create to minutes of bootstrap.
  3. **Memory.** A *cold* Sprite drops memory and processes, and Fly doesn't say when warm turns cold. E2B keeps a
     paused sandbox's memory indefinitely.
  4. **Maturity.** Sprites launched 2026-01-09 and were relaunched 2026-07-24. Users reported data loss from
     January to April 2026, and the storage layer was replaced in October 2026. Fly's Infra Log has six Sprites
     incidents between 2026-08-30 and 2026-10-12, one of which took the Sprites API down for 7 h 43 min. Fly itself
     tells people whose apps need availability to move them to Fly Machines (2026-10-23).
- **Rough migration cost.** About 4–7 weeks of focused work. The credential work is the riskiest part (1–3 weeks)
  and would need everything that was verified on E2B to be verified again.
- **The gap is real, but a migration isn't the fix.** On E2B, a published app is frozen whenever nobody is using it,
  and it shares 8 GB with the agent. If always-on apps become a product requirement (bots, websockets, background
  workers), the better design is a hybrid: keep developing on E2B, and host the apps that need to stay up on
  Fly Machines (or Sprites). Do that per project, when a project needs it, rather than moving everything.

## What Dream relies on today (from the code)

Read from `apps/api/src/project/SandboxManager.ts`, `apps/api/src/e2b/*`, `packages/dreamd`,
`packages/sandbox-template` and the system prompt (`docs/prompts/system/`):

- **Lifecycle.** The sandbox is created with `autoPause` + `autoResume` and a 5-minute idle timeout
  (`IdleTimeout`). After each turn it pauses within about 5 minutes. A Deliver POST or gateway request to a port URL
  resumes it (~180 ms measured; 1.3 s for a full Deliver round trip). Processes and memory survive a pause, which is
  why a published app started detached (`setsid nohup …`) is still running when someone next opens the link.
- **Run cap.** While a turn runs, the DO's keepalive alarm pushes the timeout out every 5 minutes. Shortly before
  E2B's cap (`E2B_SANDBOX_MAX_RUN`: 1 hour on Hobby, which the account was on as of 2026-11-04; 24 hours on Pro) it
  pauses and resumes the sandbox itself, and it resumes one it finds paused mid-turn.
- **Credentials.** `SandboxCredentials` turns each person's connections (Claude/ChatGPT tokens, Google OAuth, pasted
  keys, App Store Connect JWTs) into E2B `network.rules`: per-host header transforms applied by E2B's egress proxy.
  The sandbox holds only placeholders. Rules can only be updated while a sandbox is running, so changes made while it
  is paused are pushed on the next resume (`rulesDirty`). The exception is keys no header can carry, which are
  written as files under `~/.dream/keys`.
- **Access tokens.** Every port URL needs `e2b-traffic-access-token`, and only the ProjectDO and the gateway have it.
  dreamd also checks its own per-sandbox token, because apps in the sandbox can reach it on localhost.
- **Two inbound ports.** dreamd's `DaemonRpcs` port and the published app's port, both on
  `<port>-<id>.e2b.app`.
- **Templates and refresh.** `template:build` makes an image with Node 24, pnpm, Bun, Playwright + Chromium, dreamd and
  pinned Claude Code/Codex. It checks a turn on each harness and then moves the `default` tag. `Refresh.ts` brings an
  existing sandbox up to date by tarring `/opt/dream` + the harness bootstrap (~800 MB) from a donor sandbox and
  swapping them in, with rollback.
- **Machine.** 4 vCPU / 7,956 MB, no swap, 14 GB disk (11 GB free). The OOM killer picks the biggest process.
- **Hosting and waking.** The Cloudflare gateway maps `<slug>-<rand>.omer.build` to the port URL. Scheduled wakes,
  usage-reset wakes and `dream wake` are DO alarms or events that reach dreamd over HTTP. Nothing inside a paused
  sandbox runs, so in-app cron doesn't either.

## Sprites, as documented (with dates)

| Fact | Source, date |
| --- | --- |
| Firecracker-style VMs on Fly Machines underneath; user code runs in an inner container managed from the VM's root namespace | [Design & Implementation](https://fly.io/blog/design-and-implementation/), 2026-01-14 |
| Three states: **active** (billed), **warm** (VM suspended, memory kept, wake 100–500 ms), **cold** (VM stopped, memory and processes dropped, wake 1–2 s). Pauses ~30 s after activity stops. You can't choose or see warm vs cold. | [Lifecycle](https://docs.fly.io/sprites/concepts/lifecycle) (docs repo commit of 2026-11-04) |
| "Warm → cold can take much longer" (no figure given) | [Pricing FAQ](https://fly.io/sprites), read 2026-11-06 |
| Open TCP connections drop on any pause, warm or cold | [Keeping a Sprite running](https://docs.fly.io/sprites/keeping-sprites-running) |
| Activity that holds a Sprite awake: in-flight HTTP/API request, stdout of a session/exec, open TCP connection, or a **task** (`/.sprite/api.sock`, max 1 h each, renewable; heartbeat pattern documented) | same, and pricing FAQ |
| **Services** (`sprite-env services`): started at boot, restarted on crash and on cold wake; one service may own the URL's HTTP port, and the proxy starts it on an incoming request. Logs at `/.sprite/logs/services/`. No systemd. | [Services](https://docs.fly.io/sprites/concepts/services) |
| 8 vCPU fixed; memory "managed for you … able to scale up under pressure"; a resources policy can set `limit_mb` and `autoscale` | [Lifecycle](https://docs.fly.io/sprites/concepts/lifecycle); [OpenAPI 0.1.12](https://api.sprites.dev/openapi.json) |
| 100 GB ext4 disk, billed on bytes written; durable copy in object storage, NVMe cache | Lifecycle; [SBD post](https://fly.io/blog/sprites-block-device/), 2026-10-22 |
| Checkpoints: copy-on-write snapshots of the filesystem overlay (not memory); last 5 mounted read-only; automatic ones too. Docs disagree on timing ("~1 second" vs "10–30 seconds") | [Checkpoints](https://docs.fly.io/sprites/concepts/checkpoints); [Working with Sprites](https://docs.fly.io/sprites/working-with-sprites) |
| No container images: every Sprite starts from Fly's base image (Ubuntu 26.04 for new Sprites; one docs page still says 25.10) with Claude Code, Codex, Gemini, Node, Python etc. preinstalled | Design post; [Maintenance](https://docs.fly.io/sprites/sprite-maintenance) |
| Create API takes only `name` and `url_settings`: no image, size, region, or from-checkpoint | OpenAPI 0.1.12 |
| Fork/clone: announced as enabled by SBD ("create a template Sprite, and then efficiently clone millions of times", 2026-07-24, as a beta sign-up). An admin-console fork (~90 s) appeared in release notes 2026-04-02/16. Support, 2026-05-19: "there isn't a forking functionality in general that is available". No fork endpoint in the public API as of 2026-11-06. | [Turn And Face The Strange](https://fly.io/blog/kurt-scott-money-sprites/); [release notes](https://fly.io/sprites/release-notes/); [forum](https://community.fly.io/t/sprites-forking-functionality/27838) |
| URL: `https://<name>-<org-id>.sprites.app`, HTTPS only, one HTTP port. Private by default (org members, or `Authorization: Bearer <org token>`); can be made public | [Networking](https://docs.fly.io/sprites/concepts/networking); [CLI reference](https://docs.fly.io/sprites/cli/commands) |
| Egress **network policy**: DNS-based allow/deny list per domain, raw IPs blocked unless resolved from an allowed domain, private IPs always blocked, read-only from inside, reloads live | Networking |
| **Connectors**: credential stored in Fly's org database, deny-by-default policy (name prefix / labels / allow-all, endpoint allow/block lists); the Sprite calls `https://api.sprites.dev/v1/gateway/<provider>/<connection_id>/<path>` and Fly adds the credential (header, custom header, query param, or URL path, e.g. `/bot{token}`) | [Connectors](https://docs.fly.io/sprites/concepts/connectors); OpenAPI `custom_api` |
| No built-in scheduled wake. "Scheduled jobs landing soon with Sprites 2.0" | [Fly MCP post](https://fly.io/blog/feng-shui-for-robots/), 2026-10-23; [forum](https://community.fly.io/t/sprite-cron-scheduled-wakeup/26829) |
| Pricing: CPU $0.0385/CPU-hour (measured by `cpu.stat`), memory $0.021875/GB-hour (actual use), hot storage $0.000683/GB-hour, cold $0.000027/GB-hour; no per-Sprite charge; bandwidth not metered. Hero plan $100/mo includes 1,200 CPU-h, 4,800 RAM GB-h, 150 GB, 100 running + 100 warm Sprites. $30 trial credit per new org. | [fly.io/sprites](https://fly.io/sprites), read 2026-11-06 |
| APIs: REST (OpenAPI 0.1.12), JS SDK `@fly/sprites` 0.2.4 (npm, modified 2026-10-20), Go, Python, Elixir; usage API per Sprite; service logs API | OpenAPI; npm |
| Fly itself: "when you start to care more about availability to users than you do about the environment being perfect for your dev agent, it's often a sign to migrate it to good ol' Fly Machines" | [Fly MCP post](https://fly.io/blog/feng-shui-for-robots/), 2026-10-23 |

Couldn't verify: how long a Sprite stays warm before going cold; whether the 100-warm limit on Hero forces older
Sprites cold (my inference from the limit, not documented); which region a Sprite lands in and whether it moves;
whether the Connector gateway streams SSE and WebSockets and what it does with an incoming `Authorization` header;
whether the per-service `public_url` field in the API spec ("Compute-provider sprites only") means more than one
public port; and the plan limits below Hero.

## Comparison

### Persistence and durability

- **Disk.** E2B keeps the paused sandbox's filesystem indefinitely ("no time-to-live and no automatic deletion",
  [E2B docs](https://docs.e2b.dev/sandbox/persistence), read 2026-11-06). Dream has 14 GB with 11 GB free. Sprites
  give 100 GB on object storage, which outlives a failed host by design. That's a real architectural strength for
  week-long projects. E2B's docs don't describe what backs a paused snapshot's durability.
- **Memory and processes.** This is E2B's strength. Its pause is a full memory snapshot, kept indefinitely, so
  the agent's detached server and any in-memory state are exactly where they were weeks later. On Sprites that holds
  only while the Sprite is *warm*. Once it goes cold, processes start fresh, and only processes registered as
  services come back. For Dream that means a published app that nobody has opened in a while cold-boots on the
  first request (1–2 s for the VM, then however long the app takes to start; a Next.js build/start can take
  10 s or more). The agent would have to register every server as a service, not just start it detached.
- **Checkpoints.** Sprites have them; Dream on E2B has none (it relies on files plus git where the agent uses it).
  Checkpoints would be a genuine safety net for unattended agents ("checkpoint before risky step"). But they don't
  capture memory, and the forum has reports of a restore making a Sprite vanish (2026-04-15) and of Sprites coming
  back empty (2026-01-30, 2026-03-17), all on the old JuiceFS storage.
- **Track record.** Fly's own write-up of the old storage: in a stress test of 400 Sprites over ~5,000 cycles, "a
  nonzero number of them permanently lost the ability to checkpoint" (SBD post, 2026-10-22). Sprites created before
  2026-10-06 need a manual migration to SBD. SBD is two weeks old in public. I found no data-loss reports for E2B,
  but I also didn't search for them as thoroughly.

### Cold start, wake on HTTP, idle and active cost

- **Wake.** E2B: ~180 ms measured from paused, with processes intact. Sprites: 100–500 ms warm with processes intact,
  1–2 s cold with processes restarted. Roughly comparable while warm; worse cold.
- **Create.** E2B: 1.4 s from Dream's template, with everything installed and dreamd already running. Sprites:
  "a second or two" for an empty Sprite, but with no image or public fork, Dream's stack would have to be installed
  on every create. Node 24 is pinned, Playwright's system dependencies and Chromium, ~800 MB of harness bootstrap,
  dreamd. Using a release tarball from R2 plus apt, that's an estimated 1–3 minutes (not measured).
- **Idle cost.** Zero compute on both. E2B storage is free (20 GiB included per sandbox on Pro). On Sprites, cold
  storage of 10 GB is about $0.20 a month.
- **Active cost.** E2B bills *allocated* resources while running ([billing docs](https://docs.e2b.dev/billing):
  "based on allocated resources, not actual usage"): 4 × $0.000014/vCPU-s + 8 × $0.0000045/GiB-s = **$0.33 per
  sandbox-hour**, whatever the agent is doing. Sprites bill what's actually used. An agent turn mostly waits on the
  model, so assuming 0.5 CPU and 3 GB on average it's about **$0.085 an hour**, and an idle-ish app at 0.1 CPU and
  0.5 GB is about $0.015 an hour. Memory dominates on Sprites (Fly's FAQ says the same), so the 3 GB assumption
  matters most.

At Dream's scale, take 12 projects (four people with three each). Each has 2 h of agent time and 1 h of app wake time a day, so
1,080 running hours a month:

| | E2B | Sprites |
| --- | --- | --- |
| Compute | 1,080 h × $0.33 ≈ $358 | 720 h × $0.085 + 360 h × $0.015 ≈ $67 |
| Storage | free | ≈ $10 (10 GB per project, hot while running, cold otherwise) |
| Plan | Hobby $0 (1 h cap) or Pro $150 | pay-as-you-go, or Hero $100 (which would cover this usage) |
| **Total / month** | **≈ $358 (Hobby) – $508 (Pro)** | **≈ $77 – $110** |

If each project's app had to stay running around the clock (not paused), at 0.05 CPU and 1 GB for app + dreamd:
E2B 12 × 730 h × $0.33 ≈ **$2,900/mo**; Sprites 12 × 730 h × $0.024 ≈ **$210/mo**. Fly Machines would be cheaper
again for a small always-on app (I couldn't read Fly's Machines price table: the page rendered without it). These
numbers are estimates from list prices and my usage assumptions, not measurements.

### Long-running limits

- **Run time.** E2B caps continuous running at 1 h (Hobby) or 24 h (Pro). Dream already works around it by pausing
  and resuming before the cap, which freezes a turn for a second or two and drops its open connections, including
  the harness's streaming model call. Sprites have no cap: a task held by heartbeat keeps the Sprite active for as
  long as it's renewed ("No time limits", design post). This is the cleanest win for Sprites. On Dream's side it
  would retire `stayAwake`'s cycling, and dreamd would hold a task while a turn runs.
- **Background processes.** E2B: anything detached runs while the sandbox runs and is frozen, not killed, while
  paused. Sprites: the same while warm, but a cold wake keeps only services, as above.
- **Cron.** Neither runs anything while asleep. Dream's DO alarms already do scheduled wakes, and they'd work the same
  way with Sprites (wake by HTTP or exec). Sprites say "scheduled jobs" are coming (2026-10-23, no date).
- **WebSockets.** Both pass them through. Both drop open connections on pause, so a websocket-heavy app has to be
  held awake on either. That costs $0.33/h on E2B, against cents an hour on Sprites.

### Credential safety (the deciding difference)

E2B's `network.rules` are **transparent**: the agent, the harness CLIs and the apps it writes call the real host
(`api.anthropic.com`, `chatgpt.com`, `gmail.googleapis.com`, `api.stripe.com`) with a placeholder, and E2B's proxy
swaps in the real header. Real values never enter the VM (verified 2026-11-04). The agent's code is ordinary code
that would run anywhere with a real key, which keeps the "clean seam" Dream wants between product code and sandbox
scaffolding.

Sprites have two separate mechanisms, and neither does that:

- **Network policy** is a DNS allow/deny list. It decides where traffic may go and transforms nothing.
- **Connectors** hold the credential and add it, but only for requests sent to
  `api.sprites.dev/v1/gateway/<provider>/<id>/<path>`. Dream would have to:
  - point Claude Code at the gateway with `ANTHROPIC_BASE_URL`, which it honors (verified for `settings.json` on
    2026-11-05). Unverified: whether the gateway replaces the `Authorization` header Claude Code sends with its
    placeholder, and whether SSE streaming passes through cleanly.
  - point Codex's ChatGPT backend at the gateway through the bridge's model provider config. This is unverified,
    and Codex 0.166 already broke on provider mismatches. Dream would also have to push ChatGPT's hourly-rotating
    access tokens into the connector on every refresh (`PUT /v1/oauth/connections/custom_api/{id}` exists).
  - create one connector per person per host (each Google API host, each pasted key), with a policy keyed by Sprite
    name prefix or label, so one person's projects can't use another's credentials.
  - change the `dream access` contract the agent builds against: its code would call the gateway URL, not the real
    API. Every app built that way is tied to Fly's gateway, and it breaks if the app is ever moved elsewhere.
  - give Fly the users' credentials, including Claude subscription tokens. That adds a third party holding tokens
    Anthropic's terms are already strict about (see the ToS notes in `verified-facts.md`).

Connectors do some things E2B can't: per-endpoint allow/block lists, and putting a credential in the URL path
(`/bot{token}`), which would cover the Telegram-bot case Dream now handles with a key file.

**If Dream wanted E2B-equivalent transparency on Sprites, it would build an egress proxy.** That means a MITM
HTTPS proxy (Infisical Agent Vault, already the documented fallback, or a small custom one) on Fly Machines outside
the Sprites:
- a per-Sprite proxy credential
- a Dream CA trusted inside (`NODE_EXTRA_CA_CERTS`, and whatever Codex's Rust TLS stack honors, unverified)
- rules pushed from the Worker
- each Sprite's network policy narrowed to the proxy's hostname only, so it can't be bypassed. Sprites block raw IPs
  not resolved from allowed domains, which makes that enforceable.

Estimated cost: 1–2 always-on Machines (on the order of $5–30 a month, unverified) and 1–2 weeks of work. The proxy
then sits in the path of every model token stream and every package install, so its outage is every agent's outage.
That component is exactly what E2B provides today.

### Networking

- **Public URLs and TLS.** Both give HTTPS. Dream's gateway already owns custom domains and TLS (`*.omer.build`), so
  neither provider's custom-domain support matters.
- **Gateway in front.** On E2B the port URL is closed to everyone without the traffic token, so Dream's gateway is
  the only way in, and unpublishing is a gateway change. On Sprites, a private URL needs
  `Authorization: Bearer <org token>`. That would be a full-power Fly token in every proxied request, and it
  collides with the app's own `Authorization` header (unverified whether there's an alternative). In practice Dream
  would make each URL public under an unguessable Sprite name. The `sprites.app` URL then becomes a second public
  way into the app, around the gateway.
- **dreamd's port.** A Sprite URL routes to one HTTP port. dreamd and the app can't each have one, so delivery would
  move to the Sprites exec API (a Worker POSTs to `/v1/sprites/{name}/exec`, which runs a small client against
  dreamd's socket), or dreamd would have to sit in front of the app as a reverse proxy. Either way it's a transport
  change.

### Resources and isolation

- **Sizing.** E2B: Dream chose 4 vCPU / 8 GB at template build. E2B templates are configurable; the per-plan
  maximum wasn't checked. Sprites: 8 vCPU and autoscaling memory, so builds plus browsers plus the app are less likely
  to OOM. Fly says not to design against a fixed figure. Before switching vendors, check whether a larger E2B
  template (say 8 vCPU / 16 GB) solves any OOM problem; it would double E2B's per-hour price.
- **Isolation.** Both are hardware-virtualised microVMs per sandbox, so they're equivalent for tenant isolation.
  Sprites add a privileges policy (capability profiles, `noNewPrivileges`).

### Operations

- **APIs.** E2B: REST plus mature SDKs (`e2b` 2.63.0), templates with tags, envd for processes and files. Dream
  speaks the REST API and envd directly from the Worker. Sprites: REST at OpenAPI version 0.1.12, JS SDK 0.2.4, plus
  exec, filesystem, services, checkpoints, policies, and a usage API per Sprite, which could feed `usage_events`
  directly. Sprites' API is younger, but it covers what Dream needs except images and fork.
- **Observability.** Sprites offer service logs per service and usage per Sprite. Dream's own logs (`dreamd.log`)
  work the same on both.
- **Regions.** I couldn't verify E2B's regions. Sprites run in many Fly regions (incidents name SIN, SYD, DFW, LHR,
  IAD, FRA, ORD, SJC, AMS), but the create API has no region parameter.

### Vendor risk

- **E2B.** Founded 2023, $21M Series A in July 2025 (Insight Partners; [Built In SF](https://www.builtinsf.com/articles/e2b-raises-21m-series-a-20250730)).
  Customers include Perplexity, Hugging Face, Groq and Manus. Sandboxes for agents are its single product. Dream's
  E2B dependencies (pause/resume, network rules, templates with tags) were all verified live, 2026-11-04/05.
- **Sprites.** Launched 2026-01-09 ([Code And Let Live](https://fly.io/blog/code-and-let-live/)), built by "a tiny
  skeleton crew". Relaunched 2026-07-24 as the company's focus, with a new raise and a CEO change: Kurt Mackey to
  Scott Johnston ([Turn And Face The Strange](https://fly.io/blog/kurt-scott-money-sprites/)). The storage layer was
  rebuilt (SBD, 2026-10-22).
- **Sprites incidents.** [Fly's Infra Log](https://fly.io/infra-log/) lists, among others:
  - 2026-08-30: deletions blocked for about 1 h
  - 2026-09-02: partial API outage from SQLite evictions
  - 2026-09-19: creates failing across six regions
  - 2026-09-23: API unreliable for 7 h 43 min
  - 2026-10-08: creates failing (oversized base image)
  - 2026-10-12: all `*.sprites.app` URLs down for about 75 min (expired certificate, with no alerting on Sprite URLs)
- **User reports** of Sprites coming back empty or rolled back: 2026-01-30, 2026-03-17, 2026-04-15, all on the old
  storage ([1](https://community.fly.io/t/user-error-sprite-lose-checkpoint-or-data-loss/27003),
  [2](https://community.fly.io/t/sprite-reset-to-a-new-empty-instance-can-fly-restore-original-storage-checkpoints/27377),
  [3](https://community.fly.io/t/checkpoint-restore-causes-sprite-to-vanish/27597)).
- **Signs the product is still moving fast:** the public release notes stop at 2026-04-30, and the docs contradict
  themselves (OS version, checkpoint time). A company committing its whole future to Sprites lowers the risk that
  they'll be abandoned, but not the churn.

## Migration: what would change

| Area | Change | Estimate |
| --- | --- | --- |
| `apps/api/src/e2b/E2B.ts`, `Envd.ts` | A `Sprites` service: create/get/delete, exec, fs write, network policy, services, URL settings | 2–3 days |
| `SandboxManager.ts` lifecycle | Drop timeouts, the run-cap cycling and `rulesDirty`-on-resume. dreamd holds a Sprites task during a turn, and the 5-min idle tail becomes ~30 s, so the post-turn page check and refresh need a task too. | 2–3 days |
| `Daemon.ts` transport | `DaemonRpcs` over exec (or dreamd as the HTTP front), since there's only one public port | 2–4 days |
| `packages/sandbox-template`, `Refresh.ts` | No image: a release tarball in R2 plus an apt/Playwright bootstrap on create (minutes per project). Refresh gets simpler (no donor; download and the same `refresh.sh` swap). `template:build`'s harness check runs in a scratch Sprite. Fly's base image moves under Dream (Node, preinstalled CLIs). | 3–5 days |
| `SandboxCredentials`, `ModelEgress`, connect flows | Connectors per person and host plus harness base-URL rewiring, *or* a Dream egress proxy on Fly Machines; re-verify Claude Code and Codex end to end | 1–3 weeks |
| `KeyFiles` | fs write API (easy); some keys could become URL-path connectors | 1 day |
| Gateway | Target `*.sprites.app`, public-URL decision | 1 day |
| `docs/prompts/system/`, `docs/prompts/skill/` | Machine size, `Host` header, "start servers detached" becomes "register a service", `dream access` placeholders become gateway URLs | 1–2 days |
| Scripts, tests, QA (`smoke`, `qa`, `harness-check`, `refresh-check`) | Rewrite against Sprites | 3–5 days |
| Existing projects | Copy project, `~/.dream`, `~/.claude`, `~/.codex` across; servers restart | 1–2 days |

**Total: about 4–7 weeks**, dominated by credentials and by re-verifying what's already verified on E2B.

## Hybrid designs

1. **Develop on E2B, host graduated apps on Fly Machines.** The agent keeps building in E2B. When a project needs to
   stay up (a bot, a websocket app, background jobs, or simply "it must not be frozen"), the agent containerises it
   and Dream deploys it as a Fly Machine. The Machine stops on idle or stays always-on, and the gateway retargets.
   - **Pros:** the hosted app no longer shares 8 GB with the agent and is never touched by a refresh or OOM, cheap
     always-on hosting, and it's the path Fly itself recommends.
   - **Cons:** it breaks "the code lives only in the sandbox". It needs a deploy pipeline and per-project Fly apps.
     The hosted app needs its own credentials, so it's outside E2B's injection; Fly secrets are env vars in the
     Machine. Logs and errors have to be shipped back so the agent keeps watching.
   - **Cost:** about 2–3 weeks of work. **This is the best answer to "keep the server running" if that becomes a
     requirement.**
2. **Develop on E2B, host on Sprites.** It's the same shape as (1) with no Dockerfile, and holding the app awake with
   a task costs cents an hour. But Sprites' sleep semantics, single URL port and maturity carry over, and Fly itself
   points availability-sensitive apps at Machines. It's weaker than (1).
3. **Everything on Sprites plus Dream's own egress proxy.** This keeps Dream's credential model, gets the no-cap,
   usage-billed, bigger machine, and costs the most work (the upper end of the migration estimate). It's worth
   considering only once forking from a template is in the public API.
4. **Stay on E2B and close the gaps there.**
   - Move to Pro for the 24 h cap.
   - Have the skill tell the agent to use git and commit often, standing in for checkpoints.
   - If OOMs show up, build a larger template.
   - Keep using DO alarms for anything periodic.
   This is the cheapest option and is what this recommendation amounts to for now.

## Steelman

**For Sprites.** Dream's model is long-lived computers, and Sprites are the only product built around exactly that.
They have no run cap and a 100 GB durable disk on object storage. Checkpoints make unattended agents safer. Billing
on actual usage makes always-on or near-always-on apps affordable, where E2B's allocation billing makes them
prohibitive. And a company has now bet everything on this product, with credential brokering, forking and
scheduled jobs on the roadmap. On this view, Dream's E2B workarounds (cap cycling, keepalives, the donor-based
refresh, pausing apps between visits) are the cost of using a sandbox for a computer's job.

**For E2B.** Dream's current design was verified end to end on E2B in the last three days. Its security property
depends on transparent egress injection, which Sprites don't offer. Its fast creation and its refresh
discipline (template, harness check, `default` tag, rollback) depend on images, which Sprites don't let customers
build. E2B's pause keeps memory forever, so a published app comes back exactly as it was. Sprites keep memory only
for an undocumented warm window. At friends-and-family scale the cost difference is a few hundred dollars a month.
Sprites' storage is two weeks into its second design, after a year of data-loss reports and frequent incidents. On
this view, migrating now trades a working system for a promising one, at 4–7 weeks of work, and gives up the
property Dream cares most about.

The E2B case wins today, because the things Sprites lacks (transparent injection, images and fork, durable memory)
are load-bearing for Dream, and the things Sprites does better (no cap, cost, size) either have workarounds already
in place or don't matter yet at this scale.

## Conditions that would change the recommendation

- **Sprites ships a public fork or create-from-checkpoint API** that Dream can drive from a template Sprite it builds.
  That brings creation and refresh back to parity.
- **Sprites ship transparent per-host egress header injection,** or Dream decides for other reasons to build its own
  egress proxy (for example, for signed APIs neither provider handles). Credential safety then stops being the
  deciding difference.
- **SBD runs clean for about three months:** no data-loss reports on the forum and fewer Infra Log entries. Fly's
  warm-to-cold timing gets documented or becomes configurable.
- **Sandbox spend becomes material:** dozens of active projects, or always-on apps becoming a product requirement.
  Then Sprites' usage billing, or hybrid (1) for hosting, pays for the work. At about $300 a month of difference, it
  doesn't yet.
- **E2B gets worse:** a price rise, pause/resume or network-rule regressions, or rules that stop being updatable.
- **Memory pressure** (OOM kills of the user's app) becomes common and a bigger E2B template doesn't fix it.

## Trying Sprites for real (cheaply)

Nothing here was run, because there's no Fly.io access in this workspace. A real test would take:
- The founder creates a Fly.io organization. New orgs get a $30 trial credit; whether a card is required wasn't
  checked.
- They add a workspace connection for `api.sprites.dev` (`Authorization: Bearer`).

Then about half a day for a script (reusing `packages/dreamd/scripts/fake-anthropic.ts`, so no real model token is
needed) to measure:
- create time, and how long Dream's stack takes to install from an R2 tarball plus apt
- wake-on-HTTP latency, warm and cold, with the app registered as a service
- warm-to-cold timing (poll `last_warming_at` and process survival every hour for 2–3 days)
- a task heartbeat held for more than 25 h
- Claude Code through a `custom_api` connector via `ANTHROPIC_BASE_URL`: header replacement and SSE streaming
- the network policy blocking a non-allowed host
- memory autoscaling under the OOM probe used in `verified-facts.md`

This should use well under $5 of the trial credit.
