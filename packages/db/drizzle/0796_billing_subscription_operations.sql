-- deployment-mode: maintenance
-- maintenance-justification: The prior binary rejects undeclared FORCE-RLS tables/runtime grants in readiness. Drain old API/workers and start only the operation-receipt-aware binary; subscription mutation retries must not resolve a new target after provider key expiry.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE billing_subscription_operations (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  operation_key uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('upgrade', 'change', 'cancel')),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object' AND coalesce(jsonb_typeof(intent->'subscriptionId') = 'string' AND length(intent->>'subscriptionId') BETWEEN 1 AND 255, false)),
  result jsonb CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (account_id, operation_key),
  CHECK ((result IS NULL) = (completed_at IS NULL))
);
-- An unresolved provider outcome must reconcile before another API action can
-- overwrite its Stripe marker. Webhook synchronization remains independent.
CREATE UNIQUE INDEX billing_subscription_operations_pending_idx
  ON billing_subscription_operations(account_id) WHERE completed_at IS NULL;
ALTER TABLE billing_subscription_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_subscription_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_subscription_operations_account_isolation ON billing_subscription_operations
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

CREATE FUNCTION begin_billing_subscription_operation(p_account_id uuid, p_key uuid, p_kind text, p_request jsonb, p_intent jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE receipt billing_subscription_operations%ROWTYPE;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Subscription operation account scope mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || p_account_id::text, 0));
  SELECT * INTO receipt FROM billing_subscription_operations WHERE account_id = p_account_id AND operation_key = p_key;
  IF FOUND THEN
    IF receipt.kind IS DISTINCT FROM p_kind OR receipt.request IS DISTINCT FROM p_request THEN
      RAISE EXCEPTION 'Subscription operation key already binds a different request' USING ERRCODE = '23505';
    END IF;
    RETURN to_jsonb(receipt);
  END IF;
  IF EXISTS (SELECT 1 FROM billing_subscription_operations WHERE account_id = p_account_id AND completed_at IS NULL) THEN
    RAISE EXCEPTION 'Reconcile the pending subscription operation before starting another' USING ERRCODE = 'P0S02';
  END IF;
  INSERT INTO billing_subscription_operations(account_id, operation_key, kind, request, intent)
    VALUES (p_account_id, p_key, p_kind, p_request, p_intent) RETURNING * INTO receipt;
  RETURN to_jsonb(receipt);
END $body$;

CREATE FUNCTION complete_billing_subscription_operation(p_account_id uuid, p_key uuid, p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE receipt billing_subscription_operations%ROWTYPE;
BEGIN
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Subscription operation account scope mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_result IS NULL OR jsonb_typeof(p_result) <> 'object' THEN
    RAISE EXCEPTION 'Subscription operation result must be an object' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('organization-membership:' || p_account_id::text, 0));
  SELECT * INTO receipt FROM billing_subscription_operations WHERE account_id = p_account_id AND operation_key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Subscription operation intent is missing' USING ERRCODE = '55000'; END IF;
  IF receipt.completed_at IS NOT NULL THEN
    IF receipt.result IS DISTINCT FROM p_result THEN
      RAISE EXCEPTION 'Subscription operation result is immutable' USING ERRCODE = '23505';
    END IF;
    RETURN to_jsonb(receipt);
  END IF;
  UPDATE billing_subscription_operations SET result = p_result, completed_at = clock_timestamp()
    WHERE account_id = p_account_id AND operation_key = p_key RETURNING * INTO receipt;
  RETURN to_jsonb(receipt);
END $body$;

REVOKE ALL ON TABLE billing_subscription_operations FROM PUBLIC;
REVOKE ALL ON FUNCTION begin_billing_subscription_operation(uuid,uuid,text,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_billing_subscription_operation(uuid,uuid,jsonb) FROM PUBLIC;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT ON TABLE billing_subscription_operations TO opengeni_app;
    GRANT EXECUTE ON FUNCTION begin_billing_subscription_operation(uuid,uuid,text,jsonb,jsonb) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION complete_billing_subscription_operation(uuid,uuid,jsonb) TO opengeni_app;
  END IF;
END $grant$;
