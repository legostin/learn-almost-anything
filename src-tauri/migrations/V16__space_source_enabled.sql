-- Per-source enable/disable: a disabled source stays in the space but is
-- excluded from generation context.
ALTER TABLE space_sources ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
