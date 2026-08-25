-- deployment-mode: rolling
-- One pending Slack route picker per conversation.
--
-- `slack_route_prompts` is unique on `(connection_id, inbox_id)` and
-- `(connection_id, provider_event_id)`, both keyed to the originating event, so
-- Slack's retries of one event cannot post a second card but two DIFFERENT
-- messages in the same channel each open their own. The person would get two
-- cards for the same question, and answering either would write the channel's
-- route while the other stayed live and answerable.
--
-- A direct message needs no separate index: a DM's channel id is already one
-- per person, so the channel predicate covers both surfaces.
--
-- Rolling and safe to build without CONCURRENTLY: the table has no rows and no
-- writer until the picker ships in this same change.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE UNIQUE INDEX "slack_route_prompts_pending_channel_uq"
  ON "slack_route_prompts" ("connection_id", "slack_channel_id")
  WHERE "status" = 'pending';

RESET statement_timeout;
RESET lock_timeout;
