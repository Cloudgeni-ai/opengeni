-- deployment-mode: rolling
-- Keep a short, bounded history of why each attached browser profile's
-- extension connection generations ended. Every generation change ends the
-- profile's live browser sessions, so the reason (Chrome closed the port, the
-- native host vanished, the agent rejected a message, the agent restarted)
-- must outlive pod logs. Additive column with a constant default; no rewrite.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "attached_browser_devices"
  ADD COLUMN "connection_history" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT "attached_browser_devices_connection_history_check" CHECK (
    jsonb_typeof("connection_history") = 'array'
    AND jsonb_array_length("connection_history") <= 50
    AND octet_length("connection_history"::text) <= 65536
  );
