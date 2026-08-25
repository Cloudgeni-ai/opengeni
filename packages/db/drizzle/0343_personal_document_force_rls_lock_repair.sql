-- deployment-mode: rolling
-- Repair the two personal-Document membership reads shipped by 0258. A
-- row-locking SELECT is also subject to an UPDATE policy; the capability only
-- grants SELECT, so a real NOSUPERUSER/NOBYPASSRLS migration owner saw zero
-- memberships and silently selected the legacy workspace-anchored lane.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- The checker cannot distinguish the function-body source strings below from
-- top-level executable membership probes. Keep the migration owner's own
-- transformation/assertion block inside the house owner-only window; ordinary
-- runtime roles remain RLS-bound throughout and FORCE is restored atomically.
ALTER TABLE organization_memberships NO FORCE ROW LEVEL SECURITY;

DO $repair_personal_document_membership_reads$
DECLARE
  data_schema text := pg_catalog.current_schema();
  function_oid regprocedure;
  definition text;
  repaired text;
  old_fragment text;
  new_fragment text;
BEGIN
  function_oid := pg_catalog.to_regprocedure(
    pg_catalog.format('%I.create_personal_document_authority(uuid,uuid,uuid)', data_schema)
  );
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'create_personal_document_authority is unavailable for repair'
      USING ERRCODE = '55000';
  END IF;
  definition := pg_catalog.pg_get_functiondef(function_oid);
  old_fragment := $old$
      SELECT membership.* INTO member_row
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = caller_subject
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
      FOR SHARE;
$old$;
  new_fragment := $new$
      SELECT membership.* INTO member_row
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = caller_subject
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL;

      -- The plain control probe makes a future command/policy mismatch loud.
      -- With this migration's non-locking read the two predicates are
      -- identical. If a later revision restores a locking read without its
      -- exact policy, the capability-visible control row cannot silently fall
      -- through to the legacy authority lane.
      IF NOT FOUND AND EXISTS (
        SELECT 1
        FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.subject_id = caller_subject
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
      ) THEN
        RAISE EXCEPTION 'personal document membership read was RLS-blinded'
          USING ERRCODE = '55000';
      END IF;
$new$;
  repaired := pg_catalog.replace(definition, old_fragment, new_fragment);
  IF repaired = definition THEN
    RAISE EXCEPTION 'create_personal_document_authority repair shape changed'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE repaired;

  function_oid := pg_catalog.to_regprocedure(
    pg_catalog.format(
      '%I.prepare_session_attempt_personal_document_reads(uuid,uuid,uuid,uuid)',
      data_schema
    )
  );
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'prepare_session_attempt_personal_document_reads is unavailable for repair'
      USING ERRCODE = '55000';
  END IF;
  definition := pg_catalog.pg_get_functiondef(function_oid);
  old_fragment := $old$
      SELECT membership.* INTO member_row
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = initiating_subject
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
      FOR SHARE;
$old$;
  new_fragment := $new$
      SELECT membership.* INTO member_row
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = initiating_subject
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL;

      IF NOT FOUND AND EXISTS (
        SELECT 1
        FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.subject_id = initiating_subject
          AND membership.status = 'active'
          AND membership.revoked_at IS NULL
      ) THEN
        RAISE EXCEPTION 'personal document admission membership read was RLS-blinded'
          USING ERRCODE = '55000';
      END IF;
$new$;
  repaired := pg_catalog.replace(definition, old_fragment, new_fragment);
  IF repaired = definition THEN
    RAISE EXCEPTION 'prepare_session_attempt_personal_document_reads repair shape changed'
      USING ERRCODE = '55000';
  END IF;

  -- The later portable-document scan has the same command mismatch: locking
  -- both documents and authorities makes PostgreSQL require UPDATE-applicable
  -- policies, while this admission capability is intentionally read-only.
  -- Snapshot foreign keys take the durable referential pins at insertion.
  definition := repaired;
  old_fragment := $old$
        ORDER BY document_value.id
        FOR SHARE OF document_value, authority
$old$;
  new_fragment := $new$
        ORDER BY document_value.id
$new$;
  repaired := pg_catalog.replace(definition, old_fragment, new_fragment);
  IF repaired = definition THEN
    RAISE EXCEPTION 'prepare_session_attempt_personal_document_reads document scan repair shape changed'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE repaired;
END
$repair_personal_document_membership_reads$;

ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;

COMMENT ON FUNCTION create_personal_document_authority(uuid, uuid, uuid) IS
  'Creates portable personal Document authority for an exact active organization membership; 0343 removes an RLS-blind row lock and fails loudly on visibility drift.';
COMMENT ON FUNCTION prepare_session_attempt_personal_document_reads(uuid, uuid, uuid, uuid) IS
  'Freezes exact-attempt personal Document reads; 0343 removes RLS-blind membership and portable-document row locks and fails loudly on definition or visibility drift.';
