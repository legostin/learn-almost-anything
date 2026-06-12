-- Roadmaps: a learning route from a goal/topic — vertical stages of node
-- cards, each carrying curated sources and a set of skills. Skills link to
-- generated lessons/courses via courses.roadmap_id / courses.roadmap_skill.
CREATE TABLE roadmaps (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  title TEXT,
  language TEXT NOT NULL,
  -- 'wizard' | 'generating' | 'ready' | 'failed'
  status TEXT NOT NULL DEFAULT 'wizard',
  agent TEXT NOT NULL DEFAULT 'claude',
  -- Whole roadmap body as JSON: { stages: [{ id, title, summary, nodes: [...] }] }
  content TEXT,
  -- Persisted adaptive-wizard dialog JSON (answered/current/done/pending)
  wizard TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Manual "I already know this" marks only: automatic completion is computed
-- live from linked courses and never persisted.
CREATE TABLE roadmap_skill_done (
  roadmap_id TEXT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (roadmap_id, skill_id)
);

ALTER TABLE courses ADD COLUMN roadmap_id TEXT;
ALTER TABLE courses ADD COLUMN roadmap_skill TEXT;
CREATE INDEX idx_courses_roadmap ON courses(roadmap_id);
