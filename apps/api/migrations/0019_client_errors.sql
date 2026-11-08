-- Crash and error reports from the iPhone app (src/db/ClientErrors.ts, POST /client-errors): the error, its stack, the
-- screen's route and the build and update that ran it. No message text or personal content; `user_id` is set only
-- when the report came with a valid session. Operators read it at GET /admin/client-errors, or straight from D1.
CREATE TABLE client_errors (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- fatal | error | rejection | render
  message TEXT NOT NULL,
  stack TEXT,
  component_stack TEXT,
  screen TEXT,
  app_version TEXT NOT NULL,
  app_build TEXT NOT NULL,
  update_id TEXT,
  runtime_version TEXT,
  channel TEXT,
  os TEXT,
  user_id TEXT
);
CREATE INDEX client_errors_received ON client_errors (received_at);
