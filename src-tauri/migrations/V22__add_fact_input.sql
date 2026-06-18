-- Fact-check lessons store the verifiable fact (optional URL + uploaded image
-- reference) as JSON. The claim text itself lives in the existing `topic`
-- column; this holds only the extra attachments.
ALTER TABLE courses ADD COLUMN fact_input TEXT;
