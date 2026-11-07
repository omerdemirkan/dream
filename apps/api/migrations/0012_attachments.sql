-- Photos and files they attach to messages and new ideas (AppRpcs.CreateAttachmentUpload). An upload belongs to
-- the person until a message takes it; then it belongs to that project and message.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id),
  project_id TEXT,
  claim TEXT,                            -- what took it: the message id, or a new idea's project id
  object_key TEXT NOT NULL,
  ref_json TEXT NOT NULL,                -- Attachment
  uploaded_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX attachments_project ON attachments (project_id);
