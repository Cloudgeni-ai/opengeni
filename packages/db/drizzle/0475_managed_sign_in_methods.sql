-- deployment-mode: maintenance
-- New auth-account insertion guards and runtime routine contract. Drain old APIs
-- before applying; no provider wildcard writer may bypass the new boundary.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
    OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION 'sign-in method migration requires stopped application roles' USING ERRCODE = '55000';
  END IF;
END $drain$;

ALTER TABLE auth_identities ADD COLUMN managed_link_intent_id text;

-- These routines are not authentication. Only the managed-cookie API may supply
-- the canonical subject/session and actor stamp; provider callbacks additionally
-- require Better Auth's consumed, database-backed OAuth state and real proof.
CREATE FUNCTION managed_sign_in_method_authority(p_user text, p_session text, p_request jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE identity_row canonical_human_identities%ROWTYPE; stamp jsonb := p_request->'actorFence';
BEGIN
  IF stamp IS NOT NULL AND stamp <> 'null'::jsonb THEN
    IF coalesce((p_request->>'callback')::boolean, false) THEN
      PERFORM managed_auth_actor_mutation_lease_acquire(stamp->>'authorityHash', (stamp->>'actorEpoch')::bigint, (stamp->>'requestId')::uuid, 30);
    END IF;
    PERFORM managed_auth_actor_mutation_fence(stamp->>'authorityHash', (stamp->>'actorEpoch')::bigint, (stamp->>'requestId')::uuid);
  END IF;
  PERFORM set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
  SELECT i.* INTO identity_row FROM canonical_human_identities i
    JOIN canonical_human_identity_subjects s ON s.identity_id = i.id
    WHERE s.auth_user_id = p_user AND s.status = 'active' FOR UPDATE OF i;
  IF NOT FOUND OR identity_row.status <> 'active'
    OR NOT validate_canonical_human_session(p_session, p_user, false) THEN
    RAISE EXCEPTION 'SIGN_IN_METHOD_AUTHENTICATION_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth_users WHERE id = p_user AND email_verified) THEN
    RAISE EXCEPTION 'SIGN_IN_METHOD_EMAIL_NOT_VERIFIED' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth_sessions WHERE id = p_session AND user_id = p_user
    AND created_at > clock_timestamp() - interval '5 minutes' AND created_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'SIGN_IN_METHOD_REAUTHENTICATION_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF identity_row.identity_revision IS DISTINCT FROM (p_request->>'expectedIdentityRevision')::bigint THEN
    RAISE EXCEPTION 'SIGN_IN_METHOD_REVISION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  RETURN identity_row.identity_revision;
END $body$;
REVOKE ALL ON FUNCTION managed_sign_in_method_authority(text,text,jsonb) FROM PUBLIC;

CREATE FUNCTION mutate_managed_sign_in_method(p_user text, p_session text, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE revision_value bigint; identity_value uuid; binding_value uuid; provider_value text := p_request->>'provider';
  operation_value text := p_request->>'kind'; account_value text; stamp jsonb := p_request->'actorFence';
  previous_marker text := current_setting('opengeni.canonical_human_identity_lifecycle',true);
BEGIN
  revision_value := managed_sign_in_method_authority(p_user, p_session, p_request);
  SELECT identity_id INTO identity_value FROM canonical_human_identity_subjects WHERE auth_user_id = p_user AND status = 'active';
  IF operation_value = 'connect' AND provider_value IN ('google','github') THEN
    IF EXISTS (SELECT 1 FROM auth_identities WHERE user_id = p_user AND provider_id = provider_value) THEN
      RAISE EXCEPTION 'SIGN_IN_METHOD_ALREADY_CONNECTED' USING ERRCODE = '23505';
    END IF;
    INSERT INTO auth_verifications(id, identifier, value, expires_at, created_at, updated_at)
      VALUES (p_request->>'operationId', 'managed-sign-in:' || (p_request->>'operationId'),
        (p_request || jsonb_build_object('authUserId',p_user,'authSessionId',p_session))::text,
        clock_timestamp() + interval '5 minutes', clock_timestamp(), clock_timestamp());
    PERFORM set_config('opengeni.canonical_human_identity_lifecycle',coalesce(previous_marker,''),true);
    RETURN jsonb_build_object('intentId',p_request->>'operationId');
  ELSIF operation_value = 'disconnect' AND provider_value IN ('google','github') THEN
    SELECT b.id INTO binding_value FROM canonical_human_login_bindings b
      JOIN auth_identities a ON a.provider_id=b.provider_id AND a.account_id=b.provider_account_id AND a.user_id=p_user
      WHERE b.identity_id=identity_value AND b.status='active' AND b.provider_id=provider_value;
    IF binding_value IS NULL THEN RAISE EXCEPTION 'SIGN_IN_METHOD_NOT_CONNECTED' USING ERRCODE='P0002'; END IF;
    IF NOT EXISTS (SELECT 1 FROM canonical_human_login_bindings b JOIN auth_identities a
      ON a.provider_id=b.provider_id AND a.account_id=b.provider_account_id AND a.user_id=p_user
      WHERE b.identity_id=identity_value AND b.status='active' AND b.provider_id<>provider_value
      AND (p_request->'usableProviders') ? a.provider_id
      AND (a.provider_id IN ('google','github') OR (a.provider_id='credential' AND length(a.password)>0))) THEN
      RAISE EXCEPTION 'SIGN_IN_METHOD_LAST_USABLE_METHOD' USING ERRCODE='42501';
    END IF;
    PERFORM apply_canonical_human_identity_operation((p_request->>'operationId')::uuid,p_user,revision_value,'unlink',binding_value,NULL,NULL,'Disconnect personal sign-in method');
  ELSIF operation_value = 'password' THEN
    IF length(p_request->>'passwordHash') < 32 THEN RAISE EXCEPTION 'SIGN_IN_METHOD_INVALID_PASSWORD' USING ERRCODE='22023'; END IF;
    SELECT id INTO account_value FROM auth_identities WHERE user_id=p_user AND provider_id='credential' FOR UPDATE;
    IF account_value IS NOT NULL THEN
      -- The API proves the current password, and this comparison fences changes
      -- between that expensive proof and the transaction's credential update.
      IF (SELECT password FROM auth_identities WHERE id=account_value) IS DISTINCT FROM p_request->>'expectedPasswordHash' THEN
        RAISE EXCEPTION 'SIGN_IN_METHOD_PASSWORD_CHANGED' USING ERRCODE='40001';
      END IF;
      UPDATE auth_identities SET password=p_request->>'passwordHash', updated_at=clock_timestamp() WHERE id=account_value;
      UPDATE canonical_human_identities SET identity_revision=identity_revision+1, auth_revision=auth_revision+1, updated_at=clock_timestamp() WHERE id=identity_value;
      DELETE FROM auth_sessions WHERE identity_id=identity_value;
    ELSE
      IF p_request->>'expectedPasswordHash' IS NOT NULL THEN RAISE EXCEPTION 'SIGN_IN_METHOD_PASSWORD_CHANGED' USING ERRCODE='40001'; END IF;
      INSERT INTO auth_identities(id,user_id,provider_id,account_id,password,created_at,updated_at)
        VALUES (gen_random_uuid()::text,p_user,'credential',p_user,p_request->>'passwordHash',clock_timestamp(),clock_timestamp());
      PERFORM apply_canonical_human_identity_operation((p_request->>'operationId')::uuid,p_user,revision_value,'link',NULL,'credential',p_user,'Set personal sign-in password');
    END IF;
  ELSE RAISE EXCEPTION 'SIGN_IN_METHOD_INVALID_REQUEST' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('opengeni.canonical_human_identity_lifecycle',coalesce(previous_marker,''),true);
  RETURN jsonb_build_object('reauthenticationRequired',true);
END $body$;
REVOKE ALL ON FUNCTION mutate_managed_sign_in_method(text,text,jsonb) FROM PUBLIC;

CREATE FUNCTION guard_managed_social_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE identity_value uuid; revision_value bigint; intent jsonb; previous_marker text := current_setting('opengeni.canonical_human_identity_lifecycle',true);
BEGIN
  IF NEW.provider_id NOT IN ('google','github') THEN RETURN NEW; END IF;
  PERFORM set_config('opengeni.canonical_human_identity_lifecycle','active',true);
  IF NEW.managed_link_intent_id IS NOT NULL THEN
    DELETE FROM auth_verifications WHERE identifier='managed-sign-in:' || NEW.managed_link_intent_id
      AND expires_at>clock_timestamp() RETURNING value::jsonb INTO intent;
    IF intent IS NULL OR intent->>'authUserId' IS DISTINCT FROM NEW.user_id OR intent->>'provider' IS DISTINCT FROM NEW.provider_id THEN
      RAISE EXCEPTION 'SIGN_IN_METHOD_CONNECT_PROOF_REQUIRED' USING ERRCODE='42501';
    END IF;
    revision_value := managed_sign_in_method_authority(NEW.user_id,intent->>'authSessionId',intent || '{"callback":true}'::jsonb);
  END IF;
  SELECT i.id,i.identity_revision INTO identity_value,revision_value FROM canonical_human_identities i
    JOIN canonical_human_identity_subjects s ON s.identity_id=i.id WHERE s.auth_user_id=NEW.user_id AND s.status='active' FOR UPDATE OF i;
  PERFORM pg_advisory_xact_lock(hashtextextended('canonical-human-binding:' || NEW.provider_id || ':' || NEW.account_id,0));
  IF EXISTS (SELECT 1 FROM canonical_human_login_bindings WHERE provider_id=NEW.provider_id AND provider_account_id=NEW.account_id AND identity_id IS DISTINCT FROM identity_value) THEN
    RAISE EXCEPTION 'SIGN_IN_METHOD_ACCOUNT_COLLISION' USING ERRCODE='23505';
  END IF;
  IF identity_value IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM auth_users WHERE id=NEW.user_id AND email_verified) THEN
      RAISE EXCEPTION 'SIGN_IN_METHOD_EMAIL_NOT_VERIFIED' USING ERRCODE='42501';
    END IF;
    IF EXISTS (SELECT 1 FROM auth_identities WHERE user_id=NEW.user_id AND provider_id=NEW.provider_id) THEN
      RAISE EXCEPTION 'SIGN_IN_METHOD_ALREADY_CONNECTED' USING ERRCODE='23505';
    END IF;
    IF intent IS NULL AND EXISTS (SELECT 1 FROM canonical_human_login_bindings WHERE identity_id=identity_value AND provider_id=NEW.provider_id AND status<>'active') THEN
      RAISE EXCEPTION 'SIGN_IN_METHOD_EXPLICIT_RECONNECT_REQUIRED' USING ERRCODE='42501';
    END IF;
  END IF;
  PERFORM set_config('opengeni.canonical_human_identity_lifecycle',coalesce(previous_marker,''),true);
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION guard_managed_social_account() FROM PUBLIC;
CREATE TRIGGER managed_social_account_guard BEFORE INSERT ON auth_identities FOR EACH ROW EXECUTE FUNCTION guard_managed_social_account();

CREATE FUNCTION bind_managed_social_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE revision_value bigint; previous_marker text := current_setting('opengeni.canonical_human_identity_lifecycle',true);
BEGIN
  IF NEW.provider_id NOT IN ('google','github') THEN RETURN NEW; END IF;
  PERFORM set_config('opengeni.canonical_human_identity_lifecycle','active',true);
  SELECT i.identity_revision INTO revision_value FROM canonical_human_identities i JOIN canonical_human_identity_subjects s
    ON s.identity_id=i.id WHERE s.auth_user_id=NEW.user_id AND s.status='active';
  IF revision_value IS NOT NULL THEN
    PERFORM apply_canonical_human_identity_operation(gen_random_uuid(),NEW.user_id,revision_value,'link',NULL,NEW.provider_id,NEW.account_id,'Link verified social sign-in method');
  END IF;
  PERFORM set_config('opengeni.canonical_human_identity_lifecycle',coalesce(previous_marker,''),true);
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION bind_managed_social_account() FROM PUBLIC;
CREATE TRIGGER managed_social_account_binding AFTER INSERT ON auth_identities FOR EACH ROW EXECUTE FUNCTION bind_managed_social_account();