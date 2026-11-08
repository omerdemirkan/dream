-- What projects made through Dream's AI gateway that OpenAI keeps: stored responses, WebRTC calls and GPT-Live
-- sessions. One key serves many projects, so the gateway forwards a read of one only for the project that made it
-- (`openai/Objects.ts`). A stored response nobody saw finish (a background one, or a stream the app left) is looked
-- up by the sweep at `next_check_ms` until it's metered; `metered` is 1 once it was, 2 when the sweep gave up.
CREATE TABLE openai_objects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  background INTEGER NOT NULL DEFAULT 0,
  metered INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_check_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX openai_objects_due ON openai_objects (metered, kind, next_check_ms);
