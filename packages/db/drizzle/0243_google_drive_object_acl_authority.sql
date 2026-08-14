-- deployment-mode: rolling
-- Google Drive retrieval is provider-authorized per object, not merely by the
-- destination document's organization/workspace/personal visibility. Persist
-- append-only, freshness-bounded ACL observations and expose one fail-closed
-- SECURITY DEFINER predicate so cross-workspace organization reads do not need
-- direct access to source-workspace ACL rows. Principal values are stored only
-- as domain-separated SHA-256 hashes; credentials remain in connections.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';

CREATE TABLE opengeni_private.google_drive_object_acl_runtime_capabilities (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  "capability_kind" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "google_drive_object_acl_runtime_capabilities_kind_chk" CHECK (
    "capability_kind" IN ('authorize', 'citation')
  ),
  CONSTRAINT "google_drive_object_acl_runtime_capabilities_pk" PRIMARY KEY (
    "backend_pid", "transaction_id", "capability_kind"
  )
);
REVOKE ALL ON TABLE opengeni_private.google_drive_object_acl_runtime_capabilities FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.google_drive_object_acl_capability_active()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = opengeni_private, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM google_drive_object_acl_runtime_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability.capability_kind IN ('authorize', 'citation')
  );
$$;
REVOKE ALL ON FUNCTION opengeni_private.google_drive_object_acl_capability_active() FROM PUBLIC;

DO $google_drive_capability_revoke$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON TABLE opengeni_private.google_drive_object_acl_runtime_capabilities
      FROM opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.google_drive_object_acl_capability_active()
      TO opengeni_app;
  END IF;
END
$google_drive_capability_revoke$;

CREATE TABLE "google_drive_object_acl_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL,
  "source_id" uuid NOT NULL REFERENCES "knowledge_sources"("id") ON DELETE CASCADE,
  "knowledge_source_object_id" uuid NOT NULL
    REFERENCES "knowledge_source_objects"("id") ON DELETE CASCADE,
  "knowledge_document_version_id" uuid NOT NULL
    REFERENCES "knowledge_document_versions"("id") ON DELETE CASCADE,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "file_id" uuid NOT NULL REFERENCES "files"("id") ON DELETE RESTRICT,
  "index_obligation_id" uuid NOT NULL
    REFERENCES "knowledge_source_sync_index_obligations"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE RESTRICT,
  "connection_version" bigint NOT NULL,
  "source_principal_hash" text NOT NULL,
  "source_sync_generation" bigint NOT NULL,
  "source_config_generation" bigint NOT NULL,
  "source_lifecycle_generation" bigint NOT NULL,
  "object_lifecycle_generation" bigint NOT NULL,
  "object_version_generation" bigint NOT NULL,
  "provider_revision" text,
  "drive_id" text,
  "acl_revision" text NOT NULL,
  "acl_hash" text NOT NULL,
  "eligibility" text NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "citation_locator" jsonb NOT NULL,
  "operation_id" text NOT NULL,
  "input_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "google_drive_object_acl_evidence_workspace_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "google_drive_object_acl_evidence_obligation_uq"
    UNIQUE ("index_obligation_id", "operation_id"),
  CONSTRAINT "google_drive_object_acl_evidence_identity_uq"
    UNIQUE ("id", "index_obligation_id"),
  CONSTRAINT "google_drive_object_acl_evidence_bounds_chk" CHECK (
    "connection_version" > 0
    AND "source_sync_generation" >= 0
    AND "source_config_generation" > 0
    AND "source_lifecycle_generation" > 0
    AND "object_lifecycle_generation" > 0
    AND "object_version_generation" > 0
    AND "source_principal_hash" ~ '^[0-9a-f]{64}$'
    AND ("provider_revision" IS NULL OR length("provider_revision") BETWEEN 1 AND 1024)
    AND ("drive_id" IS NULL OR length("drive_id") BETWEEN 1 AND 1024)
    AND length(btrim("acl_revision")) BETWEEN 1 AND 1024
    AND "acl_hash" ~ '^[0-9a-f]{64}$'
    AND "eligibility" IN ('eligible', 'denied')
    AND "expires_at" > "observed_at"
    AND jsonb_typeof("citation_locator") = 'object'
    AND octet_length(convert_to("citation_locator"::text, 'UTF8')) <= 16384
    AND length(btrim("operation_id")) BETWEEN 1 AND 256
    AND "input_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE INDEX "google_drive_object_acl_evidence_version_idx"
  ON "google_drive_object_acl_evidence" (
    "knowledge_document_version_id", "expires_at" DESC, "created_at" DESC
  );
CREATE INDEX "google_drive_object_acl_evidence_file_idx"
  ON "google_drive_object_acl_evidence" ("account_id", "file_id", "expires_at" DESC);

CREATE TABLE "google_drive_object_acl_principals" (
  "evidence_id" uuid NOT NULL
    REFERENCES "google_drive_object_acl_evidence"("id") ON DELETE CASCADE,
  "ordinal" integer NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL,
  "principal_type" text NOT NULL,
  "permission_id_hash" text,
  "email_hash" text,
  "domain_hash" text,
  "role" text NOT NULL,
  "inherited" boolean NOT NULL DEFAULT false,
  "allow_file_discovery" boolean,
  "expiration_time" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("evidence_id", "ordinal"),
  CONSTRAINT "google_drive_object_acl_principals_workspace_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "google_drive_object_acl_principals_bounds_chk" CHECK (
    "ordinal" >= 0 AND "ordinal" < 10000
    AND "principal_type" IN ('user', 'group', 'domain', 'anyone')
    AND ("permission_id_hash" IS NULL OR "permission_id_hash" ~ '^[0-9a-f]{64}$')
    AND ("email_hash" IS NULL OR "email_hash" ~ '^[0-9a-f]{64}$')
    AND ("domain_hash" IS NULL OR "domain_hash" ~ '^[0-9a-f]{64}$')
    AND "role" IN ('owner', 'organizer', 'fileOrganizer', 'writer', 'commenter', 'reader')
    AND (
      ("principal_type" = 'user' AND ("permission_id_hash" IS NOT NULL OR "email_hash" IS NOT NULL))
      OR ("principal_type" = 'group' AND ("permission_id_hash" IS NOT NULL OR "email_hash" IS NOT NULL))
      OR ("principal_type" = 'domain' AND "domain_hash" IS NOT NULL)
      OR ("principal_type" = 'anyone'
        AND "permission_id_hash" IS NULL AND "email_hash" IS NULL AND "domain_hash" IS NULL)
    )
  )
);

CREATE INDEX "google_drive_object_acl_principals_match_idx"
  ON "google_drive_object_acl_principals" (
    "evidence_id", "principal_type", "permission_id_hash", "email_hash", "domain_hash"
  );

ALTER TABLE "knowledge_source_sync_index_obligations"
  ADD COLUMN "google_drive_acl_evidence_id" uuid;

ALTER TABLE "knowledge_source_sync_index_obligations"
  ADD CONSTRAINT "knowledge_source_sync_index_obligations_drive_acl_fk"
  FOREIGN KEY ("google_drive_acl_evidence_id")
  REFERENCES "google_drive_object_acl_evidence"("id")
  ON DELETE SET NULL NOT VALID;

ALTER TABLE "knowledge_source_sync_index_obligations"
  VALIDATE CONSTRAINT "knowledge_source_sync_index_obligations_drive_acl_fk";

ALTER TABLE "google_drive_object_acl_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "google_drive_object_acl_evidence" FORCE ROW LEVEL SECURITY;
ALTER TABLE "google_drive_object_acl_principals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "google_drive_object_acl_principals" FORCE ROW LEVEL SECURITY;

CREATE POLICY "google_drive_object_acl_evidence_workspace_isolation"
  ON "google_drive_object_acl_evidence"
  USING (
    "account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  );

CREATE POLICY "google_drive_object_acl_principals_workspace_isolation"
  ON "google_drive_object_acl_principals"
  USING (
    "account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  )
  WITH CHECK (
    "account_id" = nullif(current_setting('opengeni.account_id', true), '')::uuid
    AND "workspace_id" = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
  );

-- Every joined authority table is FORCE-RLS. The exact SECURITY DEFINER
-- routines below need a complete all-protectors view even when the requesting
-- workspace/subject cannot directly see a source row. A transaction-local row
-- in the private capability table opens only SELECT, only for a routine whose
-- effective role is the table owner. opengeni_app has no capability-table
-- privileges and cannot forge this path through a custom GUC.
DO $google_drive_capability_policies$
DECLARE table_name text;
DECLARE data_schema text := current_schema();
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'connections',
    'files',
    'google_drive_object_acl_evidence',
    'google_drive_object_acl_principals',
    'knowledge_document_versions',
    'knowledge_providers',
    'knowledge_source_objects',
    'knowledge_source_sync_index_obligations',
    'knowledge_source_sync_states',
    'knowledge_sources'
  ] LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS google_drive_object_acl_capability_read ON %I.%I',
      data_schema,
      table_name
    );
    EXECUTE format($policy$
      CREATE POLICY google_drive_object_acl_capability_read ON %1$I.%2$I
      FOR SELECT USING (
        current_user = pg_catalog.pg_get_userbyid(
          (SELECT relation.relowner
           FROM pg_catalog.pg_class relation
           WHERE relation.oid = %3$L::pg_catalog.regclass)
        )
        AND opengeni_private.google_drive_object_acl_capability_active()
      )
    $policy$, data_schema, table_name, data_schema || '.' || table_name);
  END LOOP;
END
$google_drive_capability_policies$;

DO $google_drive_file_authority$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.google_drive_file_authorized(
      p_account_id uuid,
      p_request_workspace_id uuid,
      p_subject_id text,
      p_file_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE file_exists boolean := false;
    DECLARE protected boolean := false;
    DECLARE authorized boolean := false;
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_request_workspace_id IS DISTINCT FROM
          nullif(pg_catalog.current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
        OR p_file_id IS NULL
      THEN
        RETURN false;
      END IF;

      INSERT INTO opengeni_private.google_drive_object_acl_runtime_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'authorize')
      ON CONFLICT DO NOTHING;
      BEGIN
        SELECT EXISTS (
          SELECT 1 FROM files file_row
          WHERE file_row.id = p_file_id AND file_row.account_id = p_account_id
        ) INTO file_exists;
        IF file_exists THEN
          SELECT EXISTS (
            SELECT 1
            FROM knowledge_document_versions version_row
            JOIN knowledge_sources source_row ON source_row.id = version_row.source_id
            JOIN knowledge_providers provider_row ON provider_row.id = source_row.provider_id
            WHERE version_row.account_id = p_account_id
              AND version_row.file_id = p_file_id
              AND provider_row.provider_key = 'google-drive'
          ) INTO protected;
        END IF;

        IF file_exists AND NOT protected THEN
          authorized := true;
        ELSIF file_exists AND p_subject_id IS NULL THEN
          authorized := false;
        ELSIF file_exists THEN
          -- Every Google Drive object that has ever protected these exact bytes
          -- must still point at those bytes and carry current, fresh evidence for
          -- this subject. This all-protectors rule prevents a non-Google document
          -- or a second allowed Drive mapping from overriding one denied mapping.
          SELECT NOT EXISTS (
            SELECT 1
            FROM (
              SELECT DISTINCT version_row.object_id
              FROM knowledge_document_versions version_row
              JOIN knowledge_sources source_row ON source_row.id = version_row.source_id
              JOIN knowledge_providers provider_row ON provider_row.id = source_row.provider_id
              WHERE version_row.account_id = p_account_id
                AND version_row.file_id = p_file_id
                AND provider_row.provider_key = 'google-drive'
            ) protector
            WHERE NOT EXISTS (
              SELECT 1
              FROM knowledge_source_objects object_row
              JOIN knowledge_document_versions current_version
                ON current_version.id = object_row.current_version_id
               AND current_version.object_id = object_row.id
              JOIN knowledge_sources source_row ON source_row.id = object_row.source_id
              JOIN knowledge_providers provider_row ON provider_row.id = source_row.provider_id
              JOIN knowledge_source_sync_index_obligations obligation
                ON obligation.knowledge_document_version_id = current_version.id
               AND obligation.knowledge_source_object_id = object_row.id
               AND obligation.document_id = current_version.document_id
              JOIN knowledge_source_sync_states sync_state
                ON sync_state.source_id = source_row.id
              JOIN google_drive_object_acl_evidence evidence
                ON evidence.id = obligation.google_drive_acl_evidence_id
               AND evidence.index_obligation_id = obligation.id
              JOIN connections source_connection ON source_connection.id = evidence.connection_id
              WHERE object_row.id = protector.object_id
                AND object_row.account_id = p_account_id
                AND object_row.lifecycle_state = 'active'
                AND current_version.file_id = p_file_id
                AND current_version.version_generation = object_row.version_generation
                AND source_row.lifecycle_state = 'active'
                AND source_row.current_acl_generation = current_version.acl_generation
                AND provider_row.lifecycle_state = 'active'
                AND provider_row.provider_key = 'google-drive'
                AND obligation.status = 'indexed'
                AND obligation.acl_eligibility = 'eligible'
                AND obligation.source_lifecycle_generation = source_row.lifecycle_generation
                AND obligation.object_lifecycle_generation = object_row.lifecycle_generation
                AND obligation.object_version_generation = object_row.version_generation
                AND sync_state.account_id = p_account_id
                AND sync_state.source_sync_generation >= obligation.source_sync_generation
                AND sync_state.source_config_generation = obligation.source_config_generation
                AND sync_state.source_lifecycle_generation = obligation.source_lifecycle_generation
                AND sync_state.connection_id = evidence.connection_id
                AND sync_state.connection_provider_domain = 'googleapis.com'
                AND sync_state.connection_kind = 'oauth2'
                AND sync_state.connection_owner_subject_id = source_connection.subject_id
                AND sync_state.reconnect_required = false
                AND evidence.account_id = p_account_id
                AND evidence.knowledge_document_version_id = current_version.id
                AND evidence.document_id = current_version.document_id
                AND evidence.file_id = p_file_id
                AND evidence.source_lifecycle_generation = source_row.lifecycle_generation
                AND evidence.object_lifecycle_generation = object_row.lifecycle_generation
                AND evidence.object_version_generation = object_row.version_generation
                AND evidence.provider_revision IS NOT DISTINCT FROM
                  current_version.source_metadata->>'providerRevision'
                AND evidence.eligibility = 'eligible'
                AND evidence.observed_at <= pg_catalog.statement_timestamp()
                AND evidence.expires_at > pg_catalog.statement_timestamp()
                AND source_connection.account_id = p_account_id
                AND source_connection.subject_id IS NOT NULL
                AND source_connection.provider_domain = 'googleapis.com'
                AND source_connection.kind = 'oauth2'
                AND source_connection.status = 'active'
                AND source_connection.version >= evidence.connection_version
                AND coalesce(source_connection.metadata #>> '{lifecycle,state}', 'active') = 'active'
                AND source_connection.metadata->>'accessMode' = 'readonly'
                AND encode(sha256(convert_to(
                  'permission:' || lower(btrim(source_connection.metadata->>'googlePermissionId')),
                  'UTF8'
                )), 'hex') = evidence.source_principal_hash
                AND (
                  source_connection.granted_scopes ? 'https://www.googleapis.com/auth/drive'
                  OR source_connection.granted_scopes ? 'https://www.googleapis.com/auth/drive.readonly'
                )
                AND (
                  source_connection.subject_id = p_subject_id
                  OR EXISTS (
                    SELECT 1
                    FROM connections viewer_connection
                    JOIN google_drive_object_acl_principals principal
                      ON principal.evidence_id = evidence.id
                    WHERE viewer_connection.account_id = p_account_id
                      AND viewer_connection.subject_id = p_subject_id
                      AND viewer_connection.provider_domain = 'googleapis.com'
                      AND viewer_connection.kind = 'oauth2'
                      AND viewer_connection.status = 'active'
                      AND coalesce(viewer_connection.metadata #>> '{lifecycle,state}', 'active') = 'active'
                      AND viewer_connection.metadata->>'accessMode' = 'readonly'
                      AND (
                        viewer_connection.granted_scopes ? 'https://www.googleapis.com/auth/drive'
                        OR viewer_connection.granted_scopes ? 'https://www.googleapis.com/auth/drive.readonly'
                      )
                      AND (principal.expiration_time IS NULL
                        OR principal.expiration_time > pg_catalog.statement_timestamp())
                      AND (
                        principal.principal_type = 'anyone'
                        OR (
                          principal.principal_type = 'user'
                          AND (
                            principal.permission_id_hash = encode(sha256(convert_to(
                              'permission:' || lower(btrim(
                                viewer_connection.metadata->>'googlePermissionId'
                              )), 'UTF8'
                            )), 'hex')
                            OR principal.email_hash = encode(sha256(convert_to(
                              'email:' || lower(btrim(viewer_connection.metadata->>'googleEmail')),
                              'UTF8'
                            )), 'hex')
                          )
                        )
                        OR (
                          principal.principal_type = 'domain'
                          AND principal.domain_hash = encode(sha256(convert_to(
                            'domain:' || split_part(
                              lower(btrim(viewer_connection.metadata->>'googleEmail')), '@', 2
                            ), 'UTF8'
                          )), 'hex')
                        )
                      )
                  )
                )
            )
          ) INTO authorized;
        END IF;

        DELETE FROM opengeni_private.google_drive_object_acl_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'authorize';
        RETURN authorized;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.google_drive_object_acl_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'authorize';
        RAISE;
      END;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.google_drive_document_citation(
      p_account_id uuid,
      p_request_workspace_id uuid,
      p_subject_id text,
      p_document_id uuid,
      p_file_id uuid
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE citation jsonb;
    BEGIN
      INSERT INTO opengeni_private.google_drive_object_acl_runtime_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'citation')
      ON CONFLICT DO NOTHING;
      BEGIN
        IF NOT %1$I.google_drive_file_authorized(
          p_account_id, p_request_workspace_id, p_subject_id, p_file_id
        ) THEN
          DELETE FROM opengeni_private.google_drive_object_acl_runtime_capabilities
          WHERE backend_pid = pg_catalog.pg_backend_pid()
            AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
            AND capability_kind = 'citation';
          RETURN NULL;
        END IF;
        SELECT jsonb_strip_nulls(jsonb_build_object(
            'provider', 'google_drive',
            'externalObjectId', obligation.external_object_id,
            'providerRevision', evidence.provider_revision,
            'sourceVersion', current_version.external_version_id,
            'driveId', evidence.drive_id,
            'deepLink', obligation.citation_locator->>'sourceUri',
            'aclRevision', evidence.acl_revision,
            'authorizationObservedAt', evidence.observed_at,
            'authorizationExpiresAt', evidence.expires_at,
            'reauthorizedAt', pg_catalog.statement_timestamp()
          ))
          FROM knowledge_source_objects object_row
          JOIN knowledge_document_versions current_version
            ON current_version.id = object_row.current_version_id
           AND current_version.object_id = object_row.id
          JOIN knowledge_sources source_row ON source_row.id = object_row.source_id
          JOIN knowledge_providers provider_row ON provider_row.id = source_row.provider_id
          JOIN knowledge_source_sync_index_obligations obligation
            ON obligation.knowledge_document_version_id = current_version.id
           AND obligation.document_id = p_document_id
          JOIN google_drive_object_acl_evidence evidence
            ON evidence.id = obligation.google_drive_acl_evidence_id
           AND evidence.index_obligation_id = obligation.id
          WHERE current_version.account_id = p_account_id
            AND current_version.document_id = p_document_id
            AND current_version.file_id = p_file_id
            AND provider_row.provider_key = 'google-drive'
            AND object_row.lifecycle_state = 'active'
            AND source_row.lifecycle_state = 'active'
            AND obligation.status = 'indexed'
            AND obligation.acl_eligibility = 'eligible'
            AND evidence.eligibility = 'eligible'
            AND evidence.expires_at > pg_catalog.statement_timestamp()
          ORDER BY evidence.created_at DESC, evidence.id DESC
          LIMIT 1
        INTO citation;
        DELETE FROM opengeni_private.google_drive_object_acl_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'citation';
        RETURN citation;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.google_drive_object_acl_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'citation';
        RAISE;
      END;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.google_drive_file_authorized(uuid,uuid,text,uuid) FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.google_drive_document_citation(uuid,uuid,text,uuid,uuid) FROM PUBLIC',
    data_schema
  );
END
$google_drive_file_authority$;

DO $runtime_grants$
DECLARE data_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT ON "google_drive_object_acl_evidence" TO opengeni_app;
    GRANT SELECT, INSERT ON "google_drive_object_acl_principals" TO opengeni_app;
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.google_drive_file_authorized(uuid,uuid,text,uuid) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.google_drive_document_citation(uuid,uuid,text,uuid,uuid) TO opengeni_app',
      data_schema
    );
  END IF;
END
$runtime_grants$;

RESET statement_timeout;
RESET lock_timeout;