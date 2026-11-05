-- Global state (docs/PLAN.md §5). Timestamps are ISO-8601 UTC strings unless a
-- column name ends in _ms (epoch milliseconds, for range scans). JSON columns
-- hold the JSON encoding of the named @dream/domain schema.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,            -- lowercase
  name TEXT,
  google_sub TEXT UNIQUE,
  time_zone TEXT,
  created_at TEXT NOT NULL
);

-- The allowlist: only these Google accounts can sign in.
CREATE TABLE invites (
  email TEXT PRIMARY KEY,                -- lowercase
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,                   -- client-generated UUID
  user_id TEXT NOT NULL REFERENCES users (id),
  platform TEXT NOT NULL,
  apns_token TEXT,
  push_to_start_token TEXT,
  time_zone TEXT NOT NULL,
  app_version TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX devices_user ON devices (user_id);

-- User credentials, AES-GCM envelope encrypted (src/lib/SecretBox.ts).
-- Decrypted only inside the Worker; nothing else stores secret values.
CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL,                    -- claude_token | chatgpt_tokens | google_oauth | api_key | apple_asc | auth_session
  key_version INTEGER NOT NULL,
  wrapped_key TEXT NOT NULL,
  key_nonce TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX secrets_owner ON secrets (owner_id);

-- Claude or ChatGPT subscription, once per person.
CREATE TABLE model_connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,                -- claude | chatgpt
  status TEXT NOT NULL,                  -- pending | connected | expired | failed
  secret_id TEXT REFERENCES secrets (id),
  -- While pending: the short-lived auth sandbox and the flow shown on the phone.
  auth_sandbox_id TEXT,
  auth_secret_id TEXT REFERENCES secrets (id),
  flow_json TEXT,                        -- ModelConnectFlow
  error TEXT,
  -- ChatGPT access tokens expire; the cron refreshes them centrally.
  access_expires_at_ms INTEGER,
  refresh_lock_until_ms INTEGER,
  usage_json TEXT,                       -- UsageSnapshot
  connected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX model_connections_user ON model_connections (user_id);
CREATE INDEX model_connections_refresh ON model_connections (provider, status, access_expires_at_ms);

-- Google, pasted keys, App Store Connect. Shared by all of a person's projects.
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  kind TEXT NOT NULL,                    -- google_oauth | api_key | apple_asc
  label TEXT NOT NULL,
  status TEXT NOT NULL,                  -- connected | revoked | failed
  access_json TEXT NOT NULL,             -- IntegrationAccess
  secret_id TEXT NOT NULL REFERENCES secrets (id),
  -- When the injected header value stops working (Google access tokens, App Store Connect JWTs).
  access_expires_at_ms INTEGER,
  refresh_lock_until_ms INTEGER,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX integrations_user ON integrations (user_id);
CREATE INDEX integrations_refresh ON integrations (status, access_expires_at_ms);

-- Google OAuth `state` values between StartGoogleAccess and the callback.
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  project_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id),
  title TEXT NOT NULL,
  kind TEXT,
  icon TEXT,
  idea TEXT NOT NULL,
  harness TEXT NOT NULL,
  phase TEXT NOT NULL,
  headline TEXT,
  slug TEXT NOT NULL,
  host TEXT NOT NULL UNIQUE,             -- <slug>-<random>.<domain>
  public_url TEXT NOT NULL,
  published_port INTEGER,
  sandbox_id TEXT,
  progress_done INTEGER,
  progress_total INTEGER,
  paused_until TEXT,
  open_asks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX projects_owner ON projects (owner_id, updated_at);

-- A copy of each project's open questions and access requests, for the Home deck.
CREATE TABLE open_asks (
  message_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  message_json TEXT NOT NULL,            -- AskMessage
  created_at TEXT NOT NULL
);
CREATE INDEX open_asks_user ON open_asks (user_id, created_at);

-- Every notification sent, so the app can ask which delivered ones are stale.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,                   -- the apns-id UUID
  user_id TEXT NOT NULL REFERENCES users (id),
  project_id TEXT NOT NULL,
  message_id TEXT,
  sent_at TEXT NOT NULL,
  withdrawn_at TEXT
);
CREATE INDEX notifications_user ON notifications (user_id);

-- Uploaded screenshots and recordings; bytes live in R2 under `key`.
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  object_key TEXT NOT NULL,
  ref_json TEXT NOT NULL,                -- MediaRef
  uploaded_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX media_project ON media (project_id);

-- Machine time per project, for billing later.
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- sandbox | browser | mac
  ref TEXT,                              -- sandbox, session or instance id
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  minutes REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX usage_events_project ON usage_events (project_id, started_at);
CREATE INDEX usage_events_user ON usage_events (user_id, started_at);
