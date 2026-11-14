-- deployment-mode: rolling
-- First-message cleanup (docs/agents.md, "First message"): an older First
-- message is joined to its revision's Instructions (1422), which can make them
-- longer than 20,000 characters: at most the Instructions, a blank line, the
-- "When a chat starts:" line and the First message (20,000 + 2 + 20 + 20,000).
-- This adds the revision bounds again with that Instructions limit, NOT VALID
-- so it takes no long lock; 1420 validates it and 1421 drops the old check.
-- Every row either release writes satisfies both. The API still refuses more
-- than 20,000 characters of Instructions from a person.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_revisions
  ADD CONSTRAINT agent_revisions_content_bounds_check CHECK (
    revision > 0
    AND char_length(btrim(name)) BETWEEN 1 AND 120
    AND char_length(description) <= 280
    AND char_length(instructions) <= 40022
    AND char_length(first_message) <= 20000
    AND (created_by_subject_id IS NULL OR char_length(created_by_subject_id) BETWEEN 1 AND 1024)
  ) NOT VALID;
