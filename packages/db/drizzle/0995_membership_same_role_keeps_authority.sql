-- deployment-mode: rolling
-- An organization membership's authorization revision is the signal that
-- invalidates authority frozen from it: saved automations, personal
-- connections frozen on a turn, machine consent and identity links all stop
-- until their owner approves them again. Setting a member's role to the role
-- they already hold changes nothing about their access, so it no longer
-- advances that revision (and so no longer silently stops every automation
-- they saved). The command still checks the caller's expected revision and
-- still records its receipt and lifecycle event. No grants, stored data or
-- row shape change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $patch$
DECLARE definition text; anchor text; replacement text;
BEGIN
  -- Resolve in this deployment's own data schema, as 0299 does: a
  -- dedicated-schema migration run also carries `public` on its search path.
  definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(
    pg_catalog.quote_ident(pg_catalog.current_schema())
      || '.organization_membership_command_0263(jsonb)'
  ));
  IF definition IS NULL THEN
    RAISE EXCEPTION 'organization_membership_command_0263(jsonb) is missing'
      USING ERRCODE = '55000';
  END IF;
  anchor := $old$        UPDATE organization_memberships SET role = requested_role,
          authorization_revision = authorization_revision + 1, updated_at = now_value
        WHERE id = target.id RETURNING * INTO target;$old$;
  replacement := $new$        IF requested_role IS DISTINCT FROM target.role THEN
          UPDATE organization_memberships SET role = requested_role,
            authorization_revision = authorization_revision + 1, updated_at = now_value
          WHERE id = target.id RETURNING * INTO target;
        END IF;$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'organization_membership_command_0263(jsonb) change_role anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$patch$;
