-- Mi Media Content Lab database (Cloudflare D1). Files themselves live in the FILES KV namespace.
-- Apply: npx wrangler d1 execute mi-media-lab --remote --file cloudflare/schema.sql

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '{}',      -- JSON: about, voice, colours, topics, default logo, ...
  created TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- logo | reference | photo
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',         -- how to use it, read by the brain
  file_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',   -- JSON: logo width, handle
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS assets_project ON assets(project_id);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,                  -- queued | working | draft | approved | removed | failed
  job TEXT NOT NULL DEFAULT 'new',       -- what the brain must do: new | picture | text
  topic TEXT NOT NULL DEFAULT '',
  aspect TEXT NOT NULL DEFAULT '4:5',
  logo_id TEXT NOT NULL DEFAULT '',      -- asset id, 'none', or '' for the project default
  photo_id TEXT NOT NULL DEFAULT '',     -- own photo asset id
  headline TEXT NOT NULL DEFAULT '',
  subtext TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  hashtags TEXT NOT NULL DEFAULT '[]',
  image_prompt TEXT NOT NULL DEFAULT '',
  background_key TEXT NOT NULL DEFAULT '',
  post_key TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  claimed_at TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_project ON posts(project_id, created);
CREATE INDEX IF NOT EXISTS posts_status ON posts(status, created);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,                  -- you | brain | feedback
  note TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_project ON memory(project_id, created);

CREATE TABLE IF NOT EXISTS helper (
  id TEXT PRIMARY KEY,                   -- 'pc'
  last_seen TEXT NOT NULL,
  info TEXT NOT NULL DEFAULT '{}'        -- JSON: PC storage numbers, current job
);
