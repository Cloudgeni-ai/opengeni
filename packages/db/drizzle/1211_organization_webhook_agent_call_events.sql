-- deployment-mode: rolling
-- Organization webhooks fan out an organization's session events, but agent
-- call events (`session.agentCall.ringing`, `session.agentCall.settled`) were
-- workspace-only: the organization check left them out, so subscribing an
-- organization endpoint to them passed request validation and then failed
-- the check with an internal error. A product that embeds Opengeni with a
-- workspace per customer or person keeps one organization endpoint for
-- session events (notifications included), and needs its calls there too.
--
-- Both call types become subscribable on organization endpoints. The shared
-- payload builder already carries the call fields for either lane, and the
-- organization enqueue already skips personal workspaces. Usage events stay
-- workspace-only. Existing registrations are unchanged; an endpoint receives
-- call events once it subscribes.
--
-- The previous release never subscribes an organization endpoint to the call
-- types, so it neither creates nor reads such deliveries. The check is added
-- NOT VALID because every existing row already satisfies the narrower list.
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

RESET statement_timeout;
RESET lock_timeout;
