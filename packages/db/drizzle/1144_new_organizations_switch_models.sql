-- deployment-mode: rolling
-- New organizations start with cross-provider failover on: when a chat's
-- subscriptions run out, it continues on a subscription model of the same
-- tier from another provider instead of waiting, never on Opengeni credits
-- (docs/design/ownership-and-reach.md, OR-4; answers Q-02 in
-- docs/subscription-accounts.md). It takes effect where the deployment turns
-- switching on (OPENGENI_SUBSCRIPTION_CROSS_PROVIDER_FAILOVER_ENABLED).
-- Existing organizations keep their stored value.
--
-- Only the value the new-organization seed writes changes.
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  definition text;
  anchor text := $a$NEW.id, NULL, seeded_rotation, '{}'::jsonb, false, '{}'::jsonb,$a$;
  replacement text := $a$NEW.id, NULL, seeded_rotation, '{}'::jsonb, true, '{}'::jsonb,$a$;
BEGIN
  definition := pg_catalog.pg_get_functiondef(
    'opengeni_private.seed_subscription_codex_cutover()'::regprocedure);
  IF strpos(definition, replacement) > 0 THEN
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '1144 new organization subscription settings seed drift'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$migration$;
