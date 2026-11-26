-- deployment-mode: rolling
-- Extend existing guards and receipts to Apple; no new runtime grants or data
-- rewrite. Only configure Apple after all API replicas know the new provider.

ALTER TABLE managed_sign_in_method_operations
  DROP CONSTRAINT managed_sign_in_method_operations_provider_check,
  ADD CONSTRAINT managed_sign_in_method_operations_provider_check
    CHECK (provider IN ('password', 'google', 'github', 'passkey', 'apple')) NOT VALID;

-- Preserve each routine's existing authority and unrelated branches. Like the
-- passkey migration, fail instead of silently dropping an unmatched patch.
CREATE FUNCTION pg_temp.patch_apple_sign_in_routine(p_routine regprocedure, p_old text, p_new text, p_count integer)
RETURNS void LANGUAGE plpgsql AS $patch$
DECLARE
  definition text := pg_catalog.pg_get_functiondef(p_routine);
  patched text := pg_catalog.replace(definition, p_old, p_new);
BEGIN
  IF pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, p_old, ''))
      <> p_count * pg_catalog.length(p_old) THEN
    RAISE EXCEPTION 'managed Apple auth: % changed near: %', p_routine, p_old;
  END IF;
  EXECUTE patched;
END
$patch$;

SELECT pg_temp.patch_apple_sign_in_routine('guard_managed_social_account()'::regprocedure,
  $$('google','github')$$, $$('google','github','apple')$$, 1);
SELECT pg_temp.patch_apple_sign_in_routine('bind_managed_social_account()'::regprocedure,
  $$('google','github')$$, $$('google','github','apple')$$, 1);
SELECT pg_temp.patch_apple_sign_in_routine('mutate_managed_sign_in_method(text,text,jsonb)'::regprocedure,
  $$('google','github')$$, $$('google','github','apple')$$, 3);
SELECT pg_temp.patch_apple_sign_in_routine('mutate_managed_passkey(text,text,jsonb)'::regprocedure,
  $$('google', 'github')$$, $$('google', 'github', 'apple')$$, 1);
SELECT pg_temp.patch_apple_sign_in_routine('opengeni_private.product_lifecycle_fact_valid(text,text)'::regprocedure,
  $$('email', 'google', 'github', 'other')$$, $$('email', 'google', 'github', 'apple', 'other')$$, 2);

CREATE OR REPLACE FUNCTION opengeni_private.product_lifecycle_auth_method(p_provider_id text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT CASE lower(btrim(coalesce(p_provider_id, '')))
    WHEN 'credential' THEN 'email'
    WHEN 'google' THEN 'google'
    WHEN 'github' THEN 'github'
    WHEN 'apple' THEN 'apple'
    ELSE 'other'
  END
$$;
