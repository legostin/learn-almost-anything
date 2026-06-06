-- Spaced-repetition schedule, one row per submodule (its MCQ set is the card).
-- SM-2 state; due_at drives the Review screen and the reviewDue counter.
CREATE TABLE reviews (
    submodule_id     TEXT PRIMARY KEY REFERENCES modules(id) ON DELETE CASCADE,
    course_id        TEXT NOT NULL,
    due_at           INTEGER NOT NULL,
    interval_days    REAL NOT NULL DEFAULT 0,
    ease             REAL NOT NULL DEFAULT 2.5,
    reps             INTEGER NOT NULL DEFAULT 0,
    lapses           INTEGER NOT NULL DEFAULT 0,
    last_reviewed_at INTEGER
);
CREATE INDEX idx_reviews_due ON reviews(course_id, due_at);
