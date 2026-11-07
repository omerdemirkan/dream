-- Links they had emailed to finish an access request on a computer (`EmailAccessLink`, src/desktop/).
-- Only hashes are kept: `token_hash` of the emailed token, `session_hash` of the cookie of the one browser that
-- opened it. A link opens once, before `expires_at_ms`, and its session lasts until `session_expires_at_ms`.
-- `finished_at_ms` and `revoked_at_ms` (a newer link for the same request, or the request was answered) end it.
CREATE TABLE desktop_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id),
  project_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  opened_at_ms INTEGER,
  session_hash TEXT,
  session_expires_at_ms INTEGER,
  finished_at_ms INTEGER,
  revoked_at_ms INTEGER
);
CREATE INDEX desktop_links_message ON desktop_links (project_id, message_id, created_at_ms);
CREATE INDEX desktop_links_user ON desktop_links (user_id, created_at_ms);
