-- deployment-mode: rolling
--
-- Give Codex cooldowns typed provenance plus an independent revision. A fresh
-- provider usage read may then clear only the exact quota cooldown it observed
-- before the request; generic backpressure and a concurrently newer refusal
-- remain authoritative. Legacy writers do not know these columns, so the
-- trigger advances the revision and removes typed auto-clear authority whenever
-- they change exhausted_until alone during a rolling deployment.

ALTER TABLE "codex_subscription_credentials"
  ADD COLUMN "exhausted_kind" text,
  ADD COLUMN "exhausted_revision" bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT "codex_credentials_exhausted_kind_chk" CHECK (
    ("exhausted_until" IS NULL AND "exhausted_kind" IS NULL)
    OR (
      "exhausted_until" IS NOT NULL
      AND ("exhausted_kind" IS NULL OR "exhausted_kind" IN ('quota', 'rate_limit'))
    )
  );

CREATE OR REPLACE FUNCTION opengeni_private.codex_cooldown_revision_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF NEW.exhausted_until IS DISTINCT FROM OLD.exhausted_until THEN
    IF NEW.exhausted_revision = OLD.exhausted_revision THEN
      -- Compatibility path for a pre-0382 writer: retain the cooldown but do
      -- not let a new usage reader mistake its unknown cause for quota.
      NEW.exhausted_kind := NULL;
      NEW.exhausted_revision := OLD.exhausted_revision + 1;
    ELSIF NEW.exhausted_revision <> OLD.exhausted_revision + 1 THEN
      RAISE EXCEPTION 'Codex cooldown revision must advance exactly once';
    END IF;
  ELSIF NEW.exhausted_kind IS DISTINCT FROM OLD.exhausted_kind
    OR NEW.exhausted_revision IS DISTINCT FROM OLD.exhausted_revision
  THEN
    IF NEW.exhausted_revision <> OLD.exhausted_revision + 1 THEN
      RAISE EXCEPTION 'Codex cooldown metadata revision must advance exactly once';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION opengeni_private.codex_cooldown_revision_guard() FROM PUBLIC;

CREATE TRIGGER codex_cooldown_revision_guard
  BEFORE UPDATE OF exhausted_until, exhausted_kind, exhausted_revision
  ON "codex_subscription_credentials"
  FOR EACH ROW
  EXECUTE FUNCTION opengeni_private.codex_cooldown_revision_guard();
