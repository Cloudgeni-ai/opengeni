-- deployment-mode: rolling
-- Activate the existing Slice-A session tenancy facts at the accepted-attempt
-- boundary. This migration is additive: legacy rows remain workspace-shared at
-- epoch 1, while new claim writers persist the exact session authority they
-- admitted.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "session_turn_attempts"
  ADD COLUMN IF NOT EXISTS "authority_epoch" integer,
  ADD COLUMN IF NOT EXISTS "authority_visibility" text,
  ADD COLUMN IF NOT EXISTS "authority_owner_organization_membership_id" uuid;

UPDATE "session_turn_attempts" attempts
SET
  authority_epoch = sessions.authority_epoch,
  authority_visibility = sessions.visibility,
  authority_owner_organization_membership_id = sessions.owner_organization_membership_id
FROM "sessions" sessions
WHERE sessions.workspace_id = attempts.workspace_id
  AND sessions.id = attempts.session_id;

DO $session_visibility_attempt_compatibility$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.session_turn_attempts_fill_authority_snapshot()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    DECLARE
      workspace_marker boolean;
      source_epoch integer;
      source_visibility text;
      source_owner uuid;
    BEGIN
      SELECT true
      INTO STRICT workspace_marker
      FROM %1$I.workspaces workspace_row
      WHERE workspace_row.id = NEW.workspace_id
        AND workspace_row.account_id = NEW.account_id
      FOR KEY SHARE;

      SELECT
        source.authority_epoch,
        source.visibility,
        source.owner_organization_membership_id
      INTO STRICT source_epoch, source_visibility, source_owner
      FROM %1$I.sessions source
      WHERE source.workspace_id = NEW.workspace_id
        AND source.account_id = NEW.account_id
        AND source.id = NEW.session_id
      FOR UPDATE;

      NEW.authority_epoch := source_epoch;
      NEW.authority_visibility := source_visibility;
      NEW.authority_owner_organization_membership_id := source_owner;
      RETURN NEW;
    EXCEPTION
      WHEN NO_DATA_FOUND THEN
        RAISE EXCEPTION 'session authority snapshot source workspace/session not found: %%/%%',
          NEW.workspace_id, NEW.session_id
          USING ERRCODE = '23503';
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'DROP TRIGGER IF EXISTS session_turn_attempts_fill_authority_snapshot_trg ON %I.session_turn_attempts',
    data_schema
  );
  EXECUTE format($ddl$
    CREATE TRIGGER session_turn_attempts_fill_authority_snapshot_trg
    BEFORE INSERT ON %1$I.session_turn_attempts
    FOR EACH ROW
    WHEN (
      NEW.authority_epoch IS NULL
      AND NEW.authority_visibility IS NULL
      AND NEW.authority_owner_organization_membership_id IS NULL
    )
    EXECUTE FUNCTION %1$I.session_turn_attempts_fill_authority_snapshot()
  $ddl$, data_schema);
END;
$session_visibility_attempt_compatibility$;

ALTER TABLE "session_turn_attempts"
  ADD CONSTRAINT "session_turn_attempts_authority_epoch_check"
    CHECK (
      "authority_epoch" IS NOT NULL
      AND "authority_visibility" IS NOT NULL
      AND "authority_epoch" > 0
    ) NOT VALID,
  ADD CONSTRAINT "session_turn_attempts_authority_visibility_check"
    CHECK (
      "authority_epoch" IS NOT NULL
      AND "authority_visibility" IS NOT NULL
      AND "authority_visibility" IN ('user_private', 'workspace_shared')
    ) NOT VALID,
  ADD CONSTRAINT "session_turn_attempts_authority_owner_shape_check"
    CHECK (
      "authority_visibility" <> 'user_private'
      OR "authority_owner_organization_membership_id" IS NOT NULL
    ) NOT VALID,
  ADD CONSTRAINT "session_turn_attempts_authority_owner_fk"
    FOREIGN KEY ("authority_owner_organization_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id")
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE "session_turn_attempts"
  VALIDATE CONSTRAINT "session_turn_attempts_authority_epoch_check",
  VALIDATE CONSTRAINT "session_turn_attempts_authority_visibility_check",
  VALIDATE CONSTRAINT "session_turn_attempts_authority_owner_shape_check",
  VALIDATE CONSTRAINT "session_turn_attempts_authority_owner_fk";

ALTER TABLE "session_turn_attempts"
  ALTER COLUMN "authority_epoch" SET NOT NULL,
  ALTER COLUMN "authority_visibility" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "session_turn_attempts_authority_epoch_idx"
  ON "session_turn_attempts" ("workspace_id", "session_id", "authority_epoch");

DO $session_visibility_attempt_immutability$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.session_turn_attempts_guard_authority_snapshot_immutable()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    BEGIN
      IF NEW.authority_epoch IS DISTINCT FROM OLD.authority_epoch
        OR NEW.authority_visibility IS DISTINCT FROM OLD.authority_visibility
        OR NEW.authority_owner_organization_membership_id IS DISTINCT FROM OLD.authority_owner_organization_membership_id
      THEN
        RAISE EXCEPTION 'session turn attempt authority snapshot is immutable'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'DROP TRIGGER IF EXISTS session_turn_attempts_guard_authority_snapshot_immutable_trg ON %I.session_turn_attempts',
    data_schema
  );
  EXECUTE format($ddl$
    CREATE TRIGGER session_turn_attempts_guard_authority_snapshot_immutable_trg
    BEFORE UPDATE OF authority_epoch, authority_visibility, authority_owner_organization_membership_id
      ON %1$I.session_turn_attempts
    FOR EACH ROW
    EXECUTE FUNCTION %1$I.session_turn_attempts_guard_authority_snapshot_immutable()
  $ddl$, data_schema);
END;
$session_visibility_attempt_immutability$;
