-- deployment-mode: rolling
-- Align opaque browser generations with the native base64url producer and API.
-- Only widens accepted identifiers; no data rewrite or authority changes.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "attached_browser_devices"
  DROP CONSTRAINT "attached_browser_devices_values_check",
  ADD CONSTRAINT "attached_browser_devices_values_check" CHECK (
    octet_length("name") BETWEEN 1 AND 200
    AND "name" = btrim("name")
    AND ("profile_label" IS NULL OR (
      octet_length("profile_label") BETWEEN 1 AND 200
      AND "profile_label" = btrim("profile_label")
    ))
    AND octet_length("browser_name") BETWEEN 1 AND 100
    AND "browser_name" = btrim("browser_name")
    AND octet_length("browser_version") BETWEEN 1 AND 256
    AND "browser_version" = btrim("browser_version")
    AND octet_length("extension_version") BETWEEN 1 AND 256
    AND "extension_version" = btrim("extension_version")
    AND octet_length("connection_generation") BETWEEN 1 AND 256
    AND "connection_generation" ~ '^[A-Za-z0-9._:-]+$'
    AND "inventory_revision" >= 0
    AND "tab_count" BETWEEN 0 AND 100000
    AND jsonb_typeof("capabilities") = 'object'
    AND octet_length("capabilities"::text) BETWEEN 2 AND 65536
  );

ALTER TABLE "attached_browser_inventories"
  DROP CONSTRAINT "attached_browser_inventories_values_check",
  ADD CONSTRAINT "attached_browser_inventories_values_check" CHECK (
    octet_length("bridge_generation") BETWEEN 1 AND 256
    AND "bridge_generation" ~ '^[A-Za-z0-9._:-]+$'
    AND "revision" >= 0
  );

