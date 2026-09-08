-- deployment-mode: rolling
-- Provider affinity is bookkeeping, not semantic conversation activity. Preserve
-- both updated_at and the activity revision when switching a workspace pool.
-- Existing API/worker binaries use this same trigger, so the bulk fix is rolling.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE OR REPLACE FUNCTION opengeni_private.clear_workspace_codex_session_affinity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
BEGIN
  UPDATE sessions
  SET codex_pinned_credential_id = NULL,
      codex_pin_source = NULL,
      codex_last_credential_id = NULL
  WHERE account_id = NEW.account_id AND workspace_id = NEW.workspace_id
    AND (codex_pinned_credential_id IS NOT NULL OR codex_last_credential_id IS NOT NULL);
  RETURN NEW;
END
$body$;
-- CREATE OR REPLACE retains the existing owner and PUBLIC-revoked ACL.
