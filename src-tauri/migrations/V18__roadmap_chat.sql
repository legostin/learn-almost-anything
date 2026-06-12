-- Roadmap refinement chat: JSON array of messages
-- [{id, ts, role: 'user'|'agent', text, content?, accepted?}] — agent messages
-- may carry a proposed replacement RoadmapContent.
ALTER TABLE roadmaps ADD COLUMN chat TEXT;
