-- deployment-mode: rolling
-- Agent instructions claim gate (docs/run-lifecycle.md, "Agent instructions"):
-- a chat bound to an agent revision (sessions.agent_prompt_revision IS NOT
-- NULL) gets its agent's Instructions as a system-prompt layer and mid-chat
-- edits as developer history items. A worker build without that code would
-- run the chat without them, so a turn attempt for such a chat is refused
-- (SQLSTATE 55000) unless the claim declares
-- opengeni.agent_instructions_protocol_v1 = '1', which the worker sets only
-- around its own attempt registration (like the filesystem discontinuity
-- protocol of guard_explicit_workspace_recovery_warning). Chats with a NULL
-- agent_prompt_revision are unaffected.
--
-- A refused claim is not a failed chat: the worker parks the accepted work
-- behind sessions.admission_block (requires_action, explicit recheck) and an
-- explicit Resume or a new Send/Steer claims it again on a current worker.
--
-- The function runs as the claimer (SECURITY INVOKER) and switches the
-- tenancy settings to the attempt's workspace with no person while it reads
-- the session, then restores them.
--
-- Rolling: nothing sets agent_prompt_revision before the release that adds
-- this gate's worker, so the previous release's claims are never refused
-- while it is the only worker; the trigger only adds a single-row read by
-- primary key to each claim.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION guard_agent_instructions_claim_protocol() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  prior_subject text := coalesce(current_setting('opengeni.subject_id', true), '');
  prior_account text := coalesce(current_setting('opengeni.account_id', true), '');
  prior_workspace text := coalesce(current_setting('opengeni.workspace_id', true), '');
  prompt_revision integer;
BEGIN
  IF current_setting('opengeni.agent_instructions_protocol_v1', true) = '1' THEN
    RETURN NEW;
  END IF;
  PERFORM set_config('opengeni.subject_id', '', true);
  PERFORM set_config('opengeni.account_id', NEW.account_id::text, true);
  PERFORM set_config('opengeni.workspace_id', NEW.workspace_id::text, true);
  SELECT s.agent_prompt_revision INTO prompt_revision
  FROM sessions s
  WHERE s.workspace_id = NEW.workspace_id AND s.id = NEW.session_id;
  PERFORM set_config('opengeni.subject_id', prior_subject, true);
  PERFORM set_config('opengeni.account_id', prior_account, true);
  PERFORM set_config('opengeni.workspace_id', prior_workspace, true);
  IF prompt_revision IS NOT NULL THEN
    RAISE EXCEPTION 'session requires agent instructions protocol v1' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_agent_instructions_claim_protocol() FROM PUBLIC;

DROP TRIGGER IF EXISTS agent_instructions_claim_protocol_guard ON session_turn_attempts;
CREATE TRIGGER agent_instructions_claim_protocol_guard
  BEFORE INSERT ON session_turn_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_agent_instructions_claim_protocol();
