-- deployment-mode: rolling
-- Freeze the setup-link transport at the same first-provider boundary as the
-- immutable payload digest. The nullable column preserves old API binaries;
-- new binaries can recover an already-prepared legacy row by matching its
-- digest before setting the missing transport.

ALTER TABLE organization_user_setup_deliveries
  ADD COLUMN setup_token_transport text;

ALTER TABLE organization_user_setup_deliveries
  ADD CONSTRAINT organization_user_setup_deliveries_token_transport_check
  CHECK (setup_token_transport IS NULL OR setup_token_transport IN ('fragment', 'query'));

CREATE FUNCTION claim_organization_user_setup_delivery_v2(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  result jsonb;
  delivery_id_value uuid;
  delivery organization_user_setup_deliveries%ROWTYPE;
BEGIN
  result := claim_organization_user_setup_delivery(p_command);
  IF result ->> 'claimed' IS DISTINCT FROM 'true' THEN
    RETURN result;
  END IF;
  delivery_id_value := nullif(result #>> '{delivery,id}', '')::uuid;
  PERFORM set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  SELECT * INTO delivery FROM organization_user_setup_deliveries candidate
  WHERE candidate.id = delivery_id_value;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization setup delivery is unavailable' USING ERRCODE = 'P0002';
  END IF;
  RETURN result || jsonb_build_object(
    'setupTokenTransport', delivery.setup_token_transport,
    'payloadDigest', delivery.payload_digest
  );
END
$body$;

CREATE FUNCTION prepare_organization_user_setup_delivery_v2(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  delivery_id_value uuid := nullif(p_command ->> 'deliveryId', '')::uuid;
  setup_token_transport_value text := p_command ->> 'setupTokenTransport';
  result jsonb;
  frozen_transport text;
BEGIN
  IF delivery_id_value IS NULL
    OR setup_token_transport_value IS NULL
    OR setup_token_transport_value NOT IN ('fragment', 'query')
  THEN
    RAISE EXCEPTION 'organization setup delivery transport preparation is invalid'
      USING ERRCODE = '42501';
  END IF;
  result := prepare_organization_user_setup_delivery(p_command);
  UPDATE organization_user_setup_deliveries SET
    setup_token_transport = coalesce(setup_token_transport, setup_token_transport_value)
  WHERE id = delivery_id_value
    AND (
      setup_token_transport IS NULL
      OR setup_token_transport = setup_token_transport_value
    )
  RETURNING setup_token_transport INTO frozen_transport;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization setup delivery transport changed under retry'
      USING ERRCODE = '23505';
  END IF;
  RETURN result || jsonb_build_object('setupTokenTransport', frozen_transport);
END
$body$;

DO $hardening$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.claim_organization_user_setup_delivery_v2(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.prepare_organization_user_setup_delivery_v2(jsonb) SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.claim_organization_user_setup_delivery_v2(jsonb) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.prepare_organization_user_setup_delivery_v2(jsonb) TO opengeni_app',
      data_schema
    );
  END IF;
END
$hardening$;

REVOKE ALL ON FUNCTION claim_organization_user_setup_delivery_v2(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION prepare_organization_user_setup_delivery_v2(jsonb) FROM PUBLIC;

COMMENT ON COLUMN organization_user_setup_deliveries.setup_token_transport IS
  'Fragment or query transport frozen at first preparation; NULL only for rolling old-binary rows pending digest recovery.';
COMMENT ON FUNCTION claim_organization_user_setup_delivery_v2(jsonb) IS
  'Rolling claim projection including the frozen setup transport and legacy payload digest.';
COMMENT ON FUNCTION prepare_organization_user_setup_delivery_v2(jsonb) IS
  'Prepares provider delivery and atomically freezes the setup-link transport.';