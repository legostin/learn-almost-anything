-- Per-course attachment of user-registered MCP servers: JSON array of ids
-- from settings.custom_mcp_servers. Attached servers are spawned for the
-- generation agent during structure/draft stages.
ALTER TABLE courses ADD COLUMN mcp_servers TEXT;
