-- How hard each sandbox worked, per UTC hour it ran (src/metering/SandboxUsage.ts): the hourly job reads E2B's
-- metrics for the sandboxes that ran lately and keeps one row per sandbox and hour, rewritten while the hour fills.
-- E2B keeps metrics only for sandboxes that still exist, at a coarser step the further back it's asked, so this is
-- what sizing questions are answered from. Read by packages/sandbox-template/scripts/resource-review.ts.
CREATE TABLE sandbox_usage (
  sandbox_id TEXT NOT NULL,
  hour TEXT NOT NULL,                    -- the hour's start, ISO
  project_id TEXT,
  cause TEXT NOT NULL,                   -- as in meter_events: project | refresh | sign-in | dev | harness-check
  vcpus INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL,            -- what it was given
  samples INTEGER NOT NULL,
  cpu_avg_pct REAL NOT NULL,
  cpu_max_pct REAL NOT NULL,
  mem_avg_mb REAL NOT NULL,
  mem_max_mb REAL NOT NULL,              -- used, page cache not included
  disk_used_max_mb REAL NOT NULL,
  disk_total_mb REAL NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (sandbox_id, hour)
);
CREATE INDEX sandbox_usage_project ON sandbox_usage (project_id, hour);

-- What the ProjectDO used a project's sandbox for between turns (src/db/SandboxWakes.ts): handing dreamd events,
-- a scheduled command or task, a visit to the published app, a relay's delivery, a refresh or a move. E2B's log
-- says when a sandbox ran and the turns say when the agent worked; this says why the rest of the time happened.
-- At most one row a minute per project and reason; the hourly job drops rows older than 30 days.
CREATE TABLE sandbox_wakes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  at TEXT NOT NULL,
  reason TEXT NOT NULL,                  -- delivery | wake-run | wake-task | visit | relay | refresh | move
  detail TEXT                            -- deliveries: the events' tags
);
CREATE INDEX sandbox_wakes_project ON sandbox_wakes (project_id, at);
CREATE INDEX sandbox_wakes_at ON sandbox_wakes (at);
