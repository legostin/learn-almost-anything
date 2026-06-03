-- Spaces: knowledge containers that hold sources (sites, repos, documents,
-- images, tables) from which courses can be generated.
CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE space_sources (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  -- 'site' | 'repo' | 'document' | 'image' | 'table'
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  -- url / repo url / original file name
  ref TEXT NOT NULL DEFAULT '',
  -- 'pending' | 'converting' | 'ready' | 'failed'
  status TEXT NOT NULL DEFAULT 'ready',
  -- relative path (under the space dir) to the converted markdown, when any
  md_path TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_space_sources_space ON space_sources(space_id);

-- A course may be scoped to a space; its generation is grounded in that space's
-- sources. NULL = a normal, unscoped course.
ALTER TABLE courses ADD COLUMN space_id TEXT;
