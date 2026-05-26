-- Initial schema for Learn Anything. Mirrors ARCHITECTURE.md §3.1.

CREATE TABLE courses (
    id          TEXT PRIMARY KEY,
    topic       TEXT NOT NULL,
    language    TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE modules (
    id               TEXT PRIMARY KEY,
    course_id        TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    parent_id        TEXT REFERENCES modules(id),
    position         INTEGER NOT NULL,
    title            TEXT NOT NULL,
    summary          TEXT,
    generation_state TEXT NOT NULL
);
CREATE INDEX idx_modules_course ON modules(course_id, parent_id, position);

CREATE TABLE progress (
    module_id      TEXT PRIMARY KEY REFERENCES modules(id) ON DELETE CASCADE,
    test_passed_at INTEGER,
    marked_done_at INTEGER
);

CREATE TABLE jobs (
    id          TEXT PRIMARY KEY,
    course_id   TEXT NOT NULL,
    module_id   TEXT,
    kind        TEXT NOT NULL,
    status      TEXT NOT NULL,
    agent       TEXT NOT NULL,
    started_at  INTEGER,
    finished_at INTEGER,
    log_path    TEXT,
    error       TEXT
);
CREATE INDEX idx_jobs_status ON jobs(status);
