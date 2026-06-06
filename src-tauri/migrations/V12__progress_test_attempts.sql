-- Capture real test performance so spaced repetition can grade honestly.
-- The FIRST graded attempt drives scheduling (retakes can't game it).
ALTER TABLE progress ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE progress ADD COLUMN first_attempt_ratio REAL;
ALTER TABLE progress ADD COLUMN first_attempt_results TEXT; -- JSON bool[] per question
ALTER TABLE progress ADD COLUMN first_attempt_at INTEGER;
