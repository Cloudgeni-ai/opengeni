-- deployment-mode: rolling
-- Align opaque browser generations with the native base64url producer and API.
-- Only widens accepted identifiers; no data rewrite or authority changes.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "attached_browser_inventories"
  DROP CONSTRAINT "attached_browser_inventories_values_check",
  ADD CONSTRAINT "attached_browser_inventories_values_check" CHECK (
    octet_length("bridge_generation") BETWEEN 1 AND 256
    AND "bridge_generation" ~ '^[A-Za-z0-9_-][A-Za-z0-9._:-]*$'
    AND "revision" >= 0
  );

