-- Subject category, assigned by the agent during structure generation.
-- Nullable: NULL until the course has been classified.
ALTER TABLE courses ADD COLUMN category TEXT;
