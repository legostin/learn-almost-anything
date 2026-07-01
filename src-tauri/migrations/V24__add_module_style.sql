-- Per-lesson writing-style override. NULL = inherit the course style. When set,
-- this style id wins over the course's `generation_profile.style_id` at
-- (re)generation time for this submodule only. Set via the lesson's style modal.
ALTER TABLE modules ADD COLUMN style_id TEXT;
