-- deployment-mode: rolling
-- Add organization registrations without changing workspace registration scope.
-- Existing workspace claims remain compatible; new APIs dispatch both lanes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE organization_credential_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret_encrypted text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  timeout_ms integer NOT NULL DEFAULT 10000,
  workspace_filter jsonb,
  created_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_credential_providers_url_chk CHECK (
    char_length(url) BETWEEN 8 AND 2048 AND (url LIKE 'https://%' OR url LIKE 'http://%')
  ),
  CONSTRAINT organization_credential_providers_timeout_chk CHECK (timeout_ms BETWEEN 1000 AND 30000),
  CONSTRAINT organization_credential_providers_subject_chk CHECK (
    created_by_subject_id IS NULL OR octet_length(created_by_subject_id) BETWEEN 1 AND 1024
  ),
  CONSTRAINT organization_credential_providers_filter_chk CHECK (
    workspace_filter IS NULL OR (
      jsonb_typeof(workspace_filter) = 'object'
      AND workspace_filter - 'externalSource' = '{}'::jsonb
      AND (NOT workspace_filter ? 'externalSource' OR (
        jsonb_typeof(workspace_filter -> 'externalSource') = 'string'
        AND octet_length(workspace_filter ->> 'externalSource') BETWEEN 1 AND 200
      ))
    )
  )
);
CREATE UNIQUE INDEX organization_credential_providers_account_uq
  ON organization_credential_providers(account_id);

CREATE TABLE organization_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret_encrypted text NOT NULL,
  event_types text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  description text,
  workspace_filter jsonb,
  created_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_webhooks_account_id_uq UNIQUE(account_id, id),
  CONSTRAINT organization_webhooks_url_chk CHECK (
    char_length(url) BETWEEN 8 AND 2048 AND (url LIKE 'https://%' OR url LIKE 'http://%')
  ),
  CONSTRAINT organization_webhooks_event_types_chk CHECK (
    cardinality(event_types) BETWEEN 1 AND 16 AND event_types <@ ARRAY[
      'turn.completed', 'turn.failed', 'turn.cancelled', 'session.status.changed',
      'session.requiresAction', 'session.humanInput.requested'
    ]::text[]
  ),
  CONSTRAINT organization_webhooks_description_chk CHECK (description IS NULL OR char_length(description) <= 500),
  CONSTRAINT organization_webhooks_subject_chk CHECK (
    created_by_subject_id IS NULL OR octet_length(created_by_subject_id) BETWEEN 1 AND 1024
  ),
  CONSTRAINT organization_webhooks_filter_chk CHECK (
    workspace_filter IS NULL OR (
      jsonb_typeof(workspace_filter) = 'object'
      AND workspace_filter - 'externalSource' = '{}'::jsonb
      AND (NOT workspace_filter ? 'externalSource' OR (
        jsonb_typeof(workspace_filter -> 'externalSource') = 'string'
        AND octet_length(workspace_filter ->> 'externalSource') BETWEEN 1 AND 200
      ))
    )
  )
);
CREATE INDEX organization_webhooks_account_idx ON organization_webhooks(account_id, created_at);

CREATE TABLE organization_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  webhook_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  failed_at timestamptz,
  last_status integer,
  last_error text,
  claim_id uuid,
  claim_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_webhook_deliveries_workspace_account_fk FOREIGN KEY(workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT organization_webhook_deliveries_webhook_fk FOREIGN KEY(account_id, webhook_id)
    REFERENCES organization_webhooks(account_id, id) ON DELETE CASCADE,
  CONSTRAINT organization_webhook_deliveries_attempts_chk CHECK (attempts >= 0),
  CONSTRAINT organization_webhook_deliveries_claim_chk CHECK ((claim_id IS NULL) = (claim_until IS NULL)),
  CONSTRAINT organization_webhook_deliveries_terminal_chk CHECK (delivered_at IS NULL OR failed_at IS NULL),
  CONSTRAINT organization_webhook_deliveries_error_chk CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  CONSTRAINT organization_webhook_deliveries_payload_chk CHECK (octet_length(payload::text) <= 16384)
);
CREATE UNIQUE INDEX organization_webhook_deliveries_event_uq ON organization_webhook_deliveries(webhook_id, event_id);
CREATE INDEX organization_webhook_deliveries_due_idx ON organization_webhook_deliveries(next_attempt_at, id)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
CREATE INDEX organization_webhook_deliveries_webhook_recent_idx ON organization_webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX organization_webhook_deliveries_settled_idx ON organization_webhook_deliveries(created_at)
  WHERE delivered_at IS NOT NULL OR failed_at IS NOT NULL;

ALTER TABLE organization_credential_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_credential_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_credential_providers_account_scope ON organization_credential_providers
  USING (account_id = opengeni_private.current_account_id() AND opengeni_private.current_workspace_id() IS NULL)
  WITH CHECK (account_id = opengeni_private.current_account_id() AND opengeni_private.current_workspace_id() IS NULL);
-- Workspace runtime reads reach an organization secret only through the exact
-- scoped resolver. Account-only configuration remains the administrator lane.
CREATE POLICY organization_credential_providers_resolver_owner ON organization_credential_providers FOR SELECT
  USING (
    account_id = opengeni_private.current_account_id()
    AND enabled
    AND current_user = (
      SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class
      WHERE oid = 'organization_credential_providers'::regclass
    )
    AND EXISTS (
      SELECT 1 FROM workspaces workspace
      WHERE workspace.id = opengeni_private.current_workspace_id()
        AND workspace.account_id = organization_credential_providers.account_id
        AND (workspace_filter IS NULL OR NOT workspace_filter ? 'externalSource'
          OR workspace_filter ->> 'externalSource' = workspace.external_source)
    )
  );
ALTER TABLE organization_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_webhooks_account_scope ON organization_webhooks
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());
CREATE POLICY organization_webhooks_dispatcher_owner ON organization_webhooks FOR SELECT
  USING (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class
    WHERE oid = 'organization_webhooks'::regclass
  ));
ALTER TABLE organization_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_webhook_deliveries_account_scope ON organization_webhook_deliveries
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());
CREATE POLICY organization_webhook_deliveries_dispatcher_owner ON organization_webhook_deliveries
  USING (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class
    WHERE oid = 'organization_webhook_deliveries'::regclass
  ))
  WITH CHECK (current_user = (
    SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class
    WHERE oid = 'organization_webhook_deliveries'::regclass
  ));
REVOKE ALL ON organization_credential_providers, organization_webhooks, organization_webhook_deliveries FROM PUBLIC;

CREATE FUNCTION opengeni_private.resolve_organization_credential_provider_v1(
  p_account uuid, p_workspace uuid
) RETURNS SETOF organization_credential_providers
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $provider$
BEGIN
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'integration credential scope invalid' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT provider.* FROM organization_credential_providers provider
    JOIN workspaces workspace ON workspace.id = p_workspace AND workspace.account_id = provider.account_id
    WHERE provider.account_id = p_account AND provider.enabled
      AND (provider.workspace_filter IS NULL OR NOT provider.workspace_filter ? 'externalSource'
        OR provider.workspace_filter ->> 'externalSource' = workspace.external_source);
END $provider$;
REVOKE ALL ON FUNCTION opengeni_private.resolve_organization_credential_provider_v1(uuid,uuid) FROM PUBLIC;

-- No direct runtime SELECT on external_identities. The owner-run seam uses its
-- existing lifecycle policy and restores the marker, including on exceptions.
-- It validates BOTH account and workspace context before returning attribution.
CREATE FUNCTION opengeni_private.resolve_integration_initiating_human_v1(
  p_account uuid, p_workspace uuid, p_subject text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $human$
DECLARE
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  identity_value jsonb;
BEGIN
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN RAISE EXCEPTION 'integration attribution scope invalid' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = p_workspace AND account_id = p_account)
    OR p_subject IS NULL THEN RETURN NULL; END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'external_identity_provisioning', true);
  IF p_subject LIKE 'external_user:%' THEN
    SELECT jsonb_build_object('source', source, 'externalId', external_id)
      INTO identity_value FROM external_identities
      WHERE account_id = p_account AND subject_id = p_subject;
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
  RETURN jsonb_build_object('subjectId', p_subject, 'externalIdentity', identity_value);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
  RAISE;
END $human$;
REVOKE ALL ON FUNCTION opengeni_private.resolve_integration_initiating_human_v1(uuid,uuid,text) FROM PUBLIC;

-- Shared thin event projection. Resolve the human from the exact immutable
-- turn, never payload metadata or session creator. Missing/service turns stay null.
CREATE FUNCTION opengeni_private.integration_webhook_payload_v1(
  p_account uuid, p_workspace uuid, p_event uuid, p_type text, p_session uuid,
  p_turn uuid, p_sequence bigint, p_occurred timestamptz, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT
AS $payload$
DECLARE workspace_value jsonb; subject_value text; human_value jsonb;
BEGIN
  SELECT jsonb_build_object('id', id, 'externalSource', external_source, 'externalId', external_id)
    INTO workspace_value FROM workspaces WHERE id = p_workspace AND account_id = p_account;
  IF p_type IN ('turn.completed', 'turn.failed', 'turn.cancelled') AND p_turn IS NOT NULL THEN
    SELECT initiating_human_subject_id INTO subject_value FROM session_turns
      WHERE id = p_turn AND session_id = p_session AND workspace_id = p_workspace AND account_id = p_account;
    human_value := opengeni_private.resolve_integration_initiating_human_v1(p_account, p_workspace, subject_value);
  END IF;
  RETURN jsonb_build_object(
    'id', p_event, 'type', p_type, 'workspaceId', p_workspace, 'workspace', workspace_value,
    'sessionId', p_session, 'turnId', p_turn, 'initiatingHuman', human_value,
    'sequence', p_sequence,
    'occurredAt', to_char(p_occurred AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'data', jsonb_strip_nulls(jsonb_build_object(
      'status', CASE WHEN jsonb_typeof(p_payload -> 'status') = 'string' THEN left(p_payload ->> 'status', 64) END,
      'reason', CASE WHEN jsonb_typeof(p_payload -> 'reason') = 'string' THEN left(p_payload ->> 'reason', 200) END
    ))
  );
END $payload$;
REVOKE ALL ON FUNCTION opengeni_private.integration_webhook_payload_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,timestamptz,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION opengeni_private.enqueue_workspace_webhook_deliveries_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT
AS $enqueue$
BEGIN
  BEGIN
    INSERT INTO workspace_webhook_deliveries(account_id, workspace_id, webhook_id, event_id, event_type, payload)
      SELECT webhook.account_id, webhook.workspace_id, webhook.id, NEW.id, NEW.type,
        opengeni_private.integration_webhook_payload_v1(
          NEW.account_id, NEW.workspace_id, NEW.id, NEW.type, NEW.session_id,
          NEW.turn_id, NEW.sequence, NEW.occurred_at, NEW.payload)
      FROM workspace_webhooks webhook
      WHERE webhook.account_id = NEW.account_id AND webhook.workspace_id = NEW.workspace_id
        AND webhook.enabled AND NEW.type = ANY(webhook.event_types)
      ON CONFLICT(webhook_id, event_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'workspace webhook enqueue skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END $enqueue$;

CREATE FUNCTION opengeni_private.enqueue_organization_webhook_deliveries_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT
AS $enqueue$
BEGIN
  BEGIN
    INSERT INTO organization_webhook_deliveries(account_id, workspace_id, webhook_id, event_id, event_type, payload)
      SELECT webhook.account_id, NEW.workspace_id, webhook.id, NEW.id, NEW.type,
        opengeni_private.integration_webhook_payload_v1(
          NEW.account_id, NEW.workspace_id, NEW.id, NEW.type, NEW.session_id,
          NEW.turn_id, NEW.sequence, NEW.occurred_at, NEW.payload)
      FROM organization_webhooks webhook
      JOIN workspaces workspace ON workspace.id = NEW.workspace_id AND workspace.account_id = webhook.account_id
      WHERE webhook.account_id = NEW.account_id AND webhook.enabled AND NEW.type = ANY(webhook.event_types)
        AND (webhook.workspace_filter IS NULL OR NOT webhook.workspace_filter ? 'externalSource'
          OR webhook.workspace_filter ->> 'externalSource' = workspace.external_source)
      ON CONFLICT(webhook_id, event_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'organization webhook enqueue skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END $enqueue$;
REVOKE ALL ON FUNCTION opengeni_private.enqueue_organization_webhook_deliveries_v1() FROM PUBLIC;

CREATE TRIGGER session_events_organization_webhook_enqueue_v1
AFTER INSERT ON session_events FOR EACH ROW
WHEN (NEW.duplicate_of_event_id IS NULL AND NEW.type IN (
  'turn.completed', 'turn.failed', 'turn.cancelled', 'session.status.changed',
  'session.requiresAction', 'session.humanInput.requested'
))
EXECUTE FUNCTION opengeni_private.enqueue_organization_webhook_deliveries_v1();

CREATE FUNCTION opengeni_private.claim_organization_webhook_deliveries_v1(
  p_claim_id uuid, p_limit integer, p_claim_seconds integer
) RETURNS TABLE (
  delivery_id uuid, account_id uuid, workspace_id uuid, webhook_id uuid, event_id uuid,
  event_type text, payload jsonb, attempts integer, url text, secret_encrypted text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $claim$
BEGIN
  IF p_claim_id IS NULL THEN RAISE EXCEPTION 'webhook delivery claim id is required' USING ERRCODE = '22023'; END IF;
  RETURN QUERY WITH candidates AS MATERIALIZED (
    SELECT delivery.id FROM organization_webhook_deliveries delivery
    JOIN organization_webhooks webhook ON webhook.account_id = delivery.account_id AND webhook.id = delivery.webhook_id
    WHERE delivery.delivered_at IS NULL AND delivery.failed_at IS NULL AND delivery.next_attempt_at <= now()
      AND (delivery.claim_until IS NULL OR delivery.claim_until < now()) AND webhook.enabled
    ORDER BY delivery.next_attempt_at, delivery.id FOR UPDATE OF delivery SKIP LOCKED
    LIMIT greatest(1, least(coalesce(p_limit, 32), 100))
  ), claimed AS (
    UPDATE organization_webhook_deliveries delivery SET claim_id = p_claim_id,
      claim_until = now() + make_interval(secs => greatest(5, least(coalesce(p_claim_seconds, 60), 300))),
      attempts = delivery.attempts + 1 FROM candidates WHERE delivery.id = candidates.id RETURNING delivery.*
  )
  SELECT claimed.id, claimed.account_id, claimed.workspace_id, claimed.webhook_id, claimed.event_id,
    claimed.event_type, claimed.payload, claimed.attempts, webhook.url, webhook.secret_encrypted
  FROM claimed JOIN organization_webhooks webhook ON webhook.account_id = claimed.account_id AND webhook.id = claimed.webhook_id
  ORDER BY claimed.next_attempt_at, claimed.id;
END $claim$;

CREATE FUNCTION opengeni_private.settle_organization_webhook_delivery_v1(
  p_delivery_id uuid, p_claim_id uuid, p_status integer, p_error text, p_max_attempts integer
) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $settle$
  WITH settled AS (
    UPDATE organization_webhook_deliveries delivery SET claim_id = NULL, claim_until = NULL,
      last_status = p_status, last_error = left(p_error, 2000),
      delivered_at = CASE WHEN p_error IS NULL THEN now() END,
      failed_at = CASE WHEN p_error IS NOT NULL AND delivery.attempts >= greatest(1, least(coalesce(p_max_attempts, 12), 50)) THEN now() END,
      next_attempt_at = CASE WHEN p_error IS NULL THEN delivery.next_attempt_at ELSE now() + make_interval(
        secs => least(3600, greatest(5, 5 * power(2, least(greatest(delivery.attempts - 1, 0), 10))))::double precision) END
    WHERE delivery.id = p_delivery_id AND delivery.claim_id = p_claim_id
      AND delivery.delivered_at IS NULL AND delivery.failed_at IS NULL RETURNING true AS changed
  ) SELECT coalesce((SELECT changed FROM settled), false);
$settle$;

CREATE FUNCTION opengeni_private.prune_organization_webhook_deliveries_v1(
  p_retention_seconds integer, p_limit integer
) RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $prune$
  WITH doomed AS (
    SELECT delivery.id FROM organization_webhook_deliveries delivery
    WHERE (delivery.delivered_at IS NOT NULL OR delivery.failed_at IS NOT NULL)
      AND delivery.created_at < now() - make_interval(secs => greatest(3600, coalesce(p_retention_seconds, 604800)))
    ORDER BY delivery.created_at LIMIT greatest(1, least(coalesce(p_limit, 500), 5000))
  ), deleted AS (
    DELETE FROM organization_webhook_deliveries delivery USING doomed WHERE delivery.id = doomed.id RETURNING 1
  ) SELECT count(*)::integer FROM deleted;
$prune$;
REVOKE ALL ON FUNCTION opengeni_private.claim_organization_webhook_deliveries_v1(uuid,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.settle_organization_webhook_delivery_v1(uuid,uuid,integer,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.prune_organization_webhook_deliveries_v1(integer,integer) FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_credential_providers, organization_webhooks,
      organization_webhook_deliveries TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.resolve_organization_credential_provider_v1(uuid,uuid),
      opengeni_private.resolve_integration_initiating_human_v1(uuid,uuid,text),
      opengeni_private.integration_webhook_payload_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,timestamptz,jsonb),
      opengeni_private.enqueue_organization_webhook_deliveries_v1(),
      opengeni_private.claim_organization_webhook_deliveries_v1(uuid,integer,integer),
      opengeni_private.settle_organization_webhook_delivery_v1(uuid,uuid,integer,text,integer),
      opengeni_private.prune_organization_webhook_deliveries_v1(integer,integer)
      TO opengeni_app;
  END IF;
END $grants$;

-- Rolling custom-role compatibility: the existing enqueue trigger now calls
-- two new helpers, so carry only its existing explicit EXECUTE grantees forward.
-- Provisioning still grants the current role through its normal private schema
-- path; no PUBLIC access or inferred broad role membership is introduced here.
DO $rolling_grants$
DECLARE target_role record;
BEGIN
  FOR target_role IN
    SELECT DISTINCT roles.rolname
    FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) acl
    JOIN pg_catalog.pg_roles roles ON roles.oid = acl.grantee
    WHERE namespace.nspname = 'opengeni_private'
      AND procedure.proname = 'enqueue_workspace_webhook_deliveries_v1'
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> procedure.proowner
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.resolve_integration_initiating_human_v1(uuid,uuid,text), opengeni_private.integration_webhook_payload_v1(uuid,uuid,uuid,text,uuid,uuid,bigint,timestamptz,jsonb), opengeni_private.enqueue_organization_webhook_deliveries_v1() TO %I',
      target_role.rolname
    );
    EXECUTE format(
      'GRANT SELECT ON TABLE organization_webhooks TO %I',
      target_role.rolname
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE organization_webhook_deliveries TO %I',
      target_role.rolname
    );
  END LOOP;
END $rolling_grants$;