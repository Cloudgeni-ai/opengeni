-- deployment-mode: rolling
-- The agent suggestion made in a chat (`agent_suggest`): make an agent from
-- this chat, or use an agent that already does the work. The chat shows it as
-- a card until a person acts on it. Display state only: it never makes or
-- changes an agent, and it never reaches the model. NULL means no suggestion.
-- Older binaries never read or write the column.
-- Metadata-only nullable column addition; the bound is added NOT VALID so it
-- holds for new writes without scanning the table under its lock.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_suggestion jsonb;
ALTER TABLE sessions ADD CONSTRAINT sessions_agent_suggestion_bounds
  CHECK (
    agent_suggestion IS NULL
    OR (jsonb_typeof(agent_suggestion) = 'object' AND octet_length(agent_suggestion::text) <= 262144)
  ) NOT VALID;
