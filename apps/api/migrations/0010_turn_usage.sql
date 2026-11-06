-- One row per agent turn: the tokens it used (exact, as dreamd reports them) and how full each subscription window
-- was before and after it (as Dream last knew it), from which src/usage/Shares.ts estimates each project's share.
-- "Before" is the connection's latest UsageSnapshot when the turn started, "after" the latest when it finished
-- (dreamd reports usage just before it reports the turn finished). Token columns are null when dreamd sent none
-- (builds before per-turn usage, or a turn the archive interrupted); window columns are null when the snapshot
-- didn't report that window, or there was no snapshot yet.
CREATE TABLE turn_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,                -- claude | chatgpt
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  input_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,                         -- Claude Code's list-price cost; Codex reports none
  subagents TEXT,                        -- included | excluded; null when dreamd couldn't tell
  before_observed_at TEXT,
  five_hour_before_percent REAL,
  five_hour_before_resets_at TEXT,
  weekly_before_percent REAL,
  weekly_before_resets_at TEXT,
  after_observed_at TEXT,
  five_hour_after_percent REAL,
  five_hour_after_resets_at TEXT,
  weekly_after_percent REAL,
  weekly_after_resets_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX turn_usage_user ON turn_usage (user_id, provider, ended_at);
CREATE INDEX turn_usage_project ON turn_usage (project_id, ended_at);
