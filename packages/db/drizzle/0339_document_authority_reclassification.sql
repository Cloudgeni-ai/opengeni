-- deployment-mode: rolling
-- Explicit, replay-safe Document authority reclassification and resumable
-- Default collection backfill. Existing authority is never rewritten by this
-- migration: legacy workspace rows stay workspace-scoped and legacy personal
-- rows stay anchored to their original workspace until this lifecycle is
-- called with an exact expected tuple.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE document_authority_reclassifications (
  operation_id uuid PRIMARY KEY,
  input_hash text NOT NULL,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE RESTRICT,
  request_workspace_id uuid NOT NULL,
  document_id uuid NOT NULL,
  actor_subject_id text NOT NULL,
  previous_authority_kind text NOT NULL,
  previous_authority_workspace_id uuid,
  previous_authority_subject_id text,
  previous_authority_id uuid,
  previous_owner_organization_membership_id uuid,
  resulting_authority_kind text NOT NULL,
  resulting_authority_workspace_id uuid,
  resulting_authority_subject_id text,
  resulting_authority_id uuid,
  resulting_owner_organization_membership_id uuid,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The receipt is workspace-owned evidence, so it dies with its workspace.
  -- RESTRICT here would make any workspace in which a single Document was ever
  -- reclassified permanently undeletable: `deleteWorkspaceIfQuiescent` relies on
  -- cascades and has no quiescence branch for these tables, so the FK would
  -- surface as an untyped 500 on `DELETE /v1/workspaces/:workspaceId` rather
  -- than a typed status. The row-level immutability trigger below still refuses
  -- every direct rewrite; only the referential cascade may remove it.
  CONSTRAINT document_authority_reclassifications_workspace_fk
    FOREIGN KEY (request_workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT document_authority_reclassifications_hash_chk CHECK (
    input_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT document_authority_reclassifications_actor_chk CHECK (
    actor_subject_id = btrim(actor_subject_id)
    AND octet_length(convert_to(actor_subject_id, 'UTF8')) BETWEEN 1 AND 1024
  ),
  CONSTRAINT document_authority_reclassifications_kind_chk CHECK (
    previous_authority_kind IN ('organization', 'workspace', 'personal')
    AND resulting_authority_kind IN ('organization', 'workspace', 'personal')
  ),
  CONSTRAINT document_authority_reclassifications_result_chk CHECK (
    jsonb_typeof(result) = 'object'
  )
);
CREATE INDEX document_authority_reclassifications_document_idx
  ON document_authority_reclassifications (
    account_id, request_workspace_id, document_id, created_at, operation_id
  );

CREATE TABLE document_default_collection_backfill_runs (
  run_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE RESTRICT,
  actor_subject_id text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  last_workspace_id uuid,
  processed_count integer NOT NULL DEFAULT 0,
  created_count integer NOT NULL DEFAULT 0,
  adopted_count integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT document_default_collection_backfill_runs_actor_chk CHECK (
    actor_subject_id = btrim(actor_subject_id)
    AND octet_length(convert_to(actor_subject_id, 'UTF8')) BETWEEN 1 AND 1024
  ),
  CONSTRAINT document_default_collection_backfill_runs_status_chk CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL)
  ),
  CONSTRAINT document_default_collection_backfill_runs_count_chk CHECK (
    processed_count >= 0 AND created_count >= 0 AND adopted_count >= 0
    AND processed_count = created_count + adopted_count
  )
);

CREATE TABLE document_default_collection_backfill_operations (
  operation_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES document_default_collection_backfill_runs(run_id)
    ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE RESTRICT,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT document_default_collection_backfill_operations_hash_chk CHECK (
    input_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT document_default_collection_backfill_operations_result_chk CHECK (
    jsonb_typeof(result) = 'object'
  )
);

CREATE TABLE document_default_collection_backfill_receipts (
  run_id uuid NOT NULL REFERENCES document_default_collection_backfill_runs(run_id)
    ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  -- CASCADE on both parents. One admin-triggered backfill writes a receipt for
  -- EVERY workspace in the account, so RESTRICT would pin the whole account as
  -- undeletable after a single run - and `document_bases.workspace_id` already
  -- cascades, so a RESTRICT on `base_id` would block that cascade too. The
  -- receipt describes a collection inside the workspace; once the workspace,
  -- its bases, and its documents are gone the receipt is evidence about
  -- nothing. Direct rewrites stay refused by the immutability trigger below.
  base_id uuid NOT NULL REFERENCES document_bases(id) ON DELETE CASCADE,
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (run_id, workspace_id),
  CONSTRAINT document_default_collection_backfill_receipts_workspace_fk
    FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT document_default_collection_backfill_receipts_outcome_chk CHECK (
    outcome IN ('created', 'adopted')
  )
);

CREATE TABLE opengeni_private.document_migration_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  capability_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (backend_pid, transaction_id, capability_kind),
  CONSTRAINT document_migration_capabilities_kind_chk CHECK (
    capability_kind IN ('reclassify', 'default_backfill')
  )
);
REVOKE ALL ON TABLE opengeni_private.document_migration_capabilities FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.document_migration_capability_active(
  p_capability_kind text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
  SELECT EXISTS (
    SELECT 1
    FROM opengeni_private.document_migration_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability.capability_kind = p_capability_kind
  )
$body$;
REVOKE ALL ON FUNCTION
  opengeni_private.document_migration_capability_active(text) FROM PUBLIC;

ALTER TABLE document_authority_reclassifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_authority_reclassifications FORCE ROW LEVEL SECURITY;
ALTER TABLE document_default_collection_backfill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_default_collection_backfill_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE document_default_collection_backfill_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_default_collection_backfill_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE document_default_collection_backfill_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_default_collection_backfill_receipts FORCE ROW LEVEL SECURITY;

DO $document_migration_policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
  table_name text;
BEGIN
  EXECUTE format(
    'CREATE POLICY document_reclassification_actor_read ON %I.document_authority_reclassifications '
      || 'FOR SELECT USING (account_id = nullif(current_setting(''opengeni.account_id'', true), '''')::uuid '
      || 'AND request_workspace_id = nullif(current_setting(''opengeni.workspace_id'', true), '''')::uuid '
      || 'AND actor_subject_id = nullif(current_setting(''opengeni.subject_id'', true), ''''))',
    data_schema
  );

  FOREACH table_name IN ARRAY ARRAY[
    'document_authority_reclassifications',
    'document_default_collection_backfill_runs',
    'document_default_collection_backfill_operations',
    'document_default_collection_backfill_receipts'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY document_migration_lifecycle ON %I.%I '
        || 'USING (current_user = %L AND opengeni_private.document_migration_capability_active('
        || 'CASE WHEN %L = ''document_authority_reclassifications'' THEN ''reclassify'' '
        || 'ELSE ''default_backfill'' END)) '
        || 'WITH CHECK (current_user = %L AND opengeni_private.document_migration_capability_active('
        || 'CASE WHEN %L = ''document_authority_reclassifications'' THEN ''reclassify'' '
        || 'ELSE ''default_backfill'' END))',
      data_schema, table_name, migration_owner, table_name, migration_owner, table_name
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['documents', 'document_chunks'] LOOP
    EXECUTE format(
      'CREATE POLICY document_reclassification_lifecycle ON %I.%I '
        || 'USING (current_user = %L AND '
        || 'opengeni_private.document_migration_capability_active(''reclassify'')) '
        || 'WITH CHECK (current_user = %L AND '
        || 'opengeni_private.document_migration_capability_active(''reclassify''))',
      data_schema, table_name, migration_owner, migration_owner
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['workspaces', 'document_bases'] LOOP
    EXECUTE format(
      'CREATE POLICY document_default_backfill_lifecycle ON %I.%I '
        || 'USING (current_user = %L AND '
        || 'opengeni_private.document_migration_capability_active(''default_backfill'')) '
        || 'WITH CHECK (current_user = %L AND '
        || 'opengeni_private.document_migration_capability_active(''default_backfill''))',
      data_schema, table_name, migration_owner, migration_owner
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'organization_user_resource_authorities',
    'organization_user_resource_grants'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY document_reclassification_lifecycle ON %I.%I '
        || 'USING (current_user = %L AND '
        || 'opengeni_private.document_migration_capability_active(''reclassify'')) '
        || 'WITH CHECK (current_user = %L AND '
        || 'opengeni_private.document_migration_capability_active(''reclassify''))',
      data_schema, table_name, migration_owner, migration_owner
    );
  END LOOP;
END
$document_migration_policies$;

CREATE FUNCTION opengeni_private.reject_document_migration_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  -- A receipt is never rewritten and is never removed on its own. The single
  -- exception is the referential cascade of an owning parent (its workspace, or
  -- the Default base that workspace cascade already removes), which is what
  -- keeps `DELETE /v1/workspaces/:workspaceId` working after this migration's
  -- lifecycle has run. `pg_trigger_depth()` is the exact, RLS-immune
  -- discriminator: a direct statement enters this trigger at depth 1, while a
  -- referential action is itself executed from the parent's constraint trigger
  -- and therefore enters at depth 2 or deeper. Checking whether the parent row
  -- still exists would NOT work here - this trigger runs as the invoking role,
  -- and `workspaces` looks empty to a FORCE-RLS-bound owner with no tenant GUC.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'document migration receipts are immutable' USING ERRCODE = '55000';
END
$body$;
-- House pattern for an `opengeni_private` trigger function: it is invoked by the
-- trigger, never called directly, so leaving it PUBLIC-executable widens the
-- grant surface for no reason. `0333_session_turn_prompt_routing.sql` revokes
-- its equivalent the same way, and the dedicated editable-artifact materializer
-- role's grant enumeration pins exactly this.
REVOKE ALL ON FUNCTION opengeni_private.reject_document_migration_receipt_mutation() FROM PUBLIC;

CREATE TRIGGER document_authority_reclassifications_immutable
BEFORE UPDATE OR DELETE ON document_authority_reclassifications
FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_document_migration_receipt_mutation();
CREATE TRIGGER document_default_collection_backfill_operations_immutable
BEFORE UPDATE OR DELETE ON document_default_collection_backfill_operations
FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_document_migration_receipt_mutation();
CREATE TRIGGER document_default_collection_backfill_receipts_immutable
BEFORE UPDATE OR DELETE ON document_default_collection_backfill_receipts
FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_document_migration_receipt_mutation();

CREATE OR REPLACE FUNCTION opengeni_private.apply_document_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $body$
DECLARE
  reclassification_allowed boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.authority_kind IS DISTINCT FROM OLD.authority_kind
    OR NEW.authority_workspace_id IS DISTINCT FROM OLD.authority_workspace_id
    OR NEW.authority_subject_id IS DISTINCT FROM OLD.authority_subject_id
    OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
    OR NEW.owner_organization_membership_id
      IS DISTINCT FROM OLD.owner_organization_membership_id
    OR NEW.origin_workspace_id IS DISTINCT FROM OLD.origin_workspace_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.visibility IS DISTINCT FROM OLD.visibility
  ) THEN
    IF opengeni_private.document_migration_capability_active('reclassify') THEN
      SELECT EXISTS (
        SELECT 1
        FROM document_authority_reclassifications receipt
        WHERE receipt.document_id = OLD.id
          AND receipt.account_id = OLD.account_id
          AND receipt.previous_authority_kind = OLD.authority_kind
          AND receipt.previous_authority_workspace_id
            IS NOT DISTINCT FROM OLD.authority_workspace_id
          AND receipt.previous_authority_subject_id
            IS NOT DISTINCT FROM OLD.authority_subject_id
          AND receipt.previous_authority_id IS NOT DISTINCT FROM OLD.authority_id
          AND receipt.previous_owner_organization_membership_id
            IS NOT DISTINCT FROM OLD.owner_organization_membership_id
          AND receipt.resulting_authority_kind = NEW.authority_kind
          AND receipt.resulting_authority_workspace_id
            IS NOT DISTINCT FROM NEW.authority_workspace_id
          AND receipt.resulting_authority_subject_id
            IS NOT DISTINCT FROM NEW.authority_subject_id
          AND receipt.resulting_authority_id IS NOT DISTINCT FROM NEW.authority_id
          AND receipt.resulting_owner_organization_membership_id
            IS NOT DISTINCT FROM NEW.owner_organization_membership_id
      ) INTO reclassification_allowed;
    END IF;
    IF NOT reclassification_allowed
      OR NEW.origin_workspace_id IS DISTINCT FROM OLD.origin_workspace_id
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
    THEN
      RAISE EXCEPTION 'document authority is immutable';
    END IF;
  END IF;
  IF NEW.authority_kind IS NULL OR (
    NEW.authority_kind = 'workspace'
    AND NEW.authority_workspace_id IS NULL
    AND NEW.visibility = 'private'
  ) THEN
    NEW.authority_kind := CASE
      WHEN NEW.visibility = 'private' THEN 'personal'
      ELSE 'workspace'
    END;
  END IF;
  NEW.origin_workspace_id := NEW.workspace_id;
  CASE NEW.authority_kind
    WHEN 'organization' THEN
      NEW.authority_workspace_id := NULL;
      NEW.authority_subject_id := NULL;
      NEW.authority_id := NULL;
      NEW.owner_organization_membership_id := NULL;
      NEW.visibility := 'workspace';
    WHEN 'workspace' THEN
      NEW.authority_workspace_id := NEW.workspace_id;
      NEW.authority_subject_id := NULL;
      NEW.authority_id := NULL;
      NEW.owner_organization_membership_id := NULL;
      NEW.visibility := 'workspace';
    WHEN 'personal' THEN
      NEW.authority_subject_id := coalesce(
        nullif(btrim(NEW.authority_subject_id), ''),
        nullif(btrim(NEW.created_by), '')
      );
      IF NEW.authority_id IS NULL THEN
        NEW.authority_workspace_id := NEW.workspace_id;
        NEW.owner_organization_membership_id := NULL;
      ELSE
        NEW.authority_workspace_id := NULL;
      END IF;
      NEW.visibility := 'private';
    ELSE
      RAISE EXCEPTION 'invalid document authority kind: %', NEW.authority_kind;
  END CASE;
  RETURN NEW;
END
$body$;

CREATE OR REPLACE FUNCTION opengeni_private.apply_document_chunk_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $body$
DECLARE
  parent documents%ROWTYPE;
  reclassification_allowed boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.authority_kind IS DISTINCT FROM OLD.authority_kind
    OR NEW.authority_workspace_id IS DISTINCT FROM OLD.authority_workspace_id
    OR NEW.authority_subject_id IS DISTINCT FROM OLD.authority_subject_id
    OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
    OR NEW.owner_organization_membership_id
      IS DISTINCT FROM OLD.owner_organization_membership_id
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
  ) THEN
    IF opengeni_private.document_migration_capability_active('reclassify') THEN
      SELECT EXISTS (
        SELECT 1
        FROM document_authority_reclassifications receipt
        WHERE receipt.document_id = OLD.document_id
          AND receipt.account_id = OLD.account_id
          AND receipt.previous_authority_kind = OLD.authority_kind
          AND receipt.previous_authority_workspace_id
            IS NOT DISTINCT FROM OLD.authority_workspace_id
          AND receipt.previous_authority_subject_id
            IS NOT DISTINCT FROM OLD.authority_subject_id
          AND receipt.previous_authority_id IS NOT DISTINCT FROM OLD.authority_id
          AND receipt.previous_owner_organization_membership_id
            IS NOT DISTINCT FROM OLD.owner_organization_membership_id
          AND receipt.resulting_authority_kind = NEW.authority_kind
          AND receipt.resulting_authority_workspace_id
            IS NOT DISTINCT FROM NEW.authority_workspace_id
          AND receipt.resulting_authority_subject_id
            IS NOT DISTINCT FROM NEW.authority_subject_id
          AND receipt.resulting_authority_id IS NOT DISTINCT FROM NEW.authority_id
          AND receipt.resulting_owner_organization_membership_id
            IS NOT DISTINCT FROM NEW.owner_organization_membership_id
      ) INTO reclassification_allowed;
    END IF;
    IF NOT reclassification_allowed OR NEW.document_id IS DISTINCT FROM OLD.document_id THEN
      RAISE EXCEPTION 'document chunk authority is immutable';
    END IF;
  END IF;
  SELECT * INTO parent FROM documents WHERE id = NEW.document_id;
  IF NOT FOUND
    OR parent.account_id IS DISTINCT FROM NEW.account_id
    OR parent.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR parent.base_id IS DISTINCT FROM NEW.base_id
    OR parent.file_id IS DISTINCT FROM NEW.file_id
  THEN
    RAISE EXCEPTION 'document chunk parent identity mismatch';
  END IF;
  NEW.authority_kind := parent.authority_kind;
  NEW.authority_workspace_id := parent.authority_workspace_id;
  NEW.authority_subject_id := parent.authority_subject_id;
  NEW.authority_id := parent.authority_id;
  NEW.owner_organization_membership_id := parent.owner_organization_membership_id;
  RETURN NEW;
END
$body$;

CREATE FUNCTION reclassify_document_authority(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'accountId', '')::uuid;
  request_workspace_id_value uuid := nullif(p_command ->> 'workspaceId', '')::uuid;
  document_id_value uuid := nullif(p_command ->> 'documentId', '')::uuid;
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  actor_subject text := nullif(p_command ->> 'actorSubjectId', '');
  expected_kind text := p_command #>> '{expectedAuthority,kind}';
  expected_workspace_id uuid := nullif(
    p_command #>> '{expectedAuthority,workspaceId}', ''
  )::uuid;
  expected_subject_id text := nullif(
    p_command #>> '{expectedAuthority,subjectId}', ''
  );
  expected_authority_id uuid := nullif(
    p_command #>> '{expectedAuthority,authorityId}', ''
  )::uuid;
  target_kind text := p_command ->> 'targetAuthorityKind';
  account_admin_authorization jsonb := p_command -> 'accountAdminAuthorization';
  account_admin_authorized boolean := false;
  input_hash_value text;
  existing_receipt document_authority_reclassifications%ROWTYPE;
  document_row documents%ROWTYPE;
  owner_member organization_memberships%ROWTYPE;
  target_workspace_id uuid;
  target_subject_id text;
  target_authority_id uuid;
  target_owner_membership_id uuid;
  old_authority_id uuid;
  receipt_created_at timestamptz;
  result_value jsonb;
BEGIN
  IF p_command IS NULL THEN
    RAISE EXCEPTION 'document reclassification command is required' USING ERRCODE = '22023';
  ELSIF account_id_value IS NULL THEN
    RAISE EXCEPTION 'document reclassification account id is required' USING ERRCODE = '22023';
  ELSIF request_workspace_id_value IS NULL THEN
    RAISE EXCEPTION 'document reclassification workspace id is required' USING ERRCODE = '22023';
  ELSIF document_id_value IS NULL THEN
    RAISE EXCEPTION 'document reclassification document id is required' USING ERRCODE = '22023';
  ELSIF operation_id_value IS NULL THEN
    RAISE EXCEPTION 'document reclassification operation id is required' USING ERRCODE = '22023';
  ELSIF actor_subject IS NULL THEN
    RAISE EXCEPTION 'document reclassification actor is required' USING ERRCODE = '22023';
  END IF;
  IF actor_subject IS DISTINCT FROM nullif(current_setting('opengeni.subject_id', true), '') THEN
    RAISE EXCEPTION 'document reclassification actor authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF account_id_value IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'document reclassification account authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF request_workspace_id_value IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'document reclassification workspace authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  -- `NULL NOT IN (...)` is NULL, not TRUE, so an ABSENT kind would slip past
  -- this guard and only surface much later as the compare-and-set 40001 the API
  -- renders as a 409 conflict. A missing kind is malformed input: reject it here
  -- with 22023 so the caller gets a 400.
  IF expected_kind IS NULL
    OR target_kind IS NULL
    OR expected_kind NOT IN ('organization', 'workspace', 'personal')
    OR target_kind NOT IN ('organization', 'workspace', 'personal')
    OR octet_length(convert_to(actor_subject, 'UTF8')) NOT BETWEEN 1 AND 1024
  THEN
    RAISE EXCEPTION 'document reclassification input is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF account_admin_authorization IS NOT NULL
    AND account_admin_authorization <> 'null'::jsonb
  THEN
    account_admin_authorized :=
      jsonb_typeof(account_admin_authorization) = 'object'
      AND coalesce(account_admin_authorization ->> 'permission', '') = 'account:admin'
      AND nullif(account_admin_authorization ->> 'accountId', '')::uuid
        IS NOT DISTINCT FROM account_id_value
      AND nullif(account_admin_authorization ->> 'actorSubjectId', '')
        IS NOT DISTINCT FROM actor_subject
      AND coalesce(account_admin_authorization ->> 'authorizationId', '')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  END IF;

  -- The authorization stamp is fresh request provenance, not logical input.
  -- Excluding it lets a later exactly-authorized HTTP retry converge on the
  -- immutable operation receipt while changed business input still conflicts.
  input_hash_value := encode(
    sha256(convert_to((p_command - 'accountAdminAuthorization')::text, 'UTF8')),
    'hex'
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('document-authority-reclassification:' || operation_id_value::text, 0)
  );
  INSERT INTO opengeni_private.document_migration_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'reclassify')
  ON CONFLICT DO NOTHING;
  SELECT * INTO existing_receipt
  FROM document_authority_reclassifications receipt
  WHERE receipt.operation_id = operation_id_value
  FOR UPDATE;
  IF FOUND THEN
    IF existing_receipt.account_id IS DISTINCT FROM account_id_value
      OR existing_receipt.input_hash IS DISTINCT FROM input_hash_value
    THEN
      RAISE EXCEPTION 'document reclassification operation id was reused with different input'
        USING ERRCODE = '23505';
    END IF;
    IF (
      existing_receipt.previous_authority_kind = 'organization'
      OR existing_receipt.resulting_authority_kind = 'organization'
    ) AND NOT account_admin_authorized
    THEN
      RAISE EXCEPTION 'organization document reclassification requires exact account authority'
        USING ERRCODE = '42501';
    END IF;
    DELETE FROM opengeni_private.document_migration_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'reclassify';
    RETURN existing_receipt.result;
  END IF;
  DELETE FROM opengeni_private.document_migration_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'reclassify';

  SELECT * INTO document_row
  FROM documents document_value
  WHERE document_value.id = document_id_value
    AND document_value.account_id = account_id_value
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document not found' USING ERRCODE = 'P0002';
  END IF;
  IF document_row.authority_kind IS DISTINCT FROM expected_kind
    OR document_row.authority_workspace_id IS DISTINCT FROM expected_workspace_id
    OR document_row.authority_subject_id IS DISTINCT FROM expected_subject_id
    OR document_row.authority_id IS DISTINCT FROM expected_authority_id
  THEN
    RAISE EXCEPTION 'document authority changed before reclassification'
      USING ERRCODE = '40001';
  END IF;
  IF (document_row.authority_kind = 'organization' OR target_kind = 'organization')
    AND NOT account_admin_authorized
  THEN
    RAISE EXCEPTION 'organization document reclassification requires exact account authority'
      USING ERRCODE = '42501';
  END IF;
  IF target_kind = 'workspace'
    AND request_workspace_id_value IS DISTINCT FROM document_row.workspace_id
  THEN
    RAISE EXCEPTION 'workspace document target requires the immutable origin workspace route'
      USING ERRCODE = '42501';
  END IF;
  IF target_kind = 'personal'
    AND document_row.created_by IS DISTINCT FROM actor_subject
  THEN
    RAISE EXCEPTION 'personal document reclassification requires the original creating subject'
      USING ERRCODE = '42501';
  END IF;

  old_authority_id := document_row.authority_id;
  target_subject_id := CASE WHEN target_kind = 'personal' THEN actor_subject ELSE NULL END;
  target_authority_id := CASE WHEN target_kind = 'personal' THEN document_row.authority_id ELSE NULL END;
  target_owner_membership_id := CASE
    WHEN target_kind = 'personal' THEN document_row.owner_organization_membership_id
    ELSE NULL
  END;

  IF target_kind = 'personal' AND target_authority_id IS NULL THEN
    -- The capability window MUST be open before the membership read, not after
    -- it. `organization_memberships` is FORCE ROW LEVEL SECURITY and carries no
    -- GUC-only read policy: every branch is capability- or lifecycle-gated. This
    -- routine is SECURITY DEFINER, so it runs as the schema OWNER, and `FORCE`
    -- binds the owner too on the documented deployment posture (a NOSUPERUSER,
    -- NOBYPASSRLS migration login). Reading first would match zero rows, leave
    -- `IF FOUND` false, and silently skip this entire portable-authority
    -- activation - see `docs/force-rls-migration-backfills.md`.
    INSERT INTO opengeni_private.personal_document_authority_capabilities (
      backend_pid, transaction_id, capability_kind
    ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'write')
    ON CONFLICT DO NOTHING;
    -- Fail loudly rather than fall through to the legacy lane if the window is
    -- ever not established: a blinded read here is indistinguishable from
    -- "this subject holds no organization membership", and the difference is
    -- whether a personal Document is portable or permanently workspace-pinned.
    IF NOT opengeni_private.personal_document_authority_capability_active('write') THEN
      RAISE EXCEPTION 'document reclassification personal authority window is unavailable'
        USING ERRCODE = '55000';
    END IF;
    -- Deliberately NOT `FOR SHARE`. PostgreSQL applies a relation's UPDATE
    -- policies to any SELECT that carries a locking clause, and every read
    -- policy on `organization_memberships` is `FOR SELECT` only, so `FOR SHARE`
    -- / `FOR KEY SHARE` / `FOR UPDATE` all return ZERO ROWS here without
    -- raising - the same silent-blinding class as the FORCE-RLS backfill no-op.
    -- The membership still cannot be deleted or re-keyed under us, by one of
    -- two mechanisms depending on which arm the write below takes. On the
    -- fresh-insert arm the RI check for
    -- `organization_user_resource_authorities_membership_fk` bypasses row
    -- security and takes `FOR KEY SHARE` on the exact membership row. On the
    -- ON CONFLICT DO UPDATE arm no row is inserted and the FK columns are
    -- unchanged, so PostgreSQL skips the RI check entirely - but the row it is
    -- reactivating already references that membership under ON DELETE RESTRICT,
    -- so the DELETE is refused by that reference instead. Either way a
    -- concurrent non-key `UPDATE` of the membership is NOT blocked; that
    -- narrower write-skew window is documented as a known residual.
    SELECT membership.* INTO owner_member
    FROM organization_memberships membership
    WHERE membership.account_id = account_id_value
      AND membership.subject_id = actor_subject
      AND membership.status = 'active'
      AND membership.revoked_at IS NULL;
    IF FOUND THEN
      -- Reactivate rather than insert blind. The rollback direction below only
      -- marks the prior authority `revoked`; it never deletes the row, and
      -- `organization_user_resource_authorities_resource_identity_idx` is
      -- UNIQUE (account_id, organization_membership_id, resource_kind,
      -- resource_id) with NO status predicate. A plain INSERT therefore made
      -- the documented `personal -> workspace -> personal` round trip fail
      -- permanently with 23505, which the route surfaces as an untyped 500.
      -- `origin_workspace_id` is deliberately preserved on reactivation: it is
      -- privacy-safe provenance of where the authority first originated, never
      -- an ownership or authorization anchor, so it must not be rewritten to
      -- wherever the Document happens to sit now.
      INSERT INTO organization_user_resource_authorities (
        id, account_id, organization_membership_id, resource_kind,
        resource_id, origin_workspace_id, generation, status
      ) VALUES (
        gen_random_uuid(), account_id_value, owner_member.id, 'document',
        document_row.id, document_row.workspace_id, 1, 'active'
      )
      ON CONFLICT (account_id, organization_membership_id, resource_kind, resource_id)
      DO UPDATE SET
        status = 'active',
        generation = organization_user_resource_authorities.generation + 1,
        revoked_at = NULL,
        updated_at = clock_timestamp()
      RETURNING id, organization_membership_id
      INTO target_authority_id, target_owner_membership_id;
    ELSE
      -- Configured/local and rolling-legacy subjects have no organization
      -- membership and keep the pre-organization workspace-anchored personal
      -- lane. Close the window immediately so nothing after this point runs
      -- with a capability it did not earn.
      DELETE FROM opengeni_private.personal_document_authority_capabilities
      WHERE backend_pid = pg_backend_pid()
        AND transaction_id = pg_current_xact_id_if_assigned()
        AND capability_kind = 'write';
    END IF;
  END IF;

  -- Derived AFTER the authority decision, and never before it. The receipt and
  -- the API response must state the tuple `apply_document_authority` actually
  -- stores, and that trigger normalizes `authority_workspace_id` to NULL for
  -- every personal row with a non-null `authority_id` (a portable personal
  -- Document is anchored by its authority row, never by a workspace). Computing
  -- this up front made a `personal(portable) -> personal` receipt claim an
  -- anchoring that does not exist, and the trigger's receipt match compares the
  -- PRE-normalization NEW row, so nothing caught it.
  target_workspace_id := CASE
    WHEN target_kind = 'workspace' THEN document_row.workspace_id
    WHEN target_kind = 'personal' AND target_authority_id IS NULL
      THEN document_row.workspace_id
    ELSE NULL
  END;
  IF target_authority_id IS NULL THEN
    target_owner_membership_id := NULL;
  END IF;

  -- The receipt column and the receipt's own `createdAt` must be the SAME
  -- instant. Two `clock_timestamp()` calls drift by microseconds, which makes
  -- the `created_at = cursor` tie-break in
  -- `list_document_authority_reclassifications` unreachable and can silently
  -- skip a receipt whose stored `created_at` sorts before the cursor the client
  -- echoed back from `result.createdAt`.
  receipt_created_at := clock_timestamp();
  result_value := jsonb_build_object(
    'operationId', operation_id_value,
    'documentId', document_row.id,
    'previousAuthority', jsonb_build_object(
      'kind', document_row.authority_kind,
      'workspaceId', document_row.authority_workspace_id,
      'subjectId', document_row.authority_subject_id,
      'authorityId', document_row.authority_id
    ),
    'authority', jsonb_build_object(
      'kind', target_kind,
      'workspaceId', target_workspace_id,
      'subjectId', target_subject_id,
      'authorityId', target_authority_id
    ),
    'createdAt', receipt_created_at
  );

  INSERT INTO opengeni_private.document_migration_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'reclassify')
  ON CONFLICT DO NOTHING;
  INSERT INTO document_authority_reclassifications (
    operation_id, input_hash, account_id, request_workspace_id, document_id,
    actor_subject_id,
    previous_authority_kind, previous_authority_workspace_id,
    previous_authority_subject_id, previous_authority_id,
    previous_owner_organization_membership_id,
    resulting_authority_kind, resulting_authority_workspace_id,
    resulting_authority_subject_id, resulting_authority_id,
    resulting_owner_organization_membership_id, result, created_at
  ) VALUES (
    operation_id_value, input_hash_value, account_id_value,
    request_workspace_id_value, document_row.id, actor_subject,
    document_row.authority_kind, document_row.authority_workspace_id,
    document_row.authority_subject_id, document_row.authority_id,
    document_row.owner_organization_membership_id,
    target_kind, target_workspace_id, target_subject_id, target_authority_id,
    target_owner_membership_id, result_value, receipt_created_at
  );

  UPDATE documents SET
    authority_kind = target_kind,
    authority_workspace_id = target_workspace_id,
    authority_subject_id = target_subject_id,
    authority_id = target_authority_id,
    owner_organization_membership_id = target_owner_membership_id,
    visibility = CASE WHEN target_kind = 'personal' THEN 'private' ELSE 'workspace' END,
    updated_at = clock_timestamp()
  WHERE id = document_row.id;
  UPDATE document_chunks SET
    authority_kind = target_kind,
    authority_workspace_id = target_workspace_id,
    authority_subject_id = target_subject_id,
    authority_id = target_authority_id,
    owner_organization_membership_id = target_owner_membership_id
  WHERE document_id = document_row.id;

  IF old_authority_id IS NOT NULL AND old_authority_id IS DISTINCT FROM target_authority_id THEN
    UPDATE organization_user_resource_grants SET
      status = 'revoked', generation = generation + 1,
      revoked_at = coalesce(revoked_at, clock_timestamp()),
      updated_at = clock_timestamp()
    WHERE authority_id = old_authority_id
      AND account_id = account_id_value
      AND status IN ('active', 'consumed');
    UPDATE organization_user_resource_authorities SET
      status = 'revoked', generation = generation + 1,
      revoked_at = coalesce(revoked_at, clock_timestamp()),
      updated_at = clock_timestamp()
    WHERE id = old_authority_id
      AND account_id = account_id_value
      AND status <> 'revoked';
  END IF;
  DELETE FROM opengeni_private.personal_document_authority_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'write';
  DELETE FROM opengeni_private.document_migration_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'reclassify';
  RETURN result_value;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.personal_document_authority_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'write';
  DELETE FROM opengeni_private.document_migration_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'reclassify';
  RAISE;
END
$body$;

CREATE FUNCTION list_document_authority_reclassifications(
  p_account_id uuid,
  p_workspace_id uuid,
  p_actor_subject_id text,
  p_document_id uuid,
  p_limit integer,
  p_before_created_at timestamptz,
  p_before_operation_id uuid
) RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
  SELECT receipt.result
  FROM document_authority_reclassifications receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.request_workspace_id = p_workspace_id
    AND receipt.actor_subject_id = p_actor_subject_id
    AND receipt.document_id = p_document_id
    AND p_account_id = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND p_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND p_actor_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
    AND (
      p_before_created_at IS NULL
      OR receipt.created_at < p_before_created_at
      OR (
        receipt.created_at = p_before_created_at
        AND receipt.operation_id < p_before_operation_id
      )
    )
  ORDER BY receipt.created_at DESC, receipt.operation_id DESC
  LIMIT least(greatest(coalesce(p_limit, 1), 1), 101)
$body$;

CREATE FUNCTION run_document_default_collection_backfill(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := nullif(p_command ->> 'accountId', '')::uuid;
  request_workspace_id_value uuid := nullif(p_command ->> 'workspaceId', '')::uuid;
  actor_subject text := nullif(p_command ->> 'actorSubjectId', '');
  run_id_value uuid := nullif(p_command ->> 'runId', '')::uuid;
  operation_id_value uuid := nullif(p_command ->> 'operationId', '')::uuid;
  batch_size integer := coalesce((p_command ->> 'batchSize')::integer, 50);
  account_admin_authorization jsonb := p_command -> 'accountAdminAuthorization';
  account_admin_authorized boolean := false;
  input_hash_value text;
  existing_operation document_default_collection_backfill_operations%ROWTYPE;
  run_row document_default_collection_backfill_runs%ROWTYPE;
  workspace_row workspaces%ROWTYPE;
  base_row document_bases%ROWTYPE;
  outcome_value text;
  batch_processed integer := 0;
  batch_created integer := 0;
  batch_adopted integer := 0;
  has_more boolean;
  result_value jsonb;
BEGIN
  IF p_command IS NULL THEN
    RAISE EXCEPTION 'document Default collection backfill command is required'
      USING ERRCODE = '22023';
  ELSIF account_id_value IS NULL THEN
    RAISE EXCEPTION 'document Default collection backfill account id is required'
      USING ERRCODE = '22023';
  ELSIF request_workspace_id_value IS NULL THEN
    RAISE EXCEPTION 'document Default collection backfill workspace id is required'
      USING ERRCODE = '22023';
  ELSIF actor_subject IS NULL THEN
    RAISE EXCEPTION 'document Default collection backfill actor is required'
      USING ERRCODE = '22023';
  ELSIF run_id_value IS NULL THEN
    RAISE EXCEPTION 'document Default collection backfill run id is required'
      USING ERRCODE = '22023';
  ELSIF operation_id_value IS NULL THEN
    RAISE EXCEPTION 'document Default collection backfill operation id is required'
      USING ERRCODE = '22023';
  ELSIF batch_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'document Default collection backfill batch size is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF account_id_value IS DISTINCT FROM nullif(
      current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'document Default collection backfill account authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF request_workspace_id_value IS DISTINCT FROM nullif(
      current_setting('opengeni.workspace_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'document Default collection backfill workspace authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF actor_subject IS DISTINCT FROM nullif(
      current_setting('opengeni.subject_id', true), ''
    )
  THEN
    RAISE EXCEPTION 'document Default collection backfill actor authority is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF account_admin_authorization IS NOT NULL
    AND account_admin_authorization <> 'null'::jsonb
  THEN
    account_admin_authorized :=
      jsonb_typeof(account_admin_authorization) = 'object'
      AND coalesce(account_admin_authorization ->> 'permission', '') = 'account:admin'
      AND nullif(account_admin_authorization ->> 'accountId', '')::uuid
        IS NOT DISTINCT FROM account_id_value
      AND nullif(account_admin_authorization ->> 'actorSubjectId', '')
        IS NOT DISTINCT FROM actor_subject
      AND coalesce(account_admin_authorization ->> 'authorizationId', '')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  END IF;
  IF NOT account_admin_authorized THEN
    RAISE EXCEPTION 'document Default collection backfill requires organization administration'
      USING ERRCODE = '42501';
  END IF;

  input_hash_value := encode(
    sha256(convert_to((p_command - 'accountAdminAuthorization')::text, 'UTF8')),
    'hex'
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('document-default-collection-backfill:' || run_id_value::text, 0)
  );
  INSERT INTO opengeni_private.document_migration_capabilities (
    backend_pid, transaction_id, capability_kind
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), 'default_backfill')
  ON CONFLICT DO NOTHING;

  SELECT * INTO existing_operation
  FROM document_default_collection_backfill_operations operation
  WHERE operation.operation_id = operation_id_value
  FOR UPDATE;
  IF FOUND THEN
    IF existing_operation.account_id IS DISTINCT FROM account_id_value
      OR existing_operation.run_id IS DISTINCT FROM run_id_value
      OR existing_operation.input_hash IS DISTINCT FROM input_hash_value
    THEN
      RAISE EXCEPTION 'document Default backfill operation id was reused with different input'
        USING ERRCODE = '23505';
    END IF;
    DELETE FROM opengeni_private.document_migration_capabilities
    WHERE backend_pid = pg_backend_pid()
      AND transaction_id = pg_current_xact_id_if_assigned()
      AND capability_kind = 'default_backfill';
    RETURN existing_operation.result;
  END IF;

  SELECT * INTO run_row
  FROM document_default_collection_backfill_runs run
  WHERE run.run_id = run_id_value
  FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO document_default_collection_backfill_runs (
      run_id, account_id, actor_subject_id
    ) VALUES (run_id_value, account_id_value, actor_subject)
    RETURNING * INTO run_row;
  ELSIF run_row.account_id IS DISTINCT FROM account_id_value
    OR run_row.actor_subject_id IS DISTINCT FROM actor_subject
  THEN
    RAISE EXCEPTION 'document Default backfill run identity mismatch'
      USING ERRCODE = '23505';
  END IF;

  IF run_row.status = 'running' THEN
    FOR workspace_row IN
      SELECT workspace.* FROM workspaces workspace
      WHERE workspace.account_id = account_id_value
        AND (run_row.last_workspace_id IS NULL OR workspace.id > run_row.last_workspace_id)
      ORDER BY workspace.id
      LIMIT batch_size
      FOR UPDATE
    LOOP
      SELECT * INTO base_row
      FROM document_bases base
      WHERE base.workspace_id = workspace_row.id
        AND lower(btrim(base.name)) = 'default'
      ORDER BY base.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN
        outcome_value := 'adopted';
        batch_adopted := batch_adopted + 1;
      ELSE
        INSERT INTO document_bases (
          account_id, workspace_id, name, description
        ) VALUES (
          account_id_value, workspace_row.id, 'Default',
          'Default base for dropped files and notes.'
        )
        ON CONFLICT DO NOTHING
        RETURNING * INTO base_row;
        IF FOUND THEN
          outcome_value := 'created';
          batch_created := batch_created + 1;
        ELSE
          SELECT * INTO STRICT base_row FROM document_bases base
          WHERE base.workspace_id = workspace_row.id
            AND lower(btrim(base.name)) = 'default'
          ORDER BY base.id LIMIT 1;
          outcome_value := 'adopted';
          batch_adopted := batch_adopted + 1;
        END IF;
      END IF;
      INSERT INTO document_default_collection_backfill_receipts (
        run_id, account_id, workspace_id, base_id, outcome
      ) VALUES (
        run_id_value, account_id_value, workspace_row.id, base_row.id, outcome_value
      ) ON CONFLICT (run_id, workspace_id) DO NOTHING;
      run_row.last_workspace_id := workspace_row.id;
      batch_processed := batch_processed + 1;
    END LOOP;

    SELECT EXISTS (
      SELECT 1 FROM workspaces workspace
      WHERE workspace.account_id = account_id_value
        AND (run_row.last_workspace_id IS NULL OR workspace.id > run_row.last_workspace_id)
    ) INTO has_more;
    UPDATE document_default_collection_backfill_runs SET
      last_workspace_id = run_row.last_workspace_id,
      processed_count = processed_count + batch_processed,
      created_count = created_count + batch_created,
      adopted_count = adopted_count + batch_adopted,
      status = CASE WHEN has_more THEN 'running' ELSE 'completed' END,
      updated_at = clock_timestamp(),
      completed_at = CASE WHEN has_more THEN NULL ELSE clock_timestamp() END
    WHERE run_id = run_id_value
    RETURNING * INTO run_row;
  END IF;

  result_value := jsonb_build_object(
    'runId', run_row.run_id,
    'operationId', operation_id_value,
    'status', run_row.status,
    'lastWorkspaceId', run_row.last_workspace_id,
    'processedCount', run_row.processed_count,
    'createdCount', run_row.created_count,
    'adoptedCount', run_row.adopted_count,
    'completedAt', run_row.completed_at
  );
  INSERT INTO document_default_collection_backfill_operations (
    operation_id, run_id, account_id, input_hash, result
  ) VALUES (
    operation_id_value, run_id_value, account_id_value, input_hash_value, result_value
  );
  DELETE FROM opengeni_private.document_migration_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'default_backfill';
  RETURN result_value;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.document_migration_capabilities
  WHERE backend_pid = pg_backend_pid()
    AND transaction_id = pg_current_xact_id_if_assigned()
    AND capability_kind = 'default_backfill';
  RAISE;
END
$body$;

DO $document_migration_search_path$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.apply_document_authority() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.apply_document_chunk_authority() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.reclassify_document_authority(jsonb) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.list_document_authority_reclassifications('
      || 'uuid,uuid,text,uuid,integer,timestamptz,uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.run_document_default_collection_backfill(jsonb) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
END
$document_migration_search_path$;

REVOKE ALL ON TABLE document_authority_reclassifications FROM PUBLIC;
REVOKE ALL ON TABLE document_default_collection_backfill_runs FROM PUBLIC;
REVOKE ALL ON TABLE document_default_collection_backfill_operations FROM PUBLIC;
REVOKE ALL ON TABLE document_default_collection_backfill_receipts FROM PUBLIC;
REVOKE ALL ON FUNCTION reclassify_document_authority(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  list_document_authority_reclassifications(
    uuid, uuid, text, uuid, integer, timestamptz, uuid
  ) FROM PUBLIC;
REVOKE ALL ON FUNCTION run_document_default_collection_backfill(jsonb) FROM PUBLIC;

DO $document_migration_runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT ON TABLE document_authority_reclassifications TO opengeni_app;
    REVOKE INSERT, UPDATE, DELETE ON TABLE document_authority_reclassifications
      FROM opengeni_app;
    REVOKE ALL ON TABLE document_default_collection_backfill_runs FROM opengeni_app;
    REVOKE ALL ON TABLE document_default_collection_backfill_operations FROM opengeni_app;
    REVOKE ALL ON TABLE document_default_collection_backfill_receipts FROM opengeni_app;
    GRANT EXECUTE ON FUNCTION reclassify_document_authority(jsonb) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      list_document_authority_reclassifications(
        uuid, uuid, text, uuid, integer, timestamptz, uuid
      ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION run_document_default_collection_backfill(jsonb) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.document_migration_capability_active(text) TO opengeni_app;
    REVOKE ALL ON TABLE opengeni_private.document_migration_capabilities FROM opengeni_app;
  END IF;
END
$document_migration_runtime_grants$;

COMMENT ON TABLE document_authority_reclassifications IS
  'Immutable same-transaction before/after receipts for explicit Document authority changes.';
COMMENT ON TABLE document_default_collection_backfill_runs IS
  'Resumable account-bounded creation/adoption progress for the internal Default collection.';
COMMENT ON TABLE document_default_collection_backfill_receipts IS
  'Immutable per-workspace evidence for each Default collection backfill run.';
