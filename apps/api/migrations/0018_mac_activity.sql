-- What happened to each rented Mac (src/db/MacActivity.ts): its start, the agent's status checks and ssh
-- sessions, deadline extensions, what the ProjectDO saw running on it at each check, and its stop with the reason.
-- `kind` and `detail_json` are a `MacActivity`; `busy` (probes) and `reason` (stops) repeat it for queries. Operators
-- read it at GET /admin/macs/activity, or straight from D1.
CREATE TABLE mac_activity (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- start | status | ssh | extend | probe | stop
  busy INTEGER,                          -- probes: 1 when something the agent runs was at work
  reason TEXT,                           -- stops: explicit | idle | turn-ended | deadline | provider-gone | archived | deleted
  detail_json TEXT NOT NULL
);
CREATE INDEX mac_activity_instance ON mac_activity (instance_id, at);
CREATE INDEX mac_activity_project ON mac_activity (project_id, at);
