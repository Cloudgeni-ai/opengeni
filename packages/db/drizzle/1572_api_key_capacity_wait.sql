-- deployment-mode: rolling
-- contract-step: Replace the check with a strict superset; every previously accepted row and write remains valid.
ALTER TABLE "subscription_capacity_waiters"
  DROP CONSTRAINT "subscription_capacity_waiters_check",
  ADD CONSTRAINT "subscription_capacity_waiters_check" CHECK (
    provider IN ('codex', 'claude', 'xai', 'api_key')
    AND length(btrim(wait_reason)) BETWEEN 1 AND 128
  ) NOT VALID;

-- A previous worker cannot see api_key rows. It may try the fallback claim
-- for a waiting turn, or get a new control worker's recheck dispatch. Refuse
-- either before that claim can commit any pending-input or attempt writes.
CREATE FUNCTION guard_api_key_capacity_claim_protocol() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
  IF current_setting('opengeni.api_key_capacity_claim_v1', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'turn requires API key capacity claim protocol v1' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_api_key_capacity_claim_protocol() FROM PUBLIC;

CREATE TRIGGER api_key_capacity_claim_protocol_guard
  BEFORE UPDATE OF status ON session_turns
  FOR EACH ROW WHEN (
    OLD.status IN ('waiting_capacity', 'recovering') AND NEW.status = 'running'
    AND (OLD.metadata #> '{codexCapacityRecoveryV1,apiKeyRecheck}') = 'true'::jsonb
  )
  EXECUTE FUNCTION guard_api_key_capacity_claim_protocol();
