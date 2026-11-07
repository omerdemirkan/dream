-- Fixed-window counters for routes that call a rate-limited provider on the operator's behalf (`db/RateLimits.ts`).
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start_ms INTEGER NOT NULL,
  count INTEGER NOT NULL
);
