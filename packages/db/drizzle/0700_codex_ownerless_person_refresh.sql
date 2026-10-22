-- deployment-mode: rolling
-- Complete 0698's shared-only ownerless-person admission at token refresh.
-- The accepted turn can record a person without granting personal authority:
-- the existing ownerless helper still requires the exact core-service caller,
-- empty human GUC and accepted shared session/turn. Keep the shared connection,
-- live lease, refresh-generation CAS and one-shot capability checks unchanged.
-- Replacing only this guard preserves the function's owner, ACL and posture.
DO $ownerless_person_refresh$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.begin_subscription_codex_refresh(uuid,uuid,uuid,uuid,text,text,uuid,text,bigint)'::regprocedure);
  anchor := $old$authorized := turn_human IS NULL
          AND opengeni_private.authorize_subscription_ownerless_session_access($old$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'Ownerless Codex refresh authorization source changed';
  END IF;
  EXECUTE replace(definition, anchor,
    $new$authorized := opengeni_private.authorize_subscription_ownerless_session_access($new$);
END
$ownerless_person_refresh$;
