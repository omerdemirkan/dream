# Dream

Dream is an iPhone app where a person describes an idea and an agent builds it, over hours to weeks, in its own E2B
sandbox. Read `docs/PLAN.md` first (architecture, data, flows), then `docs/agent-context.md` and `docs/dream-skill.md`
(what the agent in the sandbox is told), `docs/research/verified-facts.md` (versions and decisions), and
`mocks/deck-v3.html` (the locked UI).

Three workstreams build on this foundation in parallel: the control plane (`apps/api`, `infra`), the sandbox
runtime (`packages/dreamd`, `packages/sandbox-template`), and the mobile app (`apps/mobile`). They meet only at the
contracts in `packages/domain`. If those stay the single source of truth, the pieces fit when they are put together.

## Layout

| Path | What | Owner |
| --- | --- | --- |
| `packages/domain` | Effect Schemas and RPC contracts for every shape that crosses a boundary | shared |
| `packages/agent-context` | The agent's system prompt, the `dream` skill, the turn-prompt renderer | shared |
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
bun run sync-prompts   # regenerate agent-context strings after editing docs/agent-context.md or docs/dream-skill.md
bun run infra:plan     # alchemy plan; needs Cloudflare credentials and DREAM_DOMAIN in .env
bun run template:build # build the dream-sandbox E2B template (~2 min), check a turn on each harness, make it current
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
| `User.ts`, `Project.ts` | User, Device, Project (phase, headline, harness, public URL), ProjectSummary |
| `Message.ts` | Chat messages: `Text`, `Question` (state Open/Answered/Withdrawn), `Access` (Google/Key/Apple; Open/Connected/Declined) |
| `Status.ts` | Status card: now, justDid, next, media, milestones with pinned needs |
| `AgentEvent.ts` | Events that wake the agent, and `renderAgentEvent` for the turn prompt |
| `Connections.ts`, `Usage.ts` | Model connections and connect flows, integrations, usage windows |
| `LiveActivity.ts`, `Push.ts` | ActivityKit attributes and content state; APNs custom data |
| `Wake.ts`, `Machines.ts`, `Media.ts` | Scheduled wakes; Browserbase and Mac sessions; media refs and uploads |
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
5. If the agent should know about it, update `docs/dream-skill.md` and run `bun run sync-prompts`.

## Workstream notes

- **Control plane.** `apps/api/src/Api.ts` is the Worker: `api.<domain>` as a custom domain, `*.<domain>/*` as a zone
  route (the gateway for published apps), both from `DREAM_DOMAIN`. It binds `ProjectDO`, D1 (`Database`, migrations
  in `apps/api/migrations`) and R2 (`Media`) from `Resources.ts`. User credentials (Claude and ChatGPT tokens,
  Google OAuth tokens, pasted keys, App Store Connect keys) are stored AES-GCM encrypted in a D1 `secrets` table and
  decrypted only inside the Worker. The key and the operator keys (E2B, Browserbase, Namespace, APNs, Google client
  secret) are Worker secrets. Rows reference a secret id, and domain records never carry one. It is deployed at
  https://dream.omer.build (see Deploying below); R2 media storage is on (`DREAM_R2_ENABLED=true`).
  `@cloudflare/vitest-pool-workers` needs Vitest 4 and `@effect/vitest` 4.1.2 needs Vitest 5, so test Worker logic
  in Node against layers and fakes.
- **Sandbox runtime.** dreamd reads `DaemonConfig` (env set by the ProjectDO at sandbox creation). The `dream` CLI maps
  one-to-one onto `SandboxRpcs`. Turn prompts come from `renderTurnPrompt` in `@dream/agent-context`, and the system
  prompt and skill are exported there as strings. The bins run directly under Node 24 type stripping, which is why
  `erasableSyntaxOnly` is on (no enums, namespaces or parameter properties).
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
- **Sandbox refresh.** A sandbox keeps the template build it was created from, so the ProjectDO brings it up to the
  template's current build between turns (`apps/api/src/e2b/Refresh.ts`): before the next delivery, and a minute after
  each turn. It copies `/opt/dream` and `~/.ai-sdk-harness/.harness-bootstrap` over from a short-lived donor sandbox
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
- End-to-end checks against the live API: `node packages/sandbox-template/scripts/qa.ts` (see its header).
