-- Grants for Dream's own TestFlight builds: the operator lets one Namespace build Mac (by instance id)
-- fetch the App Store Connect key once (`/admin/testflight/grants`, then `/testflight/asc-key`).
CREATE TABLE testflight_grants (
  instance_id TEXT PRIMARY KEY,
  expires_at_ms INTEGER NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
