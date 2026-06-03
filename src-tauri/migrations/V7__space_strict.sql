-- Per-space strictness: when 1 (default), a course built in the space may use
-- ONLY its sources. When 0, the sources are the preferred base but the agent may
-- supplement them.
ALTER TABLE spaces ADD COLUMN strict_sources INTEGER NOT NULL DEFAULT 1;
