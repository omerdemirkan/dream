-- When they archived the project (ArchiveProject): it's off Home and out of the deck until they restore it.
-- Null: not archived. Written by the project's DO, which also holds its agent while it's set.
ALTER TABLE projects ADD COLUMN archived_at TEXT;
