-- deployment-mode: rolling
-- Every transcription use now runs on the same speech-to-text providers, so
-- what decides how a transcript version is paid for is who pays for its
-- model, not whether it is a meeting or a dictation. A version charged in
-- Opengeni credits (a deployment-funded model where credit billing is on)
-- records the credits it was charged in credit_cost_micros; its ledger debit
-- already counts toward allowances. Every other version, a dictation on the
-- workspace's own key or subscription included, counts its list-price cost
-- once when it completes, as meetings did since 0959.
--
-- The previous release never sets credit_cost_micros and records a
-- dictation's credit charge as its cost under the model name voice-input,
-- so the dictations it asked for keep being skipped as before.
ALTER TABLE recording_transcript_versions ADD COLUMN credit_cost_micros bigint;

CREATE OR REPLACE FUNCTION count_unbilled_model_allowance_debit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE human text;
BEGIN
  IF TG_TABLE_NAME='recording_transcript_versions' THEN
    IF NEW.credit_cost_micros IS NOT NULL THEN RETURN NULL; END IF;
    -- A dictation from the previous release recorded its credit charge as its cost.
    PERFORM 1 FROM recordings r WHERE r.id=NEW.recording_id AND r.workspace_id=NEW.workspace_id
      AND (r.purpose<>'dictation' OR NEW.model<>'voice-input');
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM count_unbilled_allowance_usage(NEW.account_id,NEW.workspace_id,
      NEW.requested_by_subject_id,NEW.cost_usd_micros,TG_TABLE_SCHEMA);
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='recording_tracks' THEN
    SELECT r.owner_subject_id INTO human FROM recordings r
      WHERE r.id=NEW.recording_id AND r.workspace_id=NEW.workspace_id AND r.purpose<>'dictation';
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM count_unbilled_allowance_usage(NEW.account_id,NEW.workspace_id,human,
      NEW.live_cost_usd_micros-coalesce(OLD.live_cost_usd_micros,0),TG_TABLE_SCHEMA);
    RETURN NULL;
  END IF;
  IF NEW.workspace_id IS NULL OR NEW.priced_cost_micros <> 0
    OR coalesce(NEW.estimated_provider_cost_micros,0) <= 0 THEN RETURN NULL; END IF;
  -- A late cost fill-in counts once; an unchanged or already-priced row never recounts.
  IF TG_OP='UPDATE' AND OLD.estimated_provider_cost_micros IS NOT NULL THEN RETURN NULL; END IF;
  SELECT receipt.attribution->>'initiatingHumanSubjectId' INTO human
  FROM opengeni_private.usage_allowance_attribution_receipts receipt
    WHERE receipt.source_kind='turn' AND receipt.source_id=NEW.turn_id::text
      AND receipt.workspace_id=NEW.workspace_id AND receipt.account_id=NEW.account_id;
  PERFORM count_unbilled_allowance_usage(NEW.account_id,NEW.workspace_id,human,
    NEW.estimated_provider_cost_micros,TG_TABLE_SCHEMA);
  RETURN NULL;
END $$;

-- CREATE OR REPLACE resets SET clauses: pin the search path and strip any
-- inherited grants again.
DO $acl$
DECLARE role_name text; target_schema text := current_schema();
  function_name text := 'count_unbilled_model_allowance_debit()';
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC',target_schema,function_name);
  EXECUTE format('ALTER FUNCTION %I.%s SET search_path=pg_catalog,%I,pg_temp',target_schema,function_name,target_schema);
  FOR role_name IN SELECT DISTINCT r.rolname FROM pg_proc p,
    LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
    JOIN pg_roles r ON r.oid=acl.grantee
    WHERE p.oid=format('%I.%s',target_schema,function_name)::regprocedure AND acl.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM %I',target_schema,function_name,role_name); END LOOP;
END $acl$;
