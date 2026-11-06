-- Over-the-air updates of the iPhone app (src/http/Updates.ts). Every publish, rollback or promotion appends a
-- release; the newest release of a (channel, platform, runtime version) is what the app gets. `content_json` holds
-- an update's launch asset, assets and public app config (the bytes are in the Updates R2 bucket); a
-- rollback_to_embedded release has none.
CREATE TABLE update_releases (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  platform TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('update', 'rollback_to_embedded')),
  created_at TEXT NOT NULL,
  content_json TEXT,
  git_commit TEXT,
  message TEXT,
  republish_of TEXT
);
CREATE INDEX update_releases_runtime ON update_releases (channel, platform, runtime_version, created_at);

-- The last time a build of each runtime version asked for an update, and what it was running. Publishing checks it,
-- so an update whose runtime version no build has isn't published by mistake.
CREATE TABLE update_check_ins (
  channel TEXT NOT NULL,
  platform TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  last_check_at TEXT NOT NULL,
  running_update_id TEXT,
  embedded_update_id TEXT,
  PRIMARY KEY (channel, platform, runtime_version)
);

-- The key updates are signed with (one row, name 'main'), generated inside the Worker and sealed with the master key
-- like `secrets`; the certificate is public (the app embeds it).
CREATE TABLE update_signing_key (
  name TEXT PRIMARY KEY,
  certificate_pem TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  wrapped_key TEXT NOT NULL,
  key_nonce TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL
);
