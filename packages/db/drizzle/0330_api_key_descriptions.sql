-- deployment-mode: rolling
-- Human-readable API-key descriptions let workspace administrators record the
-- intended caller or automation without exposing the secret token. Existing
-- keys remain valid and return a NULL description.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "api_keys"
  ADD COLUMN "description" text;

ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_description_check"
  CHECK ("description" IS NULL OR length("description") BETWEEN 1 AND 500)
  NOT VALID;

ALTER TABLE "api_keys"
  VALIDATE CONSTRAINT "api_keys_description_check";

RESET statement_timeout;
RESET lock_timeout;
