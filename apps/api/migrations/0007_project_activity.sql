-- What Home shows of each project's agent: starting, working or idle (and when it sleeps), and its next wake.
-- A JSON `AgentActivity`, written by the project's DO with the rest of its row; null until it next projects.
ALTER TABLE projects ADD COLUMN activity_json TEXT;
