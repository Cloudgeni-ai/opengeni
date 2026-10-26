-- deployment-mode: rolling
-- Validate the webhook event-type checks 0930 widened NOT VALID. Every
-- existing subscription already satisfied the narrower list.
ALTER TABLE workspace_webhooks VALIDATE CONSTRAINT workspace_webhooks_event_types_chk;
ALTER TABLE organization_webhooks VALIDATE CONSTRAINT organization_webhooks_event_types_chk;
