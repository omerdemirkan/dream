# Metering what Dream pays for

Dream pays providers to run each project: E2B for sandbox time (by far the largest), Browserbase for cloud browsers,
Namespace for Macs, OpenAI for the calls the agent's apps make through Dream's gateway, and a little R2 and email.
This document is the design for metering all of it per project, showing it in the app, and later sending it to a
usage-billing platform instead of keeping it in D1. Nothing here bills anyone or enforces a limit. Research
behind it: `docs/research/metering.md`.

This is a different thing from the person's Claude or ChatGPT usage (`packages/domain/src/Usage.ts`): that's their
own subscription, measured in a plan's percentages, and Dream doesn't pay for it. The two never share a type, a
table, a total or a row in the app.

## The ledger

Everything that costs Dream money is recorded as a **meter event**, through one service, `Meter`
(`apps/api/src/metering/Meter.ts`). Events are an append-only stream of immutable facts, the shape any usage-billing
platform takes:

| Field | Value |
| --- | --- |
| `id` | Derived from the source, so a retry or a second path records nothing new (the idempotency key) |
| `owner` | The Dream user who caused it, or `dream` (`OperatorOwner`) for checks and throwaway sandboxes |
| `meter` | `sandbox_run`, `browser_session`, `mac_session`, `openai_request`, `storage_day`, `email_sent` |
| `at` | When the cost was incurred (a run's end, a request's completion) |
| `quantities` | Raw amounts as numbers in their own units: milliseconds, tokens, bytes, characters; never Dream's prices (the one amount of money is `cost_usd`, what a provider reported charging) |
| `dimensions` | Strings to group and filter by |

Dimensions every event has when they apply: `project`, `payer` (`dream`, or `person` when their own key paid),
`provider`. Then per meter:

| `meter` | `id` | Quantities | Dimensions |
| --- | --- | --- | --- |
| `sandbox_run` | `e2b:<E2B event id>` | `ms`, `vcpus`, `memory_mb` | `sandbox`, `execution`, `template`, `cause` (`project`, `refresh`, `sign-in`, `dev`, `harness-check`), `ended` (`paused`/`killed`), `kill_reason` |
| `browser_session` | `browserbase:<session id>` | `ms`, `proxy_bytes` | `session` |
| `mac_session` | `namespace:<instance id>` | `ms`, `vcpus`, `memory_mb` | `instance` |
| `openai_request` | `openai:<OpenAI id>` (response, completion, call or session id), else `openai:<x-request-id>` | `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_tokens`, `input_audio_tokens`, `cached_audio_tokens`, `output_audio_tokens`, `input_image_tokens`, `output_image_tokens`, `characters`, `audio_ms`, `session_ms`, `web_search_calls` | `endpoint` (`responses`, `chat`, `embeddings`, `images`, `speech`, `transcription`, `realtime`, `live`), `model`, `service_tier`, `estimated` (`true` when a quantity was inferred, e.g. speech without usage) |
| `storage_day` | `r2:<project id>:<YYYY-MM-DD>` | `bytes` (stored at the end of the UTC day) | |
| `email_sent` | `email:<message id>` | `recipients` | |

Only the keys that apply are present. Provider rules such as Browserbase's one-minute minimum are pricing, so they
live in the price book, not in the quantities.

OpenAI's token counts nest the way OpenAI reports them, and the price book prices them that way: `input_tokens` is
every input token (cached, audio and image ones included), `cached_input_tokens` the cached ones of every modality,
with `cached_audio_tokens` the audio ones among them; `input_audio_tokens` and `input_image_tokens` are the audio and
image ones among `input_tokens` (cached included); `output_tokens` is every output token, with `reasoning_tokens`,
`output_audio_tokens` and `output_image_tokens` among them. A model without a separate price for a modality
(transcription) bills it at its text price. Speech estimated without usage should send `characters` for tts-1 and
tokens for the token-priced voices; the book prices whatever quantities are there.

**The sink today is D1** (`meter_events`, `MeterD1`): one row per event, the event exactly as above (quantities and
dimensions as JSON columns, `project` and `owner` also as columns for queries) plus columns that exist only for the
app: `center` (a `CostCenter`), `payer`, `cost_usd`, an estimate from the **price book**
(`apps/api/src/metering/Prices.ts`: dated list prices per provider and model, with their sources), `units` (the
amount in the center's `CostUnit`, as billed: hours, billed minutes, requests, GB-months, messages, so a line's
quantity matches its dollars) and `price_book` (the book's date). The book prices everything past what plans include
(Browserbase's 100 hours, R2's 10 GB, Email Service's 3,000 messages), so a project's estimate doesn't depend on
what the others used first. Inserts are `ON CONFLICT (id) DO NOTHING`, and rows are never updated. An OpenAI model the price book doesn't know is recorded at
0 with its tokens, and logged, so a new model shows up as tokens before it shows up as dollars.

The existing `usage_events` rows (browser and Mac minutes, older sandbox estimates) are copied into `meter_events`
by a migration (0016), and the table stops being written. The sandbox estimates from the last 7 days are left out,
because E2B still has those runs and the backfill records them exactly; older ones become `sandbox_run`s on the
4 vCPU / 8 GB size of the time, with `estimated: "true"` (they counted only turns and their tail, so they're low).

**When billing comes,** a platform becomes another layer for `Meter` that sends each event (batched and retried;
the ids make retries safe), with customers keyed by the Dream user id, meters summing the quantities grouped by
`project`, and the platform's prices replacing the price book. The code that meters doesn't change, and the D1 rows
can be replayed into it. Pricing stays out of the events, so a price change never rewrites history.

**Reported costs.** A provider that says what a request cost (OpenRouter does, per request) gives the event a
`cost_usd` quantity: a fact about the event, not Dream's pricing. The sink takes it as the event's cost, and the price
book is only the fallback for events without one (`price` in Prices.ts).

## Where each cost comes from

**E2B sandbox time: lifecycle webhooks, with a backfill.** E2B posts every lifecycle event of the team to
`https://<apiHost>/webhooks/e2b`. The Worker checks `e2b-signature` (base64 SHA-256 of secret + raw body) against
the secret it holds, answers at once, and records a `sandbox_run` for each `paused` and `killed` event: those carry
`execution` (milliseconds, vCPUs, memory), exactly one billed run each. The sandbox's metadata says whose it was:
a project's sandbox and its refresh donors belong to the project (`cause` tells them apart), a model sign-in to the
person, anything else (`devSandboxMetadata`) to `dream`. Because E2B keeps events only 7 days and a webhook can fail,
a cron pages `GET /events/sandboxes?types=…paused&types=…killed` every hour (`17 * * * *`) and records what's missing
(same ids): the last 25 hours, and at 00:17 UTC the whole week. A signed delivery always gets a 2xx (204 recorded, 202
when the body doesn't decode), so E2B never retries what it can't fix; a bad signature gets a 401. A run whose
sandbox has a project but no user in its metadata is the project owner's.

The Worker registers its own webhook: an operator route (`POST /admin/metering/e2b-webhook`, behind
`x-dream-dev-secret`) generates the signing secret, keeps it sealed in D1, and creates or updates the webhook with
the Worker's E2B key. Nobody handles the secret, and calling it again rotates it. E2B takes a few seconds to sign with
a new secret (checked live: a delivery 2 s after the PATCH still had the old one, and one 15 s after had the new), so
the Worker keeps the previous secret too and accepts either. `?backfill=7` on the same route also reads the week
E2B still has, for the first deploy. The secret is sealed with the master key in `meter_webhooks`.
`apps/api/scripts/metering-webhook-check.ts` checks all of this against the real E2B with a throwaway receiver.

**Browserbase:** when a session ends (stopped, or found ended by the sweep), `GET /v1/sessions/{id}` gives
`startedAt`, `endedAt` and `proxyBytes`; Machines records a `browser_session`. **Namespace:** when a Mac is destroyed
(stopped, idle, or past its deadline), a `mac_session` with its shape and minutes from start to destruction (capped at
the deadline, which Machines now moves forward with each ssh extension; past it, a failed destroy no longer keeps the
Mac "running"). **R2:** the hourly job records each project's bytes once its UTC day has ended, summed from D1's
`media` and `attachments` rows (uploaded ones, with a project); the updates bucket is Dream's and isn't metered.
**Email:** each send, as one message ($0.35 per 1,000): an `EmailAccessLink` and each email the agent sends
(`SandboxRpcs.SendEmail`).

Not metered: Cloudflare Workers, D1 and Durable Objects (account-level, not attributable), and plan fees (E2B Pro,
Browserbase's plan, Namespace's). The operator's view says these are left out.

## The OpenAI gateway

The apps the agent builds keep needing OpenAI: text, speech, realtime voice, images, embeddings, transcription.
Dream now provides it: the apps use any OpenAI SDK as usual, Dream pays (or the person's own key does, below), and
every call is metered to its project.

**Address.** `https://openai.<domain>/v1` (`OpenAIGateway` in `packages/domain/src/Transport.ts`), the same paths as
`https://api.openai.com/v1`. It's a host of the same Worker (the zone route already reaches it; published apps'
hosts always have a dash, so `openai` can't collide), in its own module, `apps/api/src/openai/`, so it could move to a
Worker of its own.

**No secret in the sandbox.** dreamd gives the agent's shell and every app it starts `OPENAI_BASE_URL` (the gateway)
and `OPENAI_API_KEY=dream-openai-placeholder`. The project's E2B egress rules gain one for the gateway's host that
replaces `Authorization` with the project's gateway credential (derived from the project id with the Worker's signing
key, so the gateway verifies it statelessly and it is not the project token). So nothing in the sandbox can leak the
credential into a published page, and like every other credential it's swapped in on the way out.

**Not the agent.** The harnesses keep running on the person's subscription. Codex reads neither variable for its own
model traffic (it uses `CODEX_API_KEY` and its config), so dreamd passes them to the Codex process's commands through
`shell_environment_policy.set`, not to Codex itself; Claude Code ignores them, so its process env carries them to its
Bash tool. The gateway also refuses any request that identifies as Codex (`originator: codex_*`). A real-E2B check
proves a turn on each harness still reaches its model host and nothing else.

**Whose key.** If the person connected an OpenAI key of their own (a Key access for api.openai.com, which projects
already use directly), the gateway uses theirs and meters the call with `payer: person`; otherwise Dream's
(`OPENAI_API_KEY` Worker secret) with `payer: dream`. Removing their key moves their projects onto Dream's. Apps that
call api.openai.com directly keep working on their key through its egress rule, unmetered.

**What it forwards.** An allowlist, because one key shared by every project would let one project read another's
stored data: `POST /responses` (and `GET`/`DELETE`/`cancel` on a response id only for the project that created it),
`POST /chat/completions` (with `store` false; never the stored-completions list), `POST /embeddings`,
`POST /moderations`, `POST /images/generations|edits`, `POST /audio/speech|transcriptions|translations`,
`GET /models`, and realtime: `GET /realtime` (WebSocket), `POST /realtime/client_secrets`, `POST /realtime/calls`,
and GPT-Live's `/live/sessions`. Everything else (files, vector stores, conversations, batches, fine-tuning,
containers, assistants, evals, uploads, voices, videos, `/organization`) is a 404 that says what Dream supports.

**How it meters.** From what comes back, without holding the response: JSON bodies are read for `usage` (and
`tool_usage`); streams are teed and the copy parsed for the final event (`response.completed`, chat's usage chunk,
which the gateway asks for with `stream_options.include_usage`, `speech.audio.done`, `transcript.text.done`); TTS
without usage is estimated from the input (`estimated: true`). A realtime WebSocket is proxied message by message and
each `response.done` (and each input transcription) is metered. A WebRTC call can't be seen from the gateway, so a
client secret minted through it is wrapped (the app gets a Dream secret, not OpenAI's), the browser's SDP offer must
go to the gateway's `/realtime/calls` (it's the one route open to the public internet, with CORS, and only for wrapped
secrets), and the gateway attaches a sideband to the call (`?call_id=`) from a Durable Object that meters it until it
ends. Response ids are the transaction ids, so a background response metered by both its stream and a later poll
counts once.

**Off by default.** `DREAM_OPENAI_GATEWAY_ENABLED` (a plain binding from `.env`, like `DREAM_EMAIL_ENABLED`). Off, the
host answers 404, sandboxes get neither the variables nor the egress rule, and the agent isn't told about it. On
without `OPENAI_API_KEY`, calls for people without their own key fail with a clear error.

## Reading it back

`CostReport` (`apps/api/src/metering/Report.ts`) sums `meter_events` by center, payer and model for a UTC month and
by day for the last 30 days. It serves `AppRpcs.GetProjectCosts`, `AppRpcs.GetAccountCosts` and
`SandboxRpcs.GetProjectCosts` (shapes in `packages/domain/src/Costs.ts`). Operators (`DREAM_OPERATORS`, emails, a
plain binding from `.env`) also get `everyone`: each person's month and the overhead no person caused. A refresh
donor's run is its project's (`cause: refresh`), and a model sign-in's is its person's, with no project
(`unattributed`); overhead is what has no person: checks, probes, throwaway sandboxes. A project that's gone keeps
its costs, titled "A deleted project". `packages/sandbox-template/scripts/costs.ts` stays the operator's independent
cross-check, rebuilt from E2B's log.

## In the app

Costs sit beside the subscription's usage, never mixed into it: dollars here, the plan's percentages there, no
rings or window bars for costs, and each view of them ends with one short line, as the plan's part does with "Shares are
estimates.": "Estimates. None of this comes out of your plan.", and nothing below it. OpenAI calls their own key paid always show on their own, under "Paid by your OpenAI key", and never
in Dream's total. (`apps/mobile/src/ui/Costs.tsx`, `src/data/costs.ts`; fixtures `costs-*`.)

- **A project:** the usage sheet ends, under a hairline, with "What Dream paid in November": the total, last month
  beside it, and a line per cost center with what it bought ("Machine time · 41 hours", "Cloud browsers · 52
  minutes", "OpenAI · 412 requests"; a single OpenAI model goes in the line's title). Nothing at all for a project
  that hasn't cost anything this month or last, or against an API without costs. Storage shows no quantity, since
  GB-months so far this month don't read as anything.
- **All projects:** Settings has a "What Dream pays" card under the plans (this month, last month, the 30 days as
  small bars, and their own key's part in a line of its own), absent until something cost anything. Its "See more"
  opens `/costs`, full screen like the plan cards' breakdown (`/plan/<provider>`): the 30 days (touch a bar to read
  a day), what it paid for with OpenAI by model, the projects largest first (each opens its usage sheet; archived
  ones say so; deleted ones are one row; `unattributed` is "Outside your projects"), and their key's part.
- **Operators:** "Everyone on this Dream" at the foot of `/costs`, which only an operator's response makes appear,
  opens `/costs/everyone`: the month, the 30 days, what it paid for, each person's share, and the overhead no one
  caused; its line says Cloudflare and plan fees aren't counted.

Calls the app makes on the API's shapes, for the Worker side to match: a deleted project comes as
`{ title: "Deleted project", archived: true }` with no icon, as `GetAccountUsage` names one (the app folds them
into one row); `ProjectCost.personUsd` is what their key paid for that project; an API without the cost RPCs (or a
failed fetch) shows no costs anywhere rather than an error, since they're extra. The project's section is reachable
only where its usage sheet is (the header's ring, and each project row in `/costs`, which opens the sheet even when
no plan usage is known).

## The agent

The system prompt's Recurring work and the skill learn that the apps can call OpenAI through Dream with the usual SDK
variables, that Dream pays and meters it per project, and that the person can see it. `dream usage` prints what the
project cost this month. No rules: the agent weighs cost like any other judgment.
