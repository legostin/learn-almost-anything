-- Per-course agent backend selection (claude | codex).
ALTER TABLE courses ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude';
