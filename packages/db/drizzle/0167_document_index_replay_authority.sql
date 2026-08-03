-- deployment-mode: rolling
-- Resolve only the immutable document authority tuple for historical
-- three-field document-index Temporal payloads. The ordinary documents policy
-- remains unchanged: personal content is still invisible without its exact
-- subject. This SECURITY DEFINER capability returns no content and manually
-- enforces the caller's already-applied account/workspace RLS context before
-- reading the exact document identity.

DO $document_index_authority_resolver$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.resolve_document_index_authority(
      p_account_id uuid,
      p_workspace_id uuid,
      p_document_id uuid
    )
    RETURNS TABLE (
      authority_kind text,
      authority_workspace_id uuid,
      authority_subject_id text
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $body$
    BEGIN
      IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
        OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
      THEN
        RAISE EXCEPTION 'document index authority lookup requires exact account/workspace RLS context'
          USING ERRCODE = '42501';
      END IF;

      RETURN QUERY
      SELECT
        document.authority_kind,
        document.authority_workspace_id,
        document.authority_subject_id
      FROM %1$I.documents document
      WHERE document.account_id = p_account_id
        AND document.workspace_id = p_workspace_id
        AND document.id = p_document_id
      LIMIT 1;
    END;
    $body$;
  $ddl$, data_schema);
END
$document_index_authority_resolver$;

REVOKE ALL ON FUNCTION opengeni_private.resolve_document_index_authority(uuid, uuid, uuid)
  FROM PUBLIC;

DO $runtime_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.resolve_document_index_authority(uuid, uuid, uuid)
      TO opengeni_app;
  END IF;
END
$runtime_grant$;