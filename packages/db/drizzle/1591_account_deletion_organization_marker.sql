-- deployment-mode: rolling
SET LOCAL lock_timeout = '2s';
-- Both the concurrent index and the eraser use this bounded, immutable
-- decoder. Legacy verifier values which cannot be represented as JSONB must
-- not prevent the index from building or block sign-in writes.
CREATE FUNCTION opengeni_private.account_deletion_verification_subject_v1(p_identifier text, p_value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path TO pg_catalog, pg_temp AS $$
DECLARE decoded jsonb;
BEGIN
  IF p_identifier LIKE 'reset-password:%' THEN RETURN p_value; END IF;
  IF p_identifier NOT LIKE 'opengeni-native-app-code:%' AND p_identifier NOT LIKE 'managed-sign-in:%'
    AND p_identifier NOT LIKE 'opengeni-passkey:%' AND p_identifier NOT LIKE 'opengeni-passkey-handoff:%'
    THEN RETURN NULL; END IF;
  BEGIN
    decoded := p_value::jsonb;
  EXCEPTION WHEN data_exception THEN
    RETURN NULL;
  END;
  RETURN coalesce(decoded->>'authUserId', decoded->>'userId');
END $$;
REVOKE ALL ON FUNCTION opengeni_private.account_deletion_verification_subject_v1(text,text) FROM PUBLIC;
DO $access$
DECLARE application_role text;
BEGIN
  FOR application_role IN
    SELECT rolname FROM pg_roles WHERE rolname = 'opengeni_app'
      OR rolname IN (SELECT jsonb_array_elements_text(coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb))
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.account_deletion_verification_subject_v1(text,text) TO %I', application_role);
  END LOOP;
END $access$;

-- Keep the managed-account DDL lock out of transactions touching workspaces,
-- files or editable artifacts.
ALTER TABLE managed_accounts ADD COLUMN closed_by_account_deletion uuid;
