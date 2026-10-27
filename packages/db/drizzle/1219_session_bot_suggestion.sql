-- deployment-mode: rolling
-- The newest bot suggestion the agent made in a chat (`bot_suggest`): make this
-- chat a bot, or reuse a bot chat or template that already does the work. The
-- chat shows it as a card until a person acts on it. Display state only: it
-- never changes the chat or saves a template, and it never reaches the model.
-- NULL means no suggestion. Older binaries never read or write the column.
-- Metadata-only nullable column addition; the bound is added NOT VALID so it
-- holds for new writes without scanning the table under its lock.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS bot_suggestion jsonb;
ALTER TABLE sessions ADD CONSTRAINT sessions_bot_suggestion_bounds
  CHECK (
    bot_suggestion IS NULL
    OR (jsonb_typeof(bot_suggestion) = 'object' AND octet_length(bot_suggestion::text) <= 65536)
  ) NOT VALID;
