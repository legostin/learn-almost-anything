-- Per-course generation cost/quality profile (JSON GenerationProfile).
-- NULL means "use the global default profile".
ALTER TABLE courses ADD COLUMN generation_profile TEXT;
