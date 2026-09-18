-- deployment-mode: rolling
-- Additive storage only. Old workers cannot honor a parked admission: complete
-- the worker rollout before relying on this fence (see docs/run-lifecycle.md).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';
ALTER TABLE sessions ADD COLUMN admission_block jsonb;
ALTER TABLE sessions ADD CONSTRAINT sessions_admission_block_shape CHECK (
  admission_block IS NULL OR (
    jsonb_typeof(admission_block) = 'object'
    AND admission_block ?& ARRAY['reason','sqlState','retryPolicy','blockedAt','attemptId','fence','previousStatus']
    AND admission_block - ARRAY['reason','sqlState','retryPolicy','blockedAt','attemptId','fence','previousStatus'] = '{}'::jsonb
    AND admission_block->>'previousStatus' IN ('queued','idle','running','recovering','waiting_capacity','requires_action')
    AND admission_block->>'reason' IN ('database_claim_rejected','initiator_membership_required','personal_resource_grant_required')
    AND admission_block->>'retryPolicy' = 'explicit_recheck'
    AND (admission_block->'sqlState' = 'null'::jsonb OR admission_block->>'sqlState' ~ '^[0-9A-Z]{5}$')
    AND jsonb_typeof(admission_block->'blockedAt') = 'string'
    AND jsonb_typeof(admission_block->'attemptId') = 'string'
    AND admission_block->>'attemptId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND jsonb_typeof(admission_block->'fence') = 'object'
    AND admission_block->'fence' ?& ARRAY['lastSequence','controlVersion']
    AND admission_block->'fence' - ARRAY['lastSequence','controlVersion'] = '{}'::jsonb
    AND jsonb_typeof(admission_block#>'{fence,lastSequence}') = 'number'
    AND jsonb_typeof(admission_block#>'{fence,controlVersion}') = 'number'
    AND admission_block#>>'{fence,lastSequence}' ~ '^[0-9]+$'
    AND admission_block#>>'{fence,controlVersion}' ~ '^[0-9]+$'
  ) IS TRUE
);

-- Older application binaries do not read the new field. They may continue
-- retrying until rolled out, but cannot admit an attempt through a durable block.
CREATE FUNCTION guard_session_admission_block() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
BEGIN
  IF EXISTS (SELECT 1 FROM sessions s WHERE s.id = NEW.session_id
    AND s.workspace_id = NEW.workspace_id AND s.account_id = NEW.account_id
    AND s.admission_block IS NOT NULL) THEN
    RAISE EXCEPTION 'session admission requires an explicit recheck' USING ERRCODE = 'OG003';
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION guard_session_admission_block() FROM PUBLIC;
CREATE TRIGGER session_attempt_admission_block BEFORE INSERT ON session_turn_attempts
FOR EACH ROW EXECUTE FUNCTION guard_session_admission_block();

-- Give only these two reviewed guards stable typed causes. Never infer their
-- meaning from arbitrary P0002/42501 errors or parse driver error messages.
-- A temporary installer keeps quoted function source distinct from migration
-- data preflights. This reads pg_proc only; no membership row is read or changed.
CREATE FUNCTION pg_temp.install_typed_admission_causes() RETURNS void
LANGUAGE plpgsql AS $typed_admission_causes$
DECLARE
  function_oid regprocedure := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.admit_session_attempt_personal_resources()', current_schema()));
  definition text;
  membership_selection constant text := $selection$      SELECT membership.* INTO STRICT member_row
      FROM organization_memberships membership
      WHERE membership.account_id = NEW.account_id
        AND membership.subject_id = initiating_subject
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
      FOR SHARE;$selection$;
  grant_rejection constant text := $rejection$RAISE EXCEPTION 'matching personal-resource grant required'
            USING ERRCODE = '42501';$rejection$;
BEGIN
  IF function_oid IS NULL THEN
    RAISE EXCEPTION '0483 requires personal-resource admission' USING ERRCODE = '55000';
  END IF;
  definition := pg_catalog.pg_get_functiondef(function_oid);
  IF (length(definition) - length(replace(definition, membership_selection, ''))) / length(membership_selection) <> 1
    OR (length(definition) - length(replace(definition, grant_rejection, ''))) / length(grant_rejection) <> 1 THEN
    RAISE EXCEPTION '0483 personal-resource guard source drift' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, membership_selection,
    '      BEGIN' || chr(10) || membership_selection || chr(10) ||
    '      EXCEPTION WHEN no_data_found THEN' || chr(10) ||
    '        RAISE EXCEPTION ''personal-resource initiating membership required'' USING ERRCODE = ''OG001'';' || chr(10) ||
    '      END;');
  definition := replace(definition, grant_rejection,
    replace(grant_rejection, '''42501''', '''OG002'''));
  EXECUTE definition;
END
$typed_admission_causes$;
SELECT pg_temp.install_typed_admission_causes();
DROP FUNCTION pg_temp.install_typed_admission_causes();