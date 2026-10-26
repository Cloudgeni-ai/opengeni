-- deployment-mode: rolling
-- Passkey sign-in for managed accounts:
--   * `auth_passkeys` holds each person's WebAuthn credentials: the public key,
--     its signature counter and display metadata. No private key material is
--     ever stored. All of a person's passkeys share one `passkey` sign-in
--     method (an `auth_identities` row whose account id is the person's own
--     auth user id), so the canonical login binding is per person, not per
--     credential.
--   * `mutate_managed_passkey` adds or removes a passkey for a signed-in
--     person behind the same authority as the other sign-in method changes
--     (`managed_sign_in_method_authority`: an active identity, a fresh session,
--     the expected identity revision and, in session-set modes, the actor
--     fence). The first passkey links the `passkey` binding; removing the last
--     passkey is refused while it is the person's last usable sign-in method.
--     Each change queues the usual sign-in method notification, except for
--     reserved `.invalid` addresses, which no mail can reach.
--   * `mutate_managed_sign_in_method` counts a person's passkeys as a usable
--     method when they disconnect Google or GitHub.
--   * Sign-in method notifications may name `passkey`.
-- The previous release never reads the new table and keeps every routine
-- signature; it does not offer `passkey` as a usable provider, so its own
-- last-method check is unchanged.
SET LOCAL lock_timeout = '5s';

CREATE TABLE auth_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  credential_id text NOT NULL CHECK (
    pg_catalog.length(credential_id) BETWEEN 16 AND 1400 AND credential_id ~ '^[A-Za-z0-9_-]+$'
  ),
  public_key text NOT NULL CHECK (
    pg_catalog.length(public_key) BETWEEN 16 AND 4096 AND public_key ~ '^[A-Za-z0-9_-]+$'
  ),
  counter bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports text[] NOT NULL DEFAULT '{}' CHECK (pg_catalog.cardinality(transports) <= 8),
  device_type text NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up boolean NOT NULL DEFAULT false,
  aaguid text CHECK (aaguid IS NULL OR aaguid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  name text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(name)) BETWEEN 1 AND 80),
  rp_id text NOT NULL CHECK (pg_catalog.length(rp_id) BETWEEN 1 AND 253),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  last_used_at timestamptz
);
CREATE UNIQUE INDEX auth_passkeys_credential_id_idx ON auth_passkeys (credential_id);
CREATE INDEX auth_passkeys_user_id_idx ON auth_passkeys (user_id, created_at);

ALTER TABLE managed_sign_in_method_operations
  DROP CONSTRAINT managed_sign_in_method_operations_provider_check;
ALTER TABLE managed_sign_in_method_operations
  ADD CONSTRAINT managed_sign_in_method_operations_provider_check
  CHECK (provider IN ('password', 'google', 'github', 'passkey')) NOT VALID;

CREATE FUNCTION mutate_managed_passkey(p_user text, p_session text, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $body$
DECLARE
  revision_value bigint;
  operation_value text := p_request->>'kind';
  credential jsonb := p_request->'credential';
  passkey_value uuid;
  linked boolean := false;
  previous_marker text := current_setting('opengeni.canonical_human_identity_lifecycle', true);
BEGIN
  revision_value := managed_sign_in_method_authority(p_user, p_session, p_request);
  IF operation_value = 'register' THEN
    IF credential IS NULL OR jsonb_typeof(credential) <> 'object'
      OR jsonb_typeof(credential->'transports') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'SIGN_IN_METHOD_INVALID_REQUEST' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM auth_passkeys WHERE user_id = p_user) >= 25 THEN
      RAISE EXCEPTION 'SIGN_IN_METHOD_PASSKEY_LIMIT' USING ERRCODE = '42501';
    END IF;
    INSERT INTO auth_passkeys (
      user_id, credential_id, public_key, counter, transports, device_type, backed_up,
      aaguid, name, rp_id
    ) VALUES (
      p_user, credential->>'credentialId', credential->>'publicKey',
      (credential->>'counter')::bigint,
      ARRAY(SELECT jsonb_array_elements_text(credential->'transports')),
      credential->>'deviceType', (credential->>'backedUp')::boolean,
      nullif(credential->>'aaguid', ''), credential->>'name', credential->>'rpId'
    ) ON CONFLICT (credential_id) DO NOTHING
    RETURNING id INTO passkey_value;
    IF passkey_value IS NULL THEN
      RAISE EXCEPTION 'SIGN_IN_METHOD_ALREADY_CONNECTED' USING ERRCODE = '23505';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth_identities WHERE user_id = p_user AND provider_id = 'passkey') THEN
      INSERT INTO auth_identities (id, user_id, provider_id, account_id, created_at, updated_at)
        VALUES (gen_random_uuid()::text, p_user, 'passkey', p_user, clock_timestamp(), clock_timestamp());
      PERFORM apply_canonical_human_identity_operation(
        (p_request->>'operationId')::uuid, p_user, revision_value, 'link', NULL, 'passkey', p_user,
        'Add passkey sign-in method'
      );
      linked := true;
    END IF;
  ELSIF operation_value = 'delete' THEN
    DELETE FROM auth_passkeys
      WHERE id = (p_request->>'passkeyId')::uuid AND user_id = p_user
      RETURNING id INTO passkey_value;
    IF passkey_value IS NULL THEN
      RAISE EXCEPTION 'SIGN_IN_METHOD_NOT_CONNECTED' USING ERRCODE = 'P0002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth_passkeys WHERE user_id = p_user) AND NOT EXISTS (
      SELECT 1 FROM canonical_human_login_bindings b
      JOIN canonical_human_identity_subjects s
        ON s.identity_id = b.identity_id AND s.auth_user_id = p_user AND s.status = 'active'
      JOIN auth_identities a
        ON a.provider_id = b.provider_id AND a.account_id = b.provider_account_id AND a.user_id = p_user
      WHERE b.status = 'active' AND a.provider_id <> 'passkey'
        AND (p_request->'usableProviders') ? a.provider_id
        AND (a.provider_id IN ('google', 'github') OR (a.provider_id = 'credential' AND length(a.password) > 0))
    ) THEN
      RAISE EXCEPTION 'SIGN_IN_METHOD_LAST_USABLE_METHOD' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'SIGN_IN_METHOD_INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
  INSERT INTO managed_sign_in_method_operations (
    operation_id, auth_user_id, request_digest, kind, provider, notification_email
  )
    SELECT (p_request->>'operationId')::uuid, p_user, p_request->>'requestDigest',
      CASE WHEN operation_value = 'register' THEN 'connect' ELSE 'disconnect' END, 'passkey', email
    FROM auth_users
    WHERE id = p_user AND email_verified AND lower(email) NOT LIKE '%.invalid';
  PERFORM set_config('opengeni.canonical_human_identity_lifecycle', coalesce(previous_marker, ''), true);
  RETURN jsonb_build_object('passkeyId', passkey_value, 'reauthenticationRequired', linked);
END $body$;
REVOKE ALL ON FUNCTION mutate_managed_passkey(text, text, jsonb) FROM PUBLIC;

-- Rewrites one routine in place. Each patch must match exactly once, so a
-- routine that changed since this was written fails the migration loudly.
CREATE FUNCTION pg_temp.patch_sign_in_routine_0998(p_routine regprocedure, p_patches text[])
RETURNS void
LANGUAGE plpgsql AS $patch$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(p_routine);
  patch text[];
BEGIN
  FOREACH patch SLICE 1 IN ARRAY p_patches LOOP
    IF (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, patch[1], '')))
      <> pg_catalog.length(patch[1]) THEN
      RAISE EXCEPTION '0998 managed auth passkeys: % changed near: %', p_routine, patch[1];
    END IF;
    definition := pg_catalog.replace(definition, patch[1], patch[2]);
  END LOOP;
  EXECUTE definition;
END
$patch$;

SELECT pg_temp.patch_sign_in_routine_0998('mutate_managed_sign_in_method(text,text,jsonb)'::regprocedure, ARRAY[
  ARRAY[$old$      AND (a.provider_id IN ('google','github') OR (a.provider_id='credential' AND length(a.password)>0))) THEN$old$,
    $new$      AND (a.provider_id IN ('google','github') OR (a.provider_id='credential' AND length(a.password)>0)
        OR (a.provider_id='passkey' AND EXISTS (SELECT 1 FROM auth_passkeys k WHERE k.user_id=p_user)))) THEN$new$]
]);

DO $passkey_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON auth_passkeys TO opengeni_app;
    GRANT EXECUTE ON FUNCTION mutate_managed_passkey(text, text, jsonb) TO opengeni_app;
  END IF;
END $passkey_grants$;
