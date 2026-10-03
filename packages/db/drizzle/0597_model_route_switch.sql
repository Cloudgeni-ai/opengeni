-- deployment-mode: rolling
-- Deployment-level runtime switch that moves one credits product between its
-- primary route and the reviewed fallback route declared in the database model
-- catalog (`fallbackRoutes`). The product id users see, its pricing and its
-- credits billing never change; only the provider that serves NEW turns does.
-- Accepted turns keep the route frozen in their execution policy. A product
-- with no revision runs on its primary route, so this migration changes nothing
-- until an operator calls set_model_route. Catalog resolution reads the newest
-- revision per product on every resolution, so a flip applies to the next
-- admitted turn on every replica without a deploy or restart. A revision for a
-- product without a declared fallback route is inert.
SET LOCAL lock_timeout = '5s';

-- Append-only: every row is one audited switch revision, and the newest row for
-- a product is its current route. Runtime roles get SELECT only (via
-- provisionRoles); nothing but the owner-only setter below writes here.
CREATE TABLE opengeni_private.model_route_switch_revisions (
  revision bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_model_id text NOT NULL CHECK (
    product_model_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  ),
  route text NOT NULL CHECK (route IN ('primary', 'fallback')),
  previous_route text CHECK (previous_route IN ('primary', 'fallback')),
  operator text NOT NULL CHECK (
    operator = pg_catalog.btrim(operator)
    AND pg_catalog.char_length(operator) BETWEEN 1 AND 200
  ),
  reason text NOT NULL CHECK (
    reason = pg_catalog.btrim(reason)
    AND pg_catalog.char_length(reason) BETWEEN 6 AND 1000
  ),
  database_role text NOT NULL DEFAULT session_user,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
REVOKE ALL ON opengeni_private.model_route_switch_revisions FROM PUBLIC;
CREATE INDEX model_route_switch_revisions_product_idx
  ON opengeni_private.model_route_switch_revisions (product_model_id, revision DESC);

CREATE FUNCTION reject_model_route_switch_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  RAISE EXCEPTION 'model route switch revisions are append-only'
    USING ERRCODE = '55000';
END
$body$;
REVOKE ALL ON FUNCTION reject_model_route_switch_revision_mutation() FROM PUBLIC;

CREATE TRIGGER model_route_switch_revisions_immutable
BEFORE UPDATE OR DELETE ON opengeni_private.model_route_switch_revisions
FOR EACH ROW EXECUTE FUNCTION reject_model_route_switch_revision_mutation();
CREATE TRIGGER model_route_switch_revisions_no_truncate
BEFORE TRUNCATE ON opengeni_private.model_route_switch_revisions
FOR EACH STATEMENT EXECUTE FUNCTION reject_model_route_switch_revision_mutation();

-- Operator-only audited setter. It lives in the data schema so its EXECUTE ACL
-- is not swept by the opengeni_private runtime grant; PUBLIC and every runtime
-- role stay revoked (provisionRoles converges late roles, and runtime posture
-- fails if either gains EXECUTE). The advisory lock serializes concurrent
-- operator calls so each audit row records the exact previous route.
CREATE FUNCTION set_model_route(
  p_product_model_id text,
  p_route text,
  p_operator text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
SET lock_timeout = '10s'
AS $body$
DECLARE
  previous text;
  written opengeni_private.model_route_switch_revisions%ROWTYPE;
BEGIN
  IF p_product_model_id IS NULL
    OR p_product_model_id !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
  THEN
    RAISE EXCEPTION 'model route switch product id must be a catalog product id'
      USING ERRCODE = '22023';
  END IF;
  IF p_route IS NULL OR p_route NOT IN ('primary', 'fallback') THEN
    RAISE EXCEPTION 'model route switch route must be primary or fallback'
      USING ERRCODE = '22023';
  END IF;
  IF p_operator IS NULL OR p_operator <> pg_catalog.btrim(p_operator)
    OR pg_catalog.char_length(p_operator) NOT BETWEEN 1 AND 200
  THEN
    RAISE EXCEPTION 'model route switch operator must be 1-200 trimmed characters'
      USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR p_reason <> pg_catalog.btrim(p_reason)
    OR pg_catalog.char_length(p_reason) NOT BETWEEN 6 AND 1000
  THEN
    RAISE EXCEPTION 'model route switch reason must be 6-1000 trimmed characters'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('model-route-switch', 0)
  );
  SELECT revision.route
  INTO previous
  FROM opengeni_private.model_route_switch_revisions revision
  WHERE revision.product_model_id = p_product_model_id
  ORDER BY revision.revision DESC
  LIMIT 1;

  INSERT INTO opengeni_private.model_route_switch_revisions (
    product_model_id, route, previous_route, operator, reason, database_role
  ) VALUES (
    p_product_model_id, p_route, previous, p_operator, p_reason, session_user
  )
  RETURNING * INTO written;

  RETURN pg_catalog.jsonb_build_object(
    'revision', written.revision,
    'productModelId', written.product_model_id,
    'route', written.route,
    'previousRoute', written.previous_route,
    'changed', COALESCE(written.previous_route, 'primary') <> written.route,
    'operator', written.operator,
    'reason', written.reason,
    'databaseRole', written.database_role,
    'changedAt', written.changed_at
  );
END
$body$;

REVOKE ALL ON FUNCTION set_model_route(text, text, text, text) FROM PUBLIC;

-- REVOKE FROM PUBLIC leaves grants that out-of-band ALTER DEFAULT PRIVILEGES
-- gave named roles at CREATE time. Strip every non-owner grantee from the new
-- table and the setter so no runtime role can write the switch or call the
-- setter before db:provision-roles runs; provisioning then grants SELECT only.
DO $switch_acl$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT role_row.rolname FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      relation.relacl, pg_catalog.acldefault('r', relation.relowner)
    )) privilege
    JOIN pg_catalog.pg_roles role_row ON role_row.oid = privilege.grantee
    WHERE relation.oid = 'opengeni_private.model_route_switch_revisions'::regclass
      AND privilege.grantee <> relation.relowner
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE opengeni_private.model_route_switch_revisions FROM %I',
      grantee_name
    );
  END LOOP;
  FOR grantee_name IN
    SELECT DISTINCT role_row.rolname FROM pg_catalog.pg_proc routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      routine.proacl, pg_catalog.acldefault('f', routine.proowner)
    )) privilege
    JOIN pg_catalog.pg_roles role_row ON role_row.oid = privilege.grantee
    WHERE routine.oid = 'set_model_route(text, text, text, text)'::regprocedure
      AND privilege.grantee <> routine.proowner
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %I.set_model_route(text, text, text, text) FROM %I',
      pg_catalog.current_schema(),
      grantee_name
    );
  END LOOP;
END
$switch_acl$;

DO $posture$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.set_model_route(text, text, text, text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema,
    data_schema
  );
END
$posture$;
