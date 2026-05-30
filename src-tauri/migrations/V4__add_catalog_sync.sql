-- Public catalog identity and sync version.
ALTER TABLE courses ADD COLUMN catalog_origin_id TEXT;
ALTER TABLE courses ADD COLUMN catalog_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE courses ADD COLUMN catalog_synced_at INTEGER;

CREATE UNIQUE INDEX idx_courses_catalog_origin
ON courses(catalog_origin_id)
WHERE catalog_origin_id IS NOT NULL;
