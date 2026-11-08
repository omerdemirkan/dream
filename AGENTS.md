# Dream

Dream is an iPhone app where a person describes an idea and an agent builds it, over hours to weeks, in its own E2B
sandbox. Read `docs/PLAN.md` first (architecture, data, flows), then `docs/prompts/README.md`
(what the agent in the sandbox is told, section by section), `docs/research/verified-facts.md` (versions and decisions), and
`mocks/deck-v3.html` (the locked UI).

Three workstreams build on this foundation in parallel: the control plane (`apps/api`, `infra`), the sandbox
runtime (`packages/dreamd`, `packages/sandbox-template`), and the mobile app (`apps/mobile`). They meet only at the
contracts in `packages/domain`. If those stay the single source of truth, the pieces fit when they are put together.

## Layout

| Path | What | Owner |
| --- | --- | --- |
| `packages/domain` | Effect Schemas and RPC contracts for every shape that crosses a boundary | shared |
| `packages/agent-context` | The agent's system prompt, Dream's skills, the task prompt, the turn-prompt renderer | shared |
| `apps/api` | Cloudflare Worker: RPC + HTTP routes, ProjectDO, gateway, APNs, crons (alchemy v2) | control plane |
| `infra/alchemy.run.ts` | The Stack: zone, DNS, the Worker and everything it binds | control plane |
| `packages/dreamd` | Sandbox daemon (event loop, harness turns) and the `dream` CLI (Node 24) | sandbox runtime |
| `packages/sandbox-template` | E2B template build | sandbox runtime |
| `apps/mobile` | Expo SDK 58 iPhone app, its Live Activity widget, and `scripts/build-ios.sh` (see its README) | mobile |

Workspace packages export their TypeScript source (`"exports": { ".": "./src/index.ts" }`); there is no build step.
Bundlers (alchemy's rolldown, Metro, Vitest) and Node 24's type stripping consume `.ts` directly.

## Commands

Bun 1.4 is the package manager (`curl -fsSL https://bun.sh/install | bash` if `bun` is missing).

```sh
bun install
bun run check          # format check + typecheck every package + all tests; run before every commit
bun run typecheck      # tsc (TypeScript 7) in each package
bun run test           # vitest, all projects (see vitest.config.ts)
bun run format         # biome, TS and JSON only
bun run sync-prompts   # rebuild the agent's prompts and their map after editing a section in docs/prompts/
bun run infra:plan     # alchemy plan; needs Cloudflare credentials and DREAM_DOMAIN in .env
bun run template:build # build the dream-sandbox E2B template at both sizes (~4 min), check a turn on each harness, make them current
```

Run alchemy from the workspace root (the `infra:*` scripts do), because relative paths in resource props, such as D1
migrations, resolve from there. Anchor Worker entries with `main: import.meta.url`.

Installs are isolated: a package can import only what its own `package.json` declares. Versions are pinned exactly
(`bun add --exact`). All `effect` and `@effect/*` packages stay on the same version (4.1.2). Don't upgrade
anything in passing.

## Effect v4

Everything is Effect 4.1: the Worker and DO, dreamd and the CLI, and the app's data layer. v4 differs a lot from v3,
and from older v4 betas, so check before writing code:

- Read the installed types under `node_modules/.bun/effect@4.1.2/node_modules/effect/src` (they ship as source), and
  `LLMS.md`, `ai-docs/` and `migration/` in github.com/Effect-TS/effect. The effect-smol repo is stale.
- Module paths have no `unstable/` segment: `effect/rpc`, `effect/http`, `effect/http-api`, `effect/cli`,
  `effect/sql`, `effect/socket`.
- Recent renames: `Schema.TaggedError` (not `TaggedErrorClass`); `Config.String`, `Config.Redacted`, `Config.Port`
  (capitalized); `Schema.Literals([...])`, `Schema.Union([...])`; `Effect.catch` (not `catchAll`).

What keeps the codebase coherent:

- **Services** are `class X extends Context.Service<X, Shape>()("@dream/<package>/X") {}` with a `static readonly layer`
  built by `Layer.effect`. Name variants `layerTest`, `layerConfig`. Methods are `Effect.fn("X.method")(function*…)`.
  Code depends on the service tag, and the layers decide what backs it (real, test, local).
- **Errors are typed.** Failures that cross a boundary are `Schema.TaggedError` classes in `packages/domain/src/Errors.ts`;
  internal ones can be `Schema.TaggedError` or `Data.TaggedError` next to their service. Don't throw, and don't
  return `null` for failure. A defect (`Effect.die`) means a bug.
- **Schema at every boundary.** Decode anything you didn't construct: RPC payloads (automatic), HTTP bodies, env
  (`Config`), SQL rows, harness and Browserbase events, webhook payloads, files. No `as` casts or hand-written
  `JSON.parse` on external data.
- **No raw Promise plumbing in app code.** Wrap a Promise-based SDK once, inside its service, with `Effect.tryPromise`
  mapped to a typed error, and expose Effects. `async`/`await` belongs only at framework edges that demand it
  (React components should use atoms instead).
- `DateTime` instead of `Date`; `Redacted` for secrets (never log or template them); `Duration` for time spans.
- Tests use `@effect/vitest` (`it.effect`, `layer(...)`), fakes as layers, and `TestClock` for time.

## Shared types: `packages/domain`

Any shape that crosses a boundary (phone ↔ Worker, Worker ↔ ProjectDO ↔ dreamd, CLI ↔ dreamd, Worker → APNs → app,
Swift widget) is defined once here and imported everywhere. Don't redeclare one locally, even "temporarily". Storage
shapes (D1/DO rows, dreamd's queue on disk) belong to the package that owns the storage, which maps them to domain
types at its edge.

| File | Contents |
| --- | --- |
| `Ids.ts` | Branded ids and the prefixes the API generates (`prj_…`, `msg_…`) |
| `User.ts`, `Project.ts` | User, Device, Project (phase, headline, harness, public URL), AgentActivity (starting/working/idle, next wake), ProjectSummary |
| `Message.ts` | Chat messages: `Text`, `Question` (state Open/Answered/Withdrawn), `Access` (Google/Key/Apple; Open/Connected/Declined) |
| `Status.ts` | Status card: now, justDid, next, media, milestones with pinned needs |
| `AgentEvent.ts` | Events that wake the agent, and `renderAgentEvent` for the turn prompt |
| `Connections.ts`, `Usage.ts` | Model connections and connect flows, integrations, usage windows |
| `LiveActivity.ts`, `Push.ts` | ActivityKit attributes and content state; APNs custom data |
| `Wake.ts`, `Machines.ts`, `Media.ts` | Scheduled wakes; Browserbase and Mac sessions; media refs and uploads |
| `Relay.ts` | Relays (lines Dream holds open for a sleeping sandbox): sources, targets, state, the delivery body and its signature headers, limits |
| `Auth.ts`, `Errors.ts` | Caller identity, auth middlewares, boundary errors |
| `Transport.ts` | Routes, serialization per transport, dreamd's env (`DaemonEnv`, `DaemonConfig`) |
| `rpc/*.ts` | The four RPC groups (below) |
| `fixtures.ts` | The Deck v3 sample content as domain values (`@dream/domain/fixtures`), for tests and UI work |

Schema style, so every shape reads the same:

- `export const X = Schema.Struct({...})` with `export type X = typeof X.Type` (same name).
- Unions are `Schema.TaggedUnion` with PascalCase `_tag`s. Use `X.cases.Case.make(...)`, `X.match`, `X.guards`.
  Plain enums are lowercase `Schema.Literals`.
- Absent means absent: optional fields are `Schema.optionalKey` (the key is missing; never `null`, no `Option` in
  domain types). The one exception is patch payloads (`UpdateStatus`), where absent means "leave it" and `null`
  means "clear it".
- Timestamps are `Schema.DateTimeUtc` (ISO strings on the wire). Secrets in payloads are
  `Schema.RedactedFromValue(Schema.String)`.
- `src/` is platform-agnostic, because the same code runs on React Native, workerd and Node. `tsconfig.src.json`
  compiles it with no platform globals; tests may use Node's.

A contract change touches every side, and the phone on someone's lock screen may be a TestFlight build behind. So
prefer additive changes (new optional fields, new RPCs, new union cases that old clients can ignore), make them in
`packages/domain` on your branch with tests, and say so in the commit message. Renaming or removing a field needs
the other workstreams to agree first.

## RPC groups and transports

| Group | Caller → server | Transport | Auth |
| --- | --- | --- | --- |
| `AppRpcs` = `PublicAppRpcs` + `AuthedAppRpcs` | phone → Worker | HTTP POST `api.<domain>/rpc`, NDJSON | `AppAuth`: session JWT |
| `ProjectLiveRpcs` | phone → ProjectDO | WebSocket `api.<domain>/projects/:id/live?ticket=…`, JSON | ticket from `GetLiveUrl`, checked by the Worker |
| `SandboxRpcs` | dreamd → Worker (and CLI → dreamd) | HTTP POST `api.<domain>/sandbox/rpc`, NDJSON; CLI over the `DREAM_SOCKET` Unix socket | `SandboxAuth`: project token |
| `DaemonRpcs` | ProjectDO → dreamd | HTTP POST `<port>-<sandbox>.e2b.app/daemon/rpc` with `e2b-traffic-access-token`, NDJSON | `DaemonAuth`: per-sandbox token |

- `ProjectLiveRpcs.Subscribe` streams `ProjectEvent`s. The first event is always a `Snapshot`, and on reconnect the
  phone subscribes again and replaces its state. Alchemy's `Cloudflare.RpcDurableObject` and
  `RpcWebSocketClient.layer` implement this transport (hibernatable WebSockets). Don't expose internal DO methods on
  the same socket.
- Every auth middleware is `requiredForClient`, so a client won't build until it provides
  `RpcMiddleware.layerClient(Middleware, ...)` to attach `authorization: Bearer <token>`. `packages/domain/test/rpc.test.ts`
  shows server and client sides end to end.
- Sandboxes are created with E2B `network` rules, so every port URL needs the `e2b-traffic-access-token` header. The
  ProjectDO and the gateway add it; nothing else has it. dreamd serves only `DaemonRpcs` on its port, behind
  `DaemonAuth` as well, because apps in the sandbox can reach it on localhost and must not be able to forge the
  person's messages. The CLI uses the Unix socket.

### Adding an RPC

1. Define any new shapes in the right domain module, following the schema style above.
2. Add `Rpc.make("VerbNoun", { payload, success, error })` to the right group in `packages/domain/src/rpc/`, with a
   doc comment saying what it's for (for `SandboxRpcs`, the `dream` command and flags it backs). Errors come from
   `Errors.ts`, and middleware comes from the group.
3. Add a codec or RPC test in `packages/domain/test` if the shape is new or tricky.
4. Implement the handler where the group is served (`Group.toLayer({...})` or `toLayerHandler`), and call it from the
   client with `RpcClient.make(Group)`. Typecheck fails until every handler exists.
5. For a `dream` command, give it and each flag a description that stands on its own in `dream <command> --help`,
   which is where the agent looks up flags. If the agent should know when and why to use it, update its section in
   the skill under `docs/prompts/skills/` (the skills say when and why, `--help` says how) and run
   `bun run sync-prompts`.

## Workstream notes

- **Control plane.** `apps/api/src/Api.ts` is the Worker: `api.<domain>` as a custom domain, `*.<domain>/*` as a zone
  route (the gateway for published apps), both from `DREAM_DOMAIN`. It binds `ProjectDO`, `RelayDO`, D1 (`Database`,
  migrations in `apps/api/migrations`) and R2 (`Media`) from `Resources.ts`. A `RelayDO` (one per relay, `src/relay/`)
  holds a line open for a project while its sandbox sleeps (Discord's Gateway, a WebSocket feed) and hands each
  event to the ProjectDO, which gives it to dreamd (`DaemonRpcs.ForwardRelay`); the two DO classes call each other
  through the Worker's env (`lib/StubFetch.ts`), over `RelayRpcs` and the `Relay*` calls in `ProjectRpcs`. User credentials (Claude and ChatGPT tokens,
  Google OAuth tokens, pasted keys, App Store Connect keys) are stored AES-GCM encrypted in a D1 `secrets` table and
  decrypted only inside the Worker. The key and the operator keys (E2B, Browserbase, Namespace, APNs, Google client
  secret) are Worker secrets. Rows reference a secret id, and domain records never carry one. It is deployed at
  https://dream.omer.build (see Deploying below); R2 media storage is on (`DREAM_R2_ENABLED=true`).
  Dream's AI gateway (`apps/api/src/openai/`, docs/metering.md) serves OpenAI's API at `openai.<domain>/v1` to the
  apps the agent builds, on Dream's `OPENAI_API_KEY`, metered per project (`model_request`), behind
  `DREAM_AI_GATEWAY_ENABLED`; sandboxes reach it with a placeholder key and a per-project credential egress adds,
  and WebRTC calls are metered by a sideband (`OpenAICallDO`). `apps/api/scripts/gateway-smoke.ts` makes real calls
  through it; `packages/sandbox-template/scripts/gateway-check.ts` checks it from a sandbox on each harness.
  A rented Mac counts as in use only while something the agent runs is at work on it: the ProjectDO probes it every
  five minutes through Namespace's command service (`brokers/MacProbe.ts`), stops it after 15 minutes without use (an
  hour while something the agent left runs quietly) or soon after a turn ends with nothing running, and logs each Mac's life to D1 `mac_activity`
  (GET `/admin/macs/activity`; see `apps/api/README.md`).
  `@cloudflare/vitest-pool-workers` needs Vitest 4 and `@effect/vitest` 4.1.2 needs Vitest 5, so test Worker logic
  in Node against layers and fakes.
- **Sandbox runtime.** dreamd reads `DaemonConfig` (env set by the ProjectDO at sandbox creation). The `dream` CLI maps
  one-to-one onto `SandboxRpcs`. Turn prompts come from `renderTurnPrompt` in `@dream/agent-context`, and the system
  prompt, the skills and the task prompt are exported there as strings, joined from the sections in `docs/prompts/` (its
  README maps them, and says where else the agent's text comes from). The bins run directly under Node 24 type stripping, which is why
  `erasableSyntaxOnly` is on (no enums, namespaces or parameter properties).
  The top-level agent's model and effort come from `src/harness/Fleet.ts` (each provider's flagship, effort high;
  the agent picks each subagent's model and effort itself), unless the operator overrides them for a QA run
  (`DREAM_AGENT_MODEL`, `DREAM_CODEX_AGENT_MODEL`, `DREAM_AGENT_EFFORT` Worker secrets).
  A changed prompt or skill reaches a running project on its next turn (`src/harness/Session.ts`): Claude Code's
  session goes on with the new prompt (its bridge is patched to render it on every request) and a note; Codex gets
  a new thread with a handoff, since a thread keeps its instructions. `scripts/prompt-refresh-check.ts` checks both.
  E2B pauses a sandbox when its timeout runs out, whatever runs in it: a wake gets five minutes, and the end of a
  turn 90 seconds (`TurnTail` in `SandboxManager.ts`; it resumes in under a second). So between turns dreamd asks
  the ProjectDO to keep it up (`StayAwake`, about once a minute, two minutes each) while a scheduled `--run` command
  runs, a relay delivery is under way, or the published app is in use (`src/Awake.ts`); a turn's keepalive covers
  turns. The other way round, once the command, delivery or app visit it was awake for is done and nothing else needs
  the sandbox, dreamd asks for it to sleep now (`Sleep`), so a scheduled check costs seconds rather than five minutes
  and a visit about a minute and a half after its last request. A visit that resumes the sandbox but never reaches
  the app (the client gave up during the resume) leaves dreamd nothing to see, so when the gateway looks up a visit's
  target the ProjectDO pauses the sandbox two minutes later unless dreamd's `StayAwake` says it's serving it
  (`visit-check`). Machine time is the bulk of Dream's E2B bill:
  `node packages/sandbox-template/scripts/costs.ts` prints it per day and cause, and
  `node packages/sandbox-template/scripts/resource-review.ts` is the daily review of all of Dream's spend and waste
  (exits 2 when something needs action; see `docs/metering.md`). dreamd posts relay deliveries to the app on
  localhost, signed with `~/.dream/relay.key` (`src/Relays.ts`).
  A scheduled task (`dream wake --task`) runs like a `--run` command, but in a new harness session of its own, on the
  model and effort the agent picked, from its brief and `taskPrompt` (`docs/prompts/task/`; `src/Tasks.ts`). Each
  run is reported with `ReportTask` and counted in the ledger like a turn; `packages/sandbox-template/scripts/
  task-check.ts` runs one on each harness against the fakes.
  The `dream-sandbox` template's start command keeps dreamd running, and the snapshot carries it into every new
  sandbox, so the ProjectDO starts dreamd by writing `DaemonEnvFile` (rewriting it restarts dreamd). Both harness
  CLIs are pre-installed. `packages/sandbox-template/scripts/smoke.ts` checks a fresh sandbox, and with
  `packages/dreamd/scripts/fake-api.ts` and `fake-responses.ts` (exposed publicly) it runs a Codex turn there.
  `scripts/refresh-check.ts` runs a Claude Code (`fake-anthropic.ts`) or Codex project in a sandbox to check a refresh.
  Claude Code and Codex versions are Dream's, not the adapters': `src/harness/bridges/<harness>/` holds the bridge
  manifest and lockfile `dreamd bootstrap` installs. To move to new releases, run
  `node packages/dreamd/scripts/harness-pins.ts` (shows the pins and npm's latest), then `… harness-pins.ts latest`
  (or `--claude-code <agent-sdk version> --codex <version>`) and build a test template
  (`DREAM_TEMPLATE=dream-sandbox-<x> bun run template:build`), whose harness check runs a turn on each. A release can
  break its adapter (Codex 0.166.0 did; Codex stays on 0.165.0 until the adapter catches up). Rerun the pins script
  after bumping an adapter; a test fails until the manifests match the adapter's again.
- **Machine sizes.** New projects get a standard sandbox (2 vCPU, 4 GB, 2 GB of swap; template `dream-sandbox`);
  the agent can ask for a large one (4 vCPU, 8 GB; `dream-sandbox-large`, from the same build) with
  `dream machine move large "<why>"`, and back (`SandboxSize` in `packages/domain/src/Sandbox.ts`). E2B can't
  resize a sandbox, so the ProjectDO moves the project after the turn that asked (`SandboxManager.move`,
  `apps/api/src/e2b/Move.ts`): `files/move.mjs capture` notes the servers outside dreamd's tree that listen on a port,
  the old sandbox packs `/home/user` (not the harness bootstrap, caches, dreamd's env file or logs), a sandbox of the
  other size unpacks it, gets its key files and a dreamd with a new daemon token, and `move.mjs restore` starts the
  servers again; then the record switches over, the old sandbox is killed, and the agent gets `MachineMoved`. Wakes,
  relays and the published port live in the ProjectDO, so they follow the record. A failure leaves the project as it
  was. Projects made before sizes stay on 4/8 (their size reads from E2B's `cpuCount`). `apps/api/scripts/
  move-check.ts` checks a move on real E2B against the fakes (about 9 s for a small project).
- **Sandbox refresh.** A sandbox keeps the template build it was created from, so the ProjectDO brings it up to the
  template's current build between turns (`apps/api/src/e2b/Refresh.ts`): before the next delivery, 20 seconds
  after each turn (holding the sandbox up while it runs), and when the published app is visited (the gateway's
  `GatewayTarget`), since a project woken only by its app gets no delivery. It copies `/opt/dream` and `~/.ai-sdk-harness/.harness-bootstrap` over from a short-lived donor sandbox
  of the template, and the new build's `files/refresh.sh` swaps them in and restarts dreamd, rolling back if the new
  dreamd doesn't come up. The project, `~/.dream`, `~/.claude`, `~/.codex` and processes outside dreamd's tree stay.
  Builds are tagged `release-<hash of /opt/dream>`, so a rebuild of the same source refreshes nothing; system
  packages (apt, Node, Playwright, pnpm, Bun) don't refresh. Every sandbox follows the build tagged `default`, which
  `template:build` moves only after `scripts/harness-check.ts` ran a turn on each harness in the new build.
  `SANDBOX_REFRESH=false` turns refreshing off.
- **Mobile.** `apps/mobile` is an Expo SDK 58 development-build app (native modules, so not Expo Go). Metro resolves
  the domain's `.ts` imports and `exports` maps with no extra config. The services in `src/data` are plain Effect and
  tested in Node (`apps/mobile/test`); screens are checked in the iOS Simulator. `DREAM_BACKEND=fixtures` runs the
  whole app against an in-app fake of `AppRpcs`/`ProjectLiveRpcs`, and every screen state has a link or launch
  argument (see `apps/mobile/README.md`). `PushDataKey` ("dream") works as is: expo-notifications exposes the full
  APNs payload as `trigger.payload` (taps) and `data` (background task). The Swift widget and `modules/dream-native`
  both define `DreamActivityAttributes` matching `LiveActivityAttributes`/`LiveActivityContent`; keep the two copies
  identical. iOS builds: `apps/mobile/scripts/build-ios.sh` (expo prebuild + xcodebuild, Simulator or TestFlight).
  JavaScript-only changes ship over the air: stock expo-updates against the Worker's Expo Updates protocol routes
  (`apps/api/src/http/Updates.ts`), fingerprint runtime versions, updates signed by a key only the Worker holds,
  channels `production` (TestFlight), `development`, `fixtures`. See "Over-the-air updates" in its README.

## Deploying (live at https://dream.omer.build)

- Deploy only from `main` or a branch rebased on the latest `origin/main`: every deploy replaces the whole Worker, so
  deploying a stale branch silently rolls back other fixes. Run `bun run check` first.
- `bun run infra:deploy` from the workspace root. The root `.env` needs `DREAM_DOMAIN=omer.build`,
  `DREAM_R2_ENABLED=true`, `CLOUDFLARE_ACCOUNT_ID=2d98de7c4511e98d2f774c4fcc9b9b93` and `CLOUDFLARE_API_TOKEN=anything`
  (the workspace's `cloudflare-api` connection adds the real token). Without `DREAM_R2_ENABLED=true` a deploy unbinds
  media storage. D1 and R2 names are pinned in `apps/api/src/Resources.ts`, so a deploy from any machine adopts the
  live resources.
- Worker secrets set in the dashboard or through the API survive deploys; plain vars don't.
- dreamd, the CLI, the prompt and the harness CLIs ship inside the `dream-sandbox` template: `bun run template:build`
  after changing any of them. Existing sandboxes pick the new build up between turns (Sandbox refresh, above).
  To roll every sandbox back, make an older build current again:
  `bun run template:build promote <release>` (releases are the build's `release-…` tags).
- End-to-end checks against the live API: `node packages/sandbox-template/scripts/qa.ts` (see its header). End every
  QA run with `qa.ts done`, which deletes the projects the run created: a forgotten one with a frequent schedule keeps
  a sandbox up for hours a day.
- Throwaway sandboxes (checks, probes, scripts) carry `devSandboxMetadata(<script>)` from `@dream/domain`, and the
  Worker's maintenance kills any without an owner that started over an hour ago (`apps/api/src/e2b/Reaper.ts`).
  `reaper: "skip"` in a sandbox's metadata spares a long experiment.
- The iPhone app's JavaScript: `node apps/mobile/scripts/updates.ts publish` from main (rollback and status too;
  see apps/mobile/README.md). Native changes still need a TestFlight build, and `publish` says so.
