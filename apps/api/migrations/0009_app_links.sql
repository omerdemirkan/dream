-- App links: the row of app icons at the top of Home (packages/domain/src/Links.ts). Per person, with the project a
-- link belongs to, if any. A project's agent adds links with `dream link`; the person adds any https URL.
CREATE TABLE app_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  added_by TEXT NOT NULL,              -- agent | person
  url TEXT NOT NULL,
  host TEXT NOT NULL,                  -- the URL's lowercase host, for the gateway
  title TEXT NOT NULL,
  icon_json TEXT,                      -- LinkIcon; null shows a monogram
  color TEXT NOT NULL,
  their_title INTEGER NOT NULL DEFAULT 0, -- on an agent's link: they renamed it, so the agent can't
  their_icon INTEGER NOT NULL DEFAULT 0,  -- … they changed its icon
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  opened_at TEXT,
  removed_at TEXT                      -- an agent's link they removed: kept so the agent can't add that URL again
);
CREATE INDEX app_links_user ON app_links (user_id, created_at);
CREATE INDEX app_links_project ON app_links (project_id);
CREATE INDEX app_links_host ON app_links (host);

-- The tile as the phone drew it (base64 png), served by the gateway as the app's Home Screen icon.
CREATE TABLE app_link_icons (
  link_id TEXT PRIMARY KEY,
  png TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
