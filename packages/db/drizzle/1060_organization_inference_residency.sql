-- deployment-mode: rolling
-- An organization's EU-only inference setting. When on, every model call for
-- the organization's workspaces must run on a route whose recorded processing
-- geography is EU (EEA counts as EU). A missing row means off, the behavior
-- before this table existed. Old releases never read these tables.
--
-- The runtime only reads the setting. Every change goes through
-- opengeni_private.update_organization_inference_residency_v1, which checks
-- the caller's scope and the actor's live owner/admin membership (or
-- administering organization key) itself, refuses an off change by anyone but
-- an owner or admin person in a browser, and writes the setting and its event
-- atomically. An operation id is bound to its request: an exact replay returns
-- the stored result and a changed body raises 23505.
-- A request that changes nothing records its event but leaves the setting and
-- its version alone, so repeating "on" never makes another change stale.
--
-- As 0937 and 0978 explain, the previous release rejects a runtime EXECUTE
-- grant on a definer it doesn't know, so this migration grants nothing on the
-- function: until a later migration grants it, the setting cannot be changed
-- and stays off. The runtime's SELECT on the setting is the shape the previous
-- release accepts for an unknown table (FORCE RLS, an active policy, no
-- ownership), and the history has no runtime privileges at all.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "organization_inference_residency" (
  "account_id" uuid PRIMARY KEY REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "eu_only" boolean NOT NULL,
  "version" bigint NOT NULL,
  "updated_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organization_inference_residency_version_chk CHECK ("version" > 0)
);

CREATE TABLE "organization_inference_residency_events" (
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "id" uuid NOT NULL,
  "actor_subject_id" text NOT NULL,
  "actor_kind" text NOT NULL,
  "requested_eu_only" boolean NOT NULL,
  "expected_version" bigint NOT NULL,
  "previous_eu_only" boolean NOT NULL,
  "result_eu_only" boolean NOT NULL,
  "result_version" bigint NOT NULL,
  "result_updated_at" timestamptz,
  "changed" boolean NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organization_inference_residency_events_pkey PRIMARY KEY ("account_id", "id"),
  CONSTRAINT organization_inference_residency_events_actor_kind_chk
    CHECK ("actor_kind" IN ('browser_person', 'agent', 'api_key')),
  -- An unchanged request before the first change reports version 0.
  CONSTRAINT organization_inference_residency_events_versions_chk
    CHECK ("expected_version" >= 0 AND "result_version" >= 0
      AND (NOT "changed" OR ("result_version" > 0 AND "result_updated_at" IS NOT NULL))),
  -- Turning EU-only off is only ever recorded for a person in a browser.
  CONSTRAINT organization_inference_residency_events_off_by_person_chk
    CHECK ("requested_eu_only" OR ("actor_kind" = 'browser_person' AND "actor_subject_id" LIKE 'user:%'))
);

-- Each change makes exactly one version; unchanged requests repeat the current one.
CREATE UNIQUE INDEX "organization_inference_residency_events_version_key"
  ON "organization_inference_residency_events" ("account_id", "result_version")
  WHERE "changed";

ALTER TABLE "organization_inference_residency" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_inference_residency" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_inference_residency_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_inference_residency_events" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "organization_inference_residency" FROM PUBLIC;
REVOKE ALL ON "organization_inference_residency_events" FROM PUBLIC;
-- Readable within the organization: every model call checks it.
CREATE POLICY organization_inference_residency_read ON "organization_inference_residency"
  FOR SELECT USING ("account_id" = opengeni_private.current_account_id());
-- Written only by the change function, which sets this marker.
CREATE POLICY organization_inference_residency_insert ON "organization_inference_residency"
  FOR INSERT WITH CHECK (
    current_setting('opengeni.organization_inference_residency_lifecycle', true) = 'active'
    AND "account_id" = opengeni_private.current_account_id()
  );
CREATE POLICY organization_inference_residency_update ON "organization_inference_residency"
  FOR UPDATE USING (
    current_setting('opengeni.organization_inference_residency_lifecycle', true) = 'active'
    AND "account_id" = opengeni_private.current_account_id()
  ) WITH CHECK (
    current_setting('opengeni.organization_inference_residency_lifecycle', true) = 'active'
    AND "account_id" = opengeni_private.current_account_id()
  );
CREATE POLICY organization_inference_residency_events_read ON "organization_inference_residency_events"
  FOR SELECT USING (
    current_setting('opengeni.organization_inference_residency_lifecycle', true) = 'active'
    AND "account_id" = opengeni_private.current_account_id()
  );
CREATE POLICY organization_inference_residency_events_insert ON "organization_inference_residency_events"
  FOR INSERT WITH CHECK (
    current_setting('opengeni.organization_inference_residency_lifecycle', true) = 'active'
    AND "account_id" = opengeni_private.current_account_id()
  );

CREATE FUNCTION opengeni_private.update_organization_inference_residency_v1(
  p_account_id uuid, p_actor_subject_id text, p_actor_kind text, p_eu_only boolean,
  p_expected_version bigint, p_operation_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE
  previous_marker text := pg_catalog.current_setting(
    'opengeni.organization_inference_residency_lifecycle', true
  );
  setting organization_inference_residency%ROWTYPE;
  prior organization_inference_residency_events%ROWTYPE;
  previous_eu_only boolean;
  did_change boolean;
  result jsonb;
BEGIN
  IF p_account_id IS NULL OR p_actor_subject_id IS NULL OR p_eu_only IS NULL
    OR p_operation_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 0
    OR p_actor_kind IS NULL OR p_actor_kind NOT IN ('browser_person', 'agent', 'api_key')
    OR (p_actor_subject_id LIKE 'api_key:%' AND p_actor_kind <> 'api_key')
  THEN
    RAISE EXCEPTION 'EU-only inference request is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN
    RAISE EXCEPTION 'organization administration scope invalid' USING ERRCODE = '42501';
  END IF;
  IF NOT p_eu_only AND (p_actor_kind <> 'browser_person' OR p_actor_subject_id NOT LIKE 'user:%') THEN
    RAISE EXCEPTION 'EU-only can only be turned off by an owner or admin in a browser'
      USING ERRCODE = '42501';
  END IF;
  -- The organization fence also taken by membership changes, so a demotion
  -- cannot pass between this check and the write.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));
  -- An active owner/admin membership, or a live organization key with
  -- workspace:admin. Off already excludes keys above, so off always needs the
  -- membership. Checked again on replay so lost authority cannot replay.
  PERFORM opengeni_private.assert_organization_administrator(p_account_id, p_actor_subject_id);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_inference_residency_lifecycle', 'active', true
  );
  SELECT * INTO prior FROM organization_inference_residency_events event
  WHERE event.account_id = p_account_id AND event.id = p_operation_id;
  IF FOUND THEN
    IF prior.actor_subject_id IS DISTINCT FROM p_actor_subject_id
      OR prior.actor_kind IS DISTINCT FROM p_actor_kind
      OR prior.requested_eu_only IS DISTINCT FROM p_eu_only
      OR prior.expected_version IS DISTINCT FROM p_expected_version
    THEN
      RAISE EXCEPTION 'EU-only inference operation id was reused' USING ERRCODE = '23505';
    END IF;
    result := pg_catalog.jsonb_build_object(
      'organizationId', p_account_id, 'euOnly', prior.result_eu_only,
      'version', prior.result_version, 'updatedAt', prior.result_updated_at,
      'changed', prior.changed, 'replayed', true
    );
  ELSE
    SELECT * INTO setting FROM organization_inference_residency candidate
    WHERE candidate.account_id = p_account_id FOR UPDATE;
    IF coalesce(setting.version, 0) IS DISTINCT FROM p_expected_version THEN
      RAISE EXCEPTION 'EU-only inference setting changed before update' USING ERRCODE = '40001';
    END IF;
    previous_eu_only := coalesce(setting.eu_only, false);
    did_change := previous_eu_only IS DISTINCT FROM p_eu_only;
    IF did_change THEN
      INSERT INTO organization_inference_residency (
        account_id, eu_only, version, updated_by_subject_id, updated_at
      ) VALUES (
        p_account_id, p_eu_only, p_expected_version + 1, p_actor_subject_id,
        pg_catalog.clock_timestamp()
      ) ON CONFLICT (account_id) DO UPDATE SET
        eu_only = excluded.eu_only, version = excluded.version,
        updated_by_subject_id = excluded.updated_by_subject_id, updated_at = excluded.updated_at
      RETURNING * INTO setting;
    END IF;
    INSERT INTO organization_inference_residency_events (
      account_id, id, actor_subject_id, actor_kind, requested_eu_only, expected_version,
      previous_eu_only, result_eu_only, result_version, result_updated_at, changed
    ) VALUES (
      p_account_id, p_operation_id, p_actor_subject_id, p_actor_kind, p_eu_only,
      p_expected_version, previous_eu_only, p_eu_only, coalesce(setting.version, 0),
      setting.updated_at, did_change
    );
    result := pg_catalog.jsonb_build_object(
      'organizationId', p_account_id, 'euOnly', p_eu_only, 'version', coalesce(setting.version, 0),
      'updatedAt', setting.updated_at, 'changed', did_change, 'replayed', false
    );
  END IF;
  PERFORM pg_catalog.set_config('opengeni.organization_inference_residency_lifecycle',
    coalesce(previous_marker, ''), true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.organization_inference_residency_lifecycle',
    coalesce(previous_marker, ''), true);
  RAISE;
END
$body$;
REVOKE ALL ON FUNCTION
  opengeni_private.update_organization_inference_residency_v1(uuid, text, text, boolean, bigint, uuid)
  FROM PUBLIC;

DO $pin$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.update_organization_inference_residency_v1(uuid,text,text,boolean,bigint,uuid) SET search_path = pg_catalog, %I, pg_temp',
    current_schema()
  );
END
$pin$;

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.organization_inference_residency TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;
