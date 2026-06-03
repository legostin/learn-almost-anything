-- Per-course strictness override. NULL = inherit the space's default
-- (spaces.strict_sources). 1 = strict (only the space's sources), 0 = sources
-- are the preferred base but may be supplemented.
ALTER TABLE courses ADD COLUMN strict_sources INTEGER;
