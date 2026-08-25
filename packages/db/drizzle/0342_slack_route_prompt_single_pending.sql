-- deployment-mode: rolling
-- One pending Slack route picker per person per conversation.
--
-- `slack_route_prompts` is unique on `(connection_id, inbox_id)` and
-- `(connection_id, provider_event_id)`, both keyed to the originating event, so
-- Slack's retries of one event cannot post a second card but two DIFFERENT
-- messages each open their own. One person would get two cards for the same
-- question, and answering either would write the route while the other stayed
-- live and answerable.
--
-- The key includes `slack_user_id` on purpose. A shared channel has many people
-- in it, and asking one of them must not swallow another's request: each person
-- is asked once. A direct message is already one channel per person, so the same
-- index covers both surfaces.
--
-- Expiry is not part of the predicate, because `now()` is not immutable and a
-- partial index cannot call it. A timed-out row is settled `expired`
-- opportunistically by the writer before it opens a new prompt, which is what
-- keeps a card nobody ever clicked from holding the slot forever.
--
-- Rolling and safe to build without CONCURRENTLY: the table has no rows and no
-- writer until the picker ships in this same change.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE UNIQUE INDEX "slack_route_prompts_pending_conversation_uq"
  ON "slack_route_prompts" ("connection_id", "slack_channel_id", "slack_user_id")
  WHERE "status" = 'pending';

RESET statement_timeout;
RESET lock_timeout;
