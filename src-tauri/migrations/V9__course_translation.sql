-- A translated course is a linked copy: translated_from points at the source
-- course id. NULL = an original (not a translation).
ALTER TABLE courses ADD COLUMN translated_from TEXT;
