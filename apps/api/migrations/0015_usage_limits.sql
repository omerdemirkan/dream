-- Usage limits they set on a project, and the one that holds it, as each ProjectDO projects them (`db/Projects.ts`).
ALTER TABLE projects ADD COLUMN usage_limits_json TEXT;
ALTER TABLE projects ADD COLUMN paused_by_json TEXT;
