-- deployment-mode: rolling
-- Validate the event-type checks 0954 widened NOT VALID. Every existing row
-- already satisfied the narrower lists.
ALTER TABLE recording_events VALIDATE CONSTRAINT recording_events_type_chk;
ALTER TABLE workspace_webhooks VALIDATE CONSTRAINT workspace_webhooks_event_types_chk;
ALTER TABLE organization_webhooks VALIDATE CONSTRAINT organization_webhooks_event_types_chk;
