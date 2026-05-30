-- Generated display title for a course. `topic` remains the user's learning brief.
ALTER TABLE courses ADD COLUMN title TEXT;

-- Existing courses were created before title generation existed, so preserve
-- their current visible names.
UPDATE courses SET title = topic WHERE title IS NULL OR trim(title) = '';
