-- Scheduled tasks (`dream wake --task`) run in a session of their own and are recorded here like turns, so their
-- tokens count for the project. `wake_id` is the task's wake; null for the project's own turns.
ALTER TABLE turn_usage ADD COLUMN wake_id TEXT;
