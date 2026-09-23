-- deployment-mode: rolling
-- Preserve an unfinished projection while its account is unfunded. The same
-- leased capability used by knowledge_index_work is required; no human or
-- public request may put a different tenant's revision into this state.
ALTER TABLE knowledge_index_jobs ADD COLUMN billing_mode text
  CHECK (billing_mode IN ('usage_only','shadow','credits'));
ALTER TABLE knowledge_index_jobs ADD COLUMN billed_generation integer;
ALTER TABLE knowledge_index_jobs ADD COLUMN billing_rate_micros_per_million_bytes bigint
  CHECK (billing_rate_micros_per_million_bytes >= 0);

-- Freeze the mode at first work for a generation. Rows queued before the
-- explicitly configured paid cutover cannot be retroactively charged, even
-- if a worker restarts. Already-started generations keep their chosen mode.
CREATE FUNCTION knowledge_index_billing_policy(
  p_account uuid, p_revision uuid, p_lease uuid, p_requested text,
  p_activation_at timestamptz, p_rate bigint
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  job knowledge_index_jobs%ROWTYPE;
  decided text;
  frozen_rate bigint;
  previous text := current_setting('opengeni.knowledge_index_dispatcher',true);
BEGIN
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id() OR
     p_requested IS NULL OR p_requested NOT IN ('usage_only','shadow','credits') OR
     p_activation_at IS NULL OR p_rate IS NULL OR p_rate < 0 OR
     (p_requested='credits' AND p_rate=0) THEN
    RAISE EXCEPTION 'Knowledge index billing policy unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('opengeni.knowledge_index_dispatcher','1',true);
  SELECT * INTO job FROM knowledge_index_jobs j WHERE j.account_id=p_account
    AND j.revision_id=p_revision AND j.lease_id=p_lease AND j.state='running'
    AND j.lease_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Knowledge index lease unavailable' USING ERRCODE='40001';
  END IF;
  IF job.billed_generation IS DISTINCT FROM job.generation THEN
    decided:=CASE WHEN job.created_at>=p_activation_at THEN p_requested ELSE 'usage_only' END;
    frozen_rate:=CASE WHEN decided='usage_only' THEN 0 ELSE p_rate END;
  ELSE
    decided:=job.billing_mode;
    frozen_rate:=job.billing_rate_micros_per_million_bytes;
  END IF;
  -- A review-first draft is not a paid purchase. Keep its lease checkpoint
  -- intact and poll until this exact revision is published; a rejected latest
  -- revision may remain visible for review but must never incur an embedding
  -- charge. Recheck on every batch so a publication change fences work.
  IF decided='credits' AND NOT EXISTS (
    SELECT 1 FROM knowledge_entries e WHERE e.account_id=p_account
      AND e.id=job.entry_id AND e.published_revision_id=p_revision AND NOT e.archived
  ) THEN
    UPDATE knowledge_index_jobs SET state='pending',lease_id=NULL,lease_until=NULL,
      last_failure='waiting_for_review',next_attempt_at=clock_timestamp()+interval '1 minute',
      attempts=0 WHERE revision_id=p_revision;
    PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
    RETURN jsonb_build_object('mode','awaiting_review','rateMicrosPerMillionBytes',0);
  END IF;
  IF job.billed_generation IS DISTINCT FROM job.generation THEN
    UPDATE knowledge_index_jobs SET billing_mode=decided,billed_generation=job.generation,
      billing_rate_micros_per_million_bytes=frozen_rate
      WHERE revision_id=p_revision;
  END IF;
  PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
  RETURN jsonb_build_object('mode',decided,
    'rateMicrosPerMillionBytes',coalesce(frozen_rate,0));
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION knowledge_index_billing_policy(uuid,uuid,uuid,text,timestamptz,bigint) FROM PUBLIC;

CREATE FUNCTION knowledge_index_wait_for_funding(p_account uuid, p_revision uuid, p_lease uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE
  job knowledge_index_jobs%ROWTYPE;
  previous text := current_setting('opengeni.knowledge_index_dispatcher',true);
BEGIN
  IF p_account IS DISTINCT FROM opengeni_private.current_account_id() THEN
    RAISE EXCEPTION 'Knowledge index tenant mismatch' USING ERRCODE='42501';
  END IF;
  -- knowledge_index_jobs is FORCE-RLS and only the owner-definer dispatcher
  -- policy may see the leased job. Restore the transaction-local capability
  -- even if the lease fence fails.
  PERFORM set_config('opengeni.knowledge_index_dispatcher','1',true);
  SELECT * INTO job FROM knowledge_index_jobs j WHERE j.account_id=p_account
    AND j.revision_id=p_revision AND j.lease_id=p_lease AND j.state='running'
    AND j.lease_until>clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Knowledge index lease unavailable' USING ERRCODE='40001';
  END IF;
  UPDATE knowledge_index_jobs SET state='pending',lease_id=NULL,lease_until=NULL,
    last_failure='waiting_for_funding',next_attempt_at=clock_timestamp()+interval '1 minute',
    attempts=0 WHERE revision_id=p_revision;
  PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
  RETURN jsonb_build_object('status','pending');
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.knowledge_index_dispatcher',coalesce(previous,''),true);
  RAISE;
END $$;
REVOKE ALL ON FUNCTION knowledge_index_wait_for_funding(uuid,uuid,uuid) FROM PUBLIC;
DO $roles$
DECLARE runtime_role text;
BEGIN
  FOR runtime_role IN SELECT jsonb_array_elements_text(current_setting('opengeni.migration_application_roles')::jsonb) LOOP
    IF runtime_role <> current_user AND EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION knowledge_index_billing_policy(uuid,uuid,uuid,text,timestamptz,bigint) TO %I',runtime_role);
      EXECUTE format('GRANT EXECUTE ON FUNCTION knowledge_index_wait_for_funding(uuid,uuid,uuid) TO %I',runtime_role);
    END IF;
  END LOOP;
END $roles$;