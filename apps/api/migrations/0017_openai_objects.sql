-- What projects made through Dream's OpenAI gateway that OpenAI keeps: stored responses, WebRTC calls and GPT-Live
-- sessions. One key serves many projects, so the gateway forwards a read of one only for the project that made it
-- (`openai/Objects.ts`). Background responses are metered when they finish; `metered` says one was.
CREATE TABLE openai_objects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  background INTEGER NOT NULL DEFAULT 0,
  metered INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX openai_objects_pending ON openai_objects (background, metered, created_at_ms);
