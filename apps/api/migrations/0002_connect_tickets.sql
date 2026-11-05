-- One-time `CreateConnectLink` pages. The ticket is a signed token carrying `id`;
-- this row makes it single-use (`used_at` is set when the page is submitted).
CREATE TABLE connect_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  provider TEXT NOT NULL,                -- claude
  expires_at_ms INTEGER NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
