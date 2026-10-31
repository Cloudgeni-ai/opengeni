-- deployment-mode: rolling
-- Organization webhooks can carry session.agentCall.ringing and
-- session.agentCall.settled, like workspace webhooks since 1107.
--
-- A product that embeds Opengeni and rings its own app for agent calls
-- (docs/design/agent-calls.md) usually serves many workspaces from one
-- organization endpoint, the same endpoint that already receives
-- session.notification.posted for those people. The API and the public event
-- vocabulary already accepted the call types on organization webhooks, but
-- this table's check refused them, so subscribing failed with an internal
-- error and the ringing never reached the product.
--
-- Delivery is unchanged: the organization trigger function already builds the
-- call payload for any lane and skips Personal workspaces. Existing
-- registrations are unchanged until they subscribe. The previous release
-- never subscribes an organization endpoint to these types, and the check is
-- added NOT VALID because every existing row already satisfies the narrower
-- list (1172_organization_webhook_agent_calls).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE organization_webhooks DROP CONSTRAINT organization_webhooks_event_types_chk;
ALTER TABLE organization_webhooks ADD CONSTRAINT organization_webhooks_event_types_chk CHECK (
  cardinality(event_types) BETWEEN 1 AND 32 AND event_types <@ ARRAY[
    'turn.completed','turn.failed','turn.cancelled','turn.superseded','session.status.changed',
    'session.requiresAction','session.humanInput.requested',
    'session.notification.posted','session.notification.withdrawn',
    'session.agentCall.ringing','session.agentCall.settled',
    'recording.started','recording.finished','recording.transcript.ready',
    'recording.transcript.failed','recording.transcript.current_changed',
    'recording.speakers.updated','recording.notes.updated','recording.deleted'
  ]::text[]
) NOT VALID;

DROP TRIGGER session_events_organization_webhook_enqueue_v1 ON session_events;
CREATE TRIGGER session_events_organization_webhook_enqueue_v1
AFTER INSERT ON session_events FOR EACH ROW
WHEN (NEW.duplicate_of_event_id IS NULL AND NEW.type IN (
  'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.superseded', 'session.status.changed',
  'session.requiresAction', 'session.humanInput.requested',
  'session.notification.posted', 'session.notification.withdrawn',
  'session.agentCall.ringing', 'session.agentCall.settled'
))
EXECUTE FUNCTION opengeni_private.enqueue_organization_webhook_deliveries_v1();
