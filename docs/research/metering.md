# Metering research (2026-11-08)

What the providers report about usage and cost, checked for Dream's metering (docs/metering.md). Sources are inline;
"unverified" marks what no source settled.

## E2B (live probe against api.e2b.app, a throwaway sandbox and webhook, both removed)

- Webhooks: `POST /events/webhooks` `{name, url, events[], signatureSecret, enabled?}` → 201 `{id, name, createdAt,
  teamId, url, enabled, events}` (the secret is never returned); `GET /events/webhooks[/{id}]`, `PATCH …/{id}` (any of
  enabled, name, url, events, signatureSecret), `DELETE …/{id}`, `GET …/{id}/deliveries?cursor=&limit=` (attempts with
  status, durationMs, errorClass, response code and bodies). Spec: e2b-dev/infra `spec/openapi.yml`; docs
  docs.e2b.dev/sandbox/lifecycle-events-webhooks. Webhooks are team-wide: every sandbox of the team fires them.
- Event types: `sandbox.lifecycle.created|paused|resumed|killed|updated|checkpointed` (the first five seen live).
- Signature: header `e2b-signature` = base64(SHA-256(secret + rawBody)) with trailing `=` stripped (a plain hash of
  the concatenation, not an HMAC), `e2b-signature-version: v1`. No timestamp is signed, so dedupe on the event `id`.
  Other headers: `e2b-webhook-id`, `e2b-delivery-id`, `user-agent: e2b-webhooks-agent`.
- Retries: up to 3 attempts on 4xx/5xx, timeouts or network errors (docs; timeout and backoff not stated). Deliveries
  arrived 0.07–0.5 s after the event, in order (not guaranteed).
- Webhook bodies are snake_case: `{id, version:"v2", type, timestamp, event_category, event_label, event_data:
  {execution?: {execution_time (ms), memory_mb, started_at, vcpu_count}, pause_mode?, kill_reason?, resume_mode?,
  set_timeout?, sandbox_metadata}, sandbox_id, sandbox_execution_id, sandbox_template_id, sandbox_build_id,
  sandbox_team_id, events_ttl_days}`. `GET /events/sandboxes` returns the same events camelCased at the top level
  (`eventData`, `sandboxId`, `sandboxExecutionId`, …) with snake_case inside `eventData`; the event `id` is the same in
  both, so it is the idempotency key for webhook and backfill alike.
- Only `paused` and `killed` carry `execution`: one billed run each, from create or resume. `sandbox_execution_id`
  changes on each resume. `kill_reason`: request, timeout, admin, orphaned, base_template_missing, seal_failed,
  resume_failed, unknown. `pause_mode`: full | filesystem.
- Price: $0.000014 per vCPU-second, $0.0000045 per GiB-second of RAM, disk included; Pro is $150/month plus usage.
  Paused sandboxes cost nothing. Cost of a run = execution_time/1000 × (vcpu_count × 0.000014 + memory_mb/1024 ×
  0.0000045). Use the sizes on each event (the base template reported 2 vCPU / 512 MB).
- `GET /events/sandboxes`: `limit` 1–100, `offset`, `orderAsc`, repeatable `types=`; no time filter or cursor.
  Retention is the team's `events_ttl_days`: 7. `GET /events/sandboxes/{id}` works after the sandbox is gone.
  There is no usage or billing API; the console's usage page is the only first-party bill.

## OpenAI (openai-openapi at 2026-11-07, developers.openai.com docs, codex at rust-v0.165.0)

What each endpoint reports:

| Endpoint | Usage in the response | Streamed |
| --- | --- | --- |
| `POST /v1/responses` | `usage{input_tokens, input_tokens_details{cached_tokens, cache_write_tokens}, output_tokens, output_tokens_details{reasoning_tokens}}`, plus top-level `tool_usage{web_search{num_requests}, image_gen{…tokens}}` (may be omitted) | `response.completed`, `.incomplete`, `.failed` carry the whole `response` |
| `POST /v1/chat/completions` | `usage{prompt_tokens, completion_tokens, prompt_tokens_details{cached_tokens, audio_tokens}, completion_tokens_details{reasoning_tokens, audio_tokens}}` | only with `stream_options.include_usage: true` (a last chunk with `choices: []`); none otherwise |
| `POST /v1/embeddings` | `usage{prompt_tokens}` | — |
| `POST /v1/moderations` | none; free | — |
| `POST /v1/images/generations`, `/edits` | `usage{input_tokens, input_tokens_details{text_tokens, image_tokens}, output_tokens, output_tokens_details}` | `image_generation.completed` has usage; partial images don't |
| `POST /v1/audio/speech` | none (binary audio) | `stream_format: "sse"` ends with `speech.audio.done{usage}`; not for tts-1/-hd |
| `POST /v1/audio/transcriptions`, `/translations` | `usage` `{type: "tokens", input_tokens, output_tokens…}` or `{type: "duration", seconds}` (whisper-1) | `transcript.text.done` has usage |
| Realtime WebSocket `wss://…/v1/realtime` | `response.done.response.usage{input_token_details{text, audio, image, cached…}, output_token_details{text, audio}}`; input transcription billed apart: `conversation.item.input_audio_transcription.completed.usage` | — |
| GPT-Live `/v1/live/sessions` | cumulative `session.usage.updated{usage{seconds}}`, final in `session.closed`; $0.05/min per second, WebRTC sessions bill 15 s up front | — |

- Model: read `model` from the body. No response header carries usage (`x-request-id` and rate-limit headers only).
- `service_tier` in the response decides the price (flex and batch ≈ 0.5×, priority/"fast" ≈ 2×).
- WebRTC: `POST /v1/realtime/client_secrets` mints `ek_…` (10 s–2 h to start sessions; one secret can start several;
  the session config is fixed at mint). `POST /v1/realtime/calls` takes the SDP offer and answers 201 with SDP and
  `Location: /v1/realtime/calls/rtc_…` (the call id). A server can attach a sideband `wss://api.openai.com/v1/realtime?
  call_id=rtc_…` with the real key and get the session's events "just as a typical Realtime WebSocket"; whether that
  includes `response.done` with usage is unverified (test one real call). GPT-Live's sideband is
  `wss://…/v1/live/sessions/{id}/attach` (replays only the last 3 s).
- Sora and `/v1/videos` were shut down on 2026-09-24.
- Shared-key leakage: anything stored is reachable by anyone with the key: stored chat completions (`GET
  /v1/chat/completions` lists them), responses by id, files, uploads, vector stores, conversations, batches,
  fine-tuning, evals, containers, assistants, threads, custom voices, stored live sessions.
- Usage and Costs APIs (`/v1/organization/usage/*`, `/costs`) need an admin key; group by project_id, api_key_id,
  model. No per-key usage without one.
- `safety_identifier` (body) / `OpenAI-Safety-Identifier` (header, on the realtime mint) is recommended per end user,
  hashed. Rate limits are per organization and project. Spend limits per project: an alert, or a hard limit that
  returns 429 `project_spend_limit_exceeded`.

Prices (Standard tier, per 1M tokens, developers.openai.com/api/docs/pricing.md, fetched 2026-11-08):

| Model | Input | Cached | Output |
| --- | --- | --- | --- |
| gpt-6-astra | 10 | 1.00 | 50 |
| gpt-6.1-sol | 2 | 0.10 | 10 |
| gpt-6.1-terra | 1 | 0.05 | 5 |
| gpt-6-luna | 0.10 | 0.01 | 0.50 |
| gpt-6-sol | 2 | 0.20 | 10 |
| gpt-5.6-sol / terra / luna | 4 / 2 / 0.20 | 0.40 / 0.20 / 0.02 | 20 / 12 / 1.20 |
| gpt-5.5 | 5 | 0.50 | 30 |
| gpt-5.4-mini / nano | 0.75 / 0.20 | 0.075 / 0.02 | 4.50 / 1.25 |
| gpt-5-mini / nano | 0.25 / 0.05 | 0.025 / 0.005 | 2 / 0.40 |
| gpt-4o-mini | 0.15 | 0.075 | 0.60 |
| text-embedding-3-small / large | 0.02 / 0.13 | | |
| gpt-image-2* | text 5, image 8 | 1.25 / 2 | image 30 |
| gpt-image-1.5 | text 5, image 8 | 1.25 / 2 | text 10, image 32 |
| gpt-image-1-mini | text 2, image 2.50 | 0.20 / 0.25 | image 8 |
| gpt-realtime-2.1 | audio 32, text 4, image 5 | audio 0.40, text 0.40 | audio 64, text 24 |
| gpt-realtime-2.1-mini | audio 10, text 0.60 | audio 0.30, text 0.06 | audio 20, text 2.40 |
| gpt-realtime-1.5 | audio 32, text 4 | 0.40 | audio 64, text 16 |
| gpt-4o-mini-tts | text 0.60 | | audio 12 |
| gpt-4o-transcribe / mini | 2.50 / 1.25 | | 10 / 5 |

Per unit: tts-1 $15 and tts-1-hd $30 per 1M characters; whisper-1 $0.006/min; gpt-transcribe $0.0045/min;
gpt-realtime-whisper $0.017/min; gpt-live-1 $0.05/min; web search $10 per 1k calls; long context ≈ 2× input.

Codex 0.165.0: its model auth is `CODEX_API_KEY` (or ChatGPT auth); it does not read `OPENAI_BASE_URL` (only config
`openai_base_url` / `model_providers`), and reads `OPENAI_API_KEY` only for its own realtime and onboarding. It
sends `originator: codex_cli_rs` and `User-Agent: codex_cli_rs/0.165.0 …`. `shell_environment_policy` applies, in
order: `inherit` (all by default), default excludes (`*KEY*|*SECRET*|*TOKEN*`, skipped by default since
`ignore_default_excludes` defaults to true), `exclude`, `set` (survives the excludes), `include_only`, then a fixed
scrub list. Commands run as `bash -lc` by default, so a profile could overwrite exports; `set` is the reliable way.

## Usage-billing platforms

Platforms such as Orb, Lago, OpenMeter and Stripe's meters share a model: they ingest an append-only stream of usage
events, each with an idempotency key, the customer it belongs to, an event or meter name, a timestamp and a bag of
properties; meters aggregate a property (sum, count, max, unique) filtered and grouped by others; prices attach to
meters separately. Retries are safe because of the idempotency key, and late events within a window are accepted.
So Dream's events carry raw quantities and dimensions, stable ids and owners, and no prices.

## Browserbase, Namespace, Cloudflare

- Browserbase (live, `GET /v1/sessions/{id}`): `startedAt`, `endedAt`, `status`, `proxyBytes`, `region`, `keepAlive`.
  `GET /v1/projects/{id}/usage` → `{browserMinutes, proxyBytes}`. Developer plan $20/month with 100 browser hours,
  then $0.12 per hour; proxies 1 GB included, then $12/GB (browserbase.com/pricing). 1-minute minimum.
- Namespace macOS (namespace.so/pricing): 4 vCPU / 7 GB $0.06/min pay-as-you-go ($0.04 prepaid); 6 / 14 GB
  $0.09/min; 8 / 14 GB $0.12/min. Billed per minute (the next 15 s round down). Destroyed at `deadline` and billed
  until destroyed. No usage API.
- Cloudflare: R2 $0.015 per GB-month (10 GB free); Workers, D1 and Durable Objects are account-level and not worth
  splitting per project. Email Service price per message unverified.
