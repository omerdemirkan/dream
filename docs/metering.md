# Metering what Dream pays for

Dream pays providers to run each project: E2B for sandbox time (by far the largest), Browserbase for cloud browsers,
Namespace for Macs, OpenAI for the calls the agent's apps make through Dream's AI gateway, and a little R2 and email.
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
| `meter` | `sandbox_run`, `browser_session`, `mac_session`, `model_request`, `storage_day`, `email_sent` |
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
| `model_request` | `openai:<OpenAI id>`: the response's (Responses, a realtime `response.done`), the completion's (Chat), `<item id>:transcription` (a realtime input transcription), `<response id>:image_gen` (the image tool), the call's or Live session's (a session metered by its length); else `openai:<x-request-id>` (embeddings, images, speech, transcription) | `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_tokens`, `input_audio_tokens`, `cached_audio_tokens`, `output_audio_tokens`, `input_image_tokens`, `cached_image_tokens`, `output_image_tokens`, `characters`, `audio_ms`, `session_ms`, `web_search_calls`, `images` | `provider` (`openai`), `endpoint` (`responses`, `chat`, `embeddings`, `images`, `speech`, `transcription`, `realtime`, `live`), `model`, `service_tier`, `size` and `quality` (images priced per image), `estimated` (`true` when a quantity was inferred: speech without usage, a transcript in text, srt or vtt, a call metered by its length) |
| `storage_day` | `r2:<project id>:<YYYY-MM-DD>` | `bytes` (stored at the end of the UTC day) | |
| `email_sent` | `email:<message id>` | `recipients` | |

Only the keys that apply are present. Provider rules such as Browserbase's one-minute minimum are pricing, so they
live in the price book, not in the quantities.

OpenAI's token counts nest the way OpenAI reports them, and the price book prices them that way: `input_tokens` is
every input token (cached, audio and image ones included), `cached_input_tokens` the cached ones of every modality,
with `cached_audio_tokens` the audio ones among them; `input_audio_tokens` and `input_image_tokens` are the audio and
image ones among `input_tokens` (cached included); `output_tokens` is every output token, with `reasoning_tokens`,
`output_audio_tokens` and `output_image_tokens` among them; `cached_image_tokens` are the image ones among
`cached_input_tokens` (and `input_image_tokens`), priced at the book's `cachedImageInput`. A model without a separate price for a modality
(transcription) bills it at its text price. Speech estimated without usage should send `characters` for tts-1 and
tokens for the token-priced voices; the book prices whatever quantities are there. The gateway does exactly that: `characters` always,
and for a token-priced voice `input_tokens` at about four characters a token and `output_tokens` =
`output_audio_tokens` at about 1,250 a minute of speech and 900 characters a minute, `estimated: true`; speech that
reports usage (`stream_format: "sse"`) has its output tokens counted as audio. The image tool's model isn't
reported, so its event says `gpt-image (tool)` (priced at 0 until the book knows it); a realtime input
transcription whose session didn't name its model says `realtime-transcription`. An image model's output is image
tokens, so when its usage doesn't break them out, `output_image_tokens` = `output_tokens`. dall-e-2 and dall-e-3
report no usage: their events carry `images` (how many were asked for) with `size` and `quality`, priced per image
(`perImage` in the book). A transcript asked for as `text`, `srt` or `vtt` carries no usage either: its `audio_ms`
comes from the subtitles' last timestamp or, for text, from the words at about 150 a minute, and the token-priced
models also get `input_tokens` = `input_audio_tokens` at one per 100 ms and `output_tokens` at four characters each,
all `estimated`. OpenAI reports no cost, so these events never carry `cost_usd`.

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

**Reported costs.** A provider that says what a request cost (none of today's does; some model routers do) gives the event a
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

## The AI gateway

The apps the agent builds keep needing a model API: text, speech, realtime voice, images, embeddings, transcription.
Dream now provides OpenAI's: the apps use any OpenAI SDK as usual, Dream pays with its own key, and every call is
metered to its project (center `models`, provider `openai`).

**Address.** `https://openai.<domain>/v1` (`OpenAIGateway` in `packages/domain/src/Transport.ts`), the same paths as
`https://api.openai.com/v1`. It's a host of the same Worker (the zone route already reaches it; published apps'
hosts always have a dash, so `openai` can't collide), in its own module, `apps/api/src/openai/`, so it could move to a
Worker of its own. Its connection to OpenAI is one service (`OpenAIUpstream`), the only place another upstream would
plug in.

**No secret in the sandbox.** dreamd gives the agent's commands and the apps they start `OPENAI_BASE_URL` (the
gateway) and `OPENAI_API_KEY=dream-openai-placeholder`. The project's E2B egress rules gain one for the gateway's host
that replaces `Authorization` with the project's gateway credential (an HS256 token of the project and its owner,
with the Worker's signing key and no expiry, so it's the same on every push and the gateway checks it statelessly; it
is not the project token, and deleting the project revokes it). Egress transforms apply to WebSocket upgrades too
(checked on real E2B, 2026-11-08), so realtime sockets work the same way.

E2B re-signs HTTPS to every host with a rule with its own CA, which the system trusts but Node, Bun and Python's
`requests`/`httpx` don't: a plain `fetch` from Node to such a host failed with "unable to verify the first
certificate" (checked on E2B). dreamd now sets `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE` to the
system bundle for every process it starts, which fixes this for the gateway and for every connected service's host.

**Not the agent.** The harnesses keep running on the person's subscription. Codex never gets the variables in its own
environment (its model base URL comes from the adapter's `OPENAI_BASE_URL`, which they'd collide with); its commands
get them through `shell_environment_policy.set`. Claude Code reads neither, so its process carries them to its Bash
tool. `--run` commands get them from dreamd, and a scheduled task's session is set up like the agent's. The gateway
also refuses any request that identifies as Codex (`originator` or `User-Agent` starting `codex`).
`apps/api/scripts/workerd-check/` runs the gateway in workerd itself against fake-openai (outbound WebSocket
upgrades, `WebSocketPair` and the 101, `waitUntil` while a socket is open, the sideband in a Durable Object).
`packages/sandbox-template/scripts/gateway-check.ts` checks all of it in a sandbox of a build against a public
fake-openai (`packages/dreamd/scripts/fake-openai.ts`).

**Whose key.** Always Dream's (`OPENAI_API_KEY` Worker secret), `payer: dream`. A person's own OpenAI key (a Key
access for api.openai.com) is untouched: apps that call api.openai.com directly keep using it through its egress
rule, unmetered, and it never routes through the gateway.

**What it forwards** (`openai/Endpoints.ts`). An allowlist, because one key shared by every project would let one
project read another's stored data: `POST /responses` (with `GET`, `DELETE`, `POST …/cancel` and `GET …/input_items`
on a response id only for the project that made it, from `openai_objects` in D1) and `POST /responses/input_tokens`,
`POST /chat/completions` (always sent with `store: false`; never the stored-completions list), `POST /embeddings`,
`POST /moderations`, `POST /images/generations|edits`, `POST /audio/speech|transcriptions|translations`,
`GET /models[/id]`, realtime (`GET /realtime` as a WebSocket, `POST /realtime/client_secrets`,
`POST /realtime/calls`, `POST /realtime/calls/{id}/hangup` for its project), and GPT-Live (`POST /live/sessions` for
WebRTC, its WebSocket, and `hangup`/`content` for its project; SIP phone calls are refused). Everything else (files,
uploads, vector stores, conversations, batches, fine-tuning, containers, assistants, threads, evals, custom voices,
videos, `/organization`, the legacy realtime session mints) is a 404 whose message says what Dream supports.
A Responses request (and `input_tokens`) may not reach what OpenAI stored for another project: `conversation`,
`item_reference` inputs, `file_id`s, `vector_store_ids` and container ids are refused (nothing a project makes
through the gateway is stored as any of them), and `previous_response_id` must name a response this project made.
A realtime WebSocket's query keeps only `model` and `intent`; `call_id`, which would attach to a WebRTC call, is
refused (Dream's sideband is the only one), and ids in paths are a strict set of characters, so nothing encoded
reaches OpenAI's path. Every request carries a `safety_identifier` (or `OpenAI-Safety-Identifier`) from the project
that no app can choose: an app's own is hashed and appended, so its end users stay apart within the project.

**How it meters.** From what comes back, without holding it: bodies stream through to the app while a copy is read
(`openai/Sse.ts`), JSON for `usage` and `tool_usage`, event streams for their final event (`response.completed`,
`.incomplete`, `.failed`; chat's usage chunk, which the gateway asks for with `stream_options.include_usage` and
takes out of the stream when the app didn't ask; `speech.audio.done`; `transcript.text.done`;
`image_generation.completed`). Speech without usage (binary audio, tts-1) is its input's characters, `estimated`. A
realtime WebSocket is proxied message by message and each `response.done` and each input transcription is metered.
A WebRTC call can't be seen from the gateway, so a client secret minted through it is wrapped (the app gets a Dream
secret, OpenAI's sealed inside with the project, which only the gateway opens; nothing is stored), the browser's SDP
offer has to go to the gateway's `/realtime/calls` (the one route open to the public internet, with CORS, and only for
wrapped secrets), and the gateway attaches a sideband (`?call_id=`) from `OpenAICallDO`, which meters the call until
it ends. A GPT-Live WebRTC session gets the same sideband at `/live/sessions/{id}/attach`. A sideband that sees no
usage at all records the call's length (`session_ms`, `estimated`). Response ids are the transaction ids, so a
response metered by both its stream and a later poll counts once. Every stored response (and every background one) is
recorded unmetered when it's made, and whatever its stream, the app's polls or the JSON answer don't meter, the
five-minute maintenance does (`sweepBackgroundResponses`): two minutes on, it looks the response up, then again at
growing intervals (up to an hour) while it isn't done, each row at its own `next_check_ms`, and gives up after a day.
Recording ownership and metering never fail a call: if D1 refuses, the answer still goes back (and at worst the
project's later reads of that response are refused).

Not metered: a `store: false` stream the app hangs up on before its last event (OpenAI bills what it generated, and
with nothing stored the gateway can't look it up), and a sideband's call when `OpenAICallDO` restarts mid-call (a
deploy).

**Checking it live without an agent.** `POST /admin/openai/dev-credential` (behind `x-dream-dev-secret`) mints an
hour's gateway credential for a dev pseudo-project, `prj_dev_<label>`, owned by `dream`: a token of its own kind
(`openai-dev`, with an expiry, the Worker's signing key), which the gateway takes without a project row and meters
to Dream's overhead under that project id. `GET /admin/openai/dev-events?project=prj_dev_…` lists what the ledger
recorded for one. `packages/sandbox-template/scripts/gateway-live-check.ts` uses both: a throwaway sandbox with the
credential in its egress rule makes a Responses call, a stream, a short speech and a tiny realtime exchange through
`openai.<domain>`, checks a refused path and a refused Codex request, and prints what was metered; with the gateway
on but no key, it checks the 503 "isn't configured".

**Off by default.** `DREAM_AI_GATEWAY_ENABLED` (a plain binding from `.env`, like `DREAM_EMAIL_ENABLED`). Off, the
host answers 404, sandboxes get neither the variables nor the egress rule, and the agent isn't told: dreamd installs
the `dream-openai` skill (`docs/prompts/skills/dream-openai/`) only while `DREAM_OPENAI_BASE_URL` is in its env, and its listing in the
harness's skills is the agent's pointer to it. Turning it on reaches a running sandbox between turns (the env file and
the rules are pushed together). On without `OPENAI_API_KEY`, every call answers 503 "isn't configured".

## Reading it back

`CostReport` (`apps/api/src/metering/Report.ts`) sums `meter_events` by center, payer and model for a UTC month and
by day for the last 30 days. It serves `AppRpcs.GetProjectCosts`, `AppRpcs.GetAccountCosts` and
`SandboxRpcs.GetProjectCosts` (shapes in `packages/domain/src/Costs.ts`). Operators (`DREAM_OPERATORS`, emails, a
plain binding from `.env`) also get `everyone`: each person's month and the overhead no person caused. A refresh
donor's run is its project's (`cause: refresh`), and a model sign-in's is its person's, with no project
(`unattributed`); overhead is what has no person: checks, probes, throwaway sandboxes. A project that's gone keeps
its costs, titled "Deleted project" and merged into one row by the app. `packages/sandbox-template/scripts/costs.ts` stays the operator's independent
cross-check, rebuilt from E2B's log.

## In the app

Costs sit beside the subscription's usage, never mixed into it: dollars here, the plan's percentages there, no
rings or window bars for costs. Each view of them ends with one short line, as the plan's part does with "Shares
are estimates.": "Estimates. None of this comes out of your plan.", and nothing below it. Only Dream's lines
(`payer: "dream"`) show: a person's own OpenAI key goes straight to api.openai.com and isn't metered, so the app
has no person-paid part, and ignores one if it appears. (`apps/mobile/src/ui/Costs.tsx`, `src/data/costs.ts`;
fixtures `costs-*`.)

- **A project:** the usage sheet ends, under a hairline, with "What Dream paid in November": the total, last month
  beside it, and a line per cost center with what it bought ("Machine time · 41 hours", "Cloud browsers · 52
  minutes", "OpenAI · 412 requests"; a single model goes in the line's title). Nothing at all for a project
  that hasn't cost anything this month or last, or against an API without costs. Storage shows no quantity, since
  GB-months so far this month don't read as anything.
- **All projects:** Settings has a "What Dream pays" card under the plans (this month, last month, the 30 days as
  small bars), absent until something cost anything. Its "See more" opens `/costs`, full screen like the plan
  cards' breakdown (`/plan/<provider>`): the 30 days (touch a bar to read a day), what it paid for with OpenAI by
  model, the projects largest first (each opens its usage sheet; archived ones say so; deleted ones
  are one row; `unattributed` is "Outside your projects").
- **Operators:** "Everyone on this Dream" at the foot of `/costs`, which only an operator's response makes appear,
  opens `/costs/everyone`: the month, the 30 days, what it paid for, each person's share, and the overhead no one
  caused; its line says Cloudflare and plan fees aren't counted.

What the app assumes of the API's shapes, for the Worker side to match: the `models` center reads "OpenAI" (one
mapping, `centerTitle` in `data/costs.ts`) and its models are shown by their ids as they come (`gpt-4o-mini-tts`);
a deleted project comes as `{ title: "Deleted project", archived: true }` with no icon, as
`GetAccountUsage` names one (the app folds them into one row); an API without the cost RPCs (or a failed fetch)
shows no costs anywhere rather than an error, since they're extra. The project's section is reachable only where
its usage sheet is (the header's ring, and each project row in `/costs`, which opens the sheet even when no plan
usage is known).

## The agent

While the AI gateway is on, the agent and every task's session get the `dream-openai` skill
(`docs/prompts/skills/dream-openai/`): the apps can call OpenAI through Dream with the usual SDK variables, Dream pays
and meters it per project, and the person can see it. The system prompt doesn't mention the gateway, so a project
without it hears nothing; the skill's listing is the pointer. `dream usage` prints what the project cost this month. No rules: the agent weighs cost like any other judgment.
