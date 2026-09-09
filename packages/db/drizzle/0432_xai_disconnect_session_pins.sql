-- deployment-mode: rolling
-- Preserve the pin invariant when disconnecting an account referenced by sessions.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';
DO $disconnect_pins$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.disconnect_xai_subscription_credential(
      p_account_id uuid,
      p_workspace_id uuid,
      p_subject_id text,
      p_credential_id uuid,
      p_snapshot jsonb
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      credential_row record;
    BEGIN
      IF p_account_id IS DISTINCT FROM NULLIF(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM NULLIF(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_subject_id IS DISTINCT FROM NULLIF(current_setting('opengeni.subject_id', true), '')
      THEN
        RAISE EXCEPTION 'xAI credential lifecycle authority denied' USING ERRCODE = '42501';
      END IF;

      SELECT credential.* INTO credential_row
      FROM revalidate_xai_subscription_authority(
        p_workspace_id, p_subject_id, p_credential_id, p_snapshot
      ) authorized
      INNER JOIN xai_subscription_credentials credential ON credential.id = authorized.id
      FOR UPDATE OF credential;
      IF credential_row.id IS NULL THEN RETURN false; END IF;

      INSERT INTO opengeni_private.xai_subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'lifecycle')
      ON CONFLICT DO NOTHING;

      -- Clear the coupled pin fields before the foreign key nulls its id.
      -- Keep the row/version so stale session pin edits still fail their CAS.
      UPDATE xai_session_account_pins
      SET pinned_credential_id = NULL, pin_source = NULL,
          version = version + 1, updated_at = now()
      WHERE account_id = credential_row.account_id
        AND workspace_id = credential_row.workspace_id
        AND pinned_credential_id = credential_row.id;

      DELETE FROM xai_subscription_credentials WHERE id = credential_row.id;
      IF credential_row.authority_scope = 'user' THEN
        UPDATE organization_user_resource_authorities
        SET status = 'revoked', revoked_at = now(), updated_at = now()
        WHERE id = credential_row.organization_user_resource_authority_id
          AND account_id = credential_row.account_id
          AND organization_membership_id = credential_row.owner_organization_membership_id
          AND resource_kind = 'xai_subscription'
          AND resource_id = credential_row.id
          AND generation = credential_row.organization_user_resource_authority_generation;
      END IF;

      DELETE FROM opengeni_private.xai_subscription_runtime_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'lifecycle';
      RETURN true;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM opengeni_private.xai_subscription_runtime_capabilities
      WHERE backend_pid = pg_catalog.pg_backend_pid()
        AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability_kind = 'lifecycle';
      RAISE;
    END
    $body$;
  $ddl$, data_schema);
END
$disconnect_pins$;
-- CREATE OR REPLACE retains the existing owner and PUBLIC-revoked ACL.
