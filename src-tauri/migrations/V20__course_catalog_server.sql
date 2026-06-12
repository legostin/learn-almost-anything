-- Which catalog server this course was imported from / publishes to.
-- NULL = the public default catalog.
ALTER TABLE courses ADD COLUMN catalog_server_url TEXT;
