-- The metering ledger (src/metering, docs/metering.md): one row per meter event, as `Meter` records it. `id` is
-- derived from the source, so a retry or a second path records nothing new. `quantities_json` and
-- `dimensions_json` are the event's own; `project_id` and `owner` repeat dimensions for queries. The rest exists
-- only for the app: `center`, `payer`, `cost_usd` (an estimate from the price book dated `price_book`) and
-- `units` (the amount in the center's unit: hours, billed minutes, requests, GB-months, messages).
CREATE TABLE meter_events (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,                   -- a user id, or 'dream'
  meter TEXT NOT NULL,
  at TEXT NOT NULL,
  project_id TEXT,
  quantities_json TEXT NOT NULL,
  dimensions_json TEXT NOT NULL,
  center TEXT NOT NULL,
  payer TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  units REAL NOT NULL,
  price_book TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX meter_events_owner ON meter_events (owner, at);
CREATE INDEX meter_events_project ON meter_events (project_id, at);
CREATE INDEX meter_events_at ON meter_events (at);

-- The signing secret of the E2B webhook the Worker registered for itself (POST /admin/metering/e2b-webhook),
-- sealed with the master key like `secrets`: `{current, previous?}`, so deliveries signed just before a rotation
-- still verify.
CREATE TABLE meter_webhooks (
  provider TEXT PRIMARY KEY,             -- 'e2b'
  webhook_id TEXT NOT NULL,
  url TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  wrapped_key TEXT NOT NULL,
  key_nonce TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- `usage_events` (browser and Mac minutes, turn-based sandbox estimates) moves into the ledger, priced as it was
-- billed: browser minutes at $0.12 an hour, Mac minutes at the 4 vCPU / 7 GB rate. Sandbox estimates from the last
-- 7 days are left out: E2B still has those runs, and the hourly backfill records them exactly. Older ones are a
-- turn's time on a 4 vCPU / 8 GB sandbox (the size before sizes), marked `estimated`.
INSERT INTO meter_events (id, owner, meter, at, project_id, quantities_json, dimensions_json, center, payer,
  cost_usd, units, price_book, recorded_at)
SELECT
  CASE kind
    WHEN 'browser' THEN 'browserbase:' || COALESCE(ref, id)
    WHEN 'mac' THEN 'namespace:' || COALESCE(ref, id)
    ELSE 'usage:' || id
  END,
  user_id,
  CASE kind WHEN 'browser' THEN 'browser_session' WHEN 'mac' THEN 'mac_session' ELSE 'sandbox_run' END,
  ended_at,
  project_id,
  CASE kind
    WHEN 'browser' THEN json_object('ms', minutes * 60000)
    WHEN 'mac' THEN json_object('ms', minutes * 60000, 'vcpus', 4, 'memory_mb', 7168)
    ELSE json_object('ms', minutes * 60000, 'vcpus', 4, 'memory_mb', 8192)
  END,
  CASE kind
    WHEN 'browser' THEN json_object('project', project_id, 'payer', 'dream', 'provider', 'browserbase',
      'session', COALESCE(ref, ''), 'source', 'usage_events')
    WHEN 'mac' THEN json_object('project', project_id, 'payer', 'dream', 'provider', 'namespace',
      'instance', COALESCE(ref, ''), 'source', 'usage_events')
    ELSE json_object('project', project_id, 'payer', 'dream', 'provider', 'e2b', 'sandbox', COALESCE(ref, ''),
      'cause', 'project', 'estimated', 'true', 'source', 'usage_events')
  END,
  CASE kind WHEN 'browser' THEN 'browser' WHEN 'mac' THEN 'mac' ELSE 'sandbox' END,
  'dream',
  CASE kind
    WHEN 'browser' THEN minutes * 0.002
    WHEN 'mac' THEN minutes * 0.06
    ELSE minutes * 60 * (4 * 0.000014 + 8 * 0.0000045)
  END,
  CASE kind WHEN 'sandbox' THEN minutes / 60.0 ELSE minutes END,
  '2026-11-08',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM usage_events
WHERE kind IN ('browser', 'mac') OR (kind = 'sandbox' AND ended_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days'))
ON CONFLICT (id) DO NOTHING;
