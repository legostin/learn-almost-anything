-- Per-page generation instructions for documentation lessons: free-form
-- "what to write on this page" directions, kept separate from the reader-facing
-- `summary`. NULL = none. Set/edited via the doc lesson generation modal and
-- read back into the draft prompt at (re)generation time.
ALTER TABLE modules ADD COLUMN instructions TEXT;
