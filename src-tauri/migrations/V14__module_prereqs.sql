-- Soft prerequisites for non-linear courses: a JSON array of earlier submodule
-- titles this submodule benefits from studying first. NULL/empty for linear
-- courses. Used only to render a non-blocking "study first" hint in the reader.
ALTER TABLE modules ADD COLUMN prereqs TEXT;
