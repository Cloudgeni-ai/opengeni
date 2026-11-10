-- deployment-mode: rolling
-- A Teams message records the turn that answers it (turn_id, set when the
-- message is admitted) and when that turn's reply, request for input or
-- failure was queued for Teams (replied_at). The bot shows a typing
-- indicator until then, so one person's message in a busy group chat isn't
-- reported as answered when an earlier turn finishes.
--
-- Rolling: the previous release never reads or writes these columns; rows it
-- admits have no turn and fall back to the chat-level rule.
SET LOCAL lock_timeout = '5s';

ALTER TABLE teams_bot_inbox ADD COLUMN IF NOT EXISTS turn_id uuid;
ALTER TABLE teams_bot_inbox ADD COLUMN IF NOT EXISTS replied_at timestamp with time zone;
COMMENT ON COLUMN teams_bot_inbox.turn_id IS 'The session turn that answers this message; NULL until admitted, and for messages admitted by older releases.';
COMMENT ON COLUMN teams_bot_inbox.replied_at IS 'When that turn''s reply, request for input or failure was queued for Teams.';
