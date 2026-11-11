-- deployment-mode: rolling
-- Organization admins administer the company profile, as the owner does. The
-- manual editor already follows the API's organization-administration rule
-- (owner or admin); the agent path and its policy re-derive the role here, so
-- they accept an active owner or admin of the same organization instead of
-- the owner only. Everything else is unchanged: the initiating human of the
-- exact live turn, the same organization's membership row and lock order, the
-- policy version, proposal hash and active-head checks. Billing, roles and
-- ownership are not touched. Previous binaries call the same signatures and
-- only see more people admitted.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $organization_admins_company_profile$
DECLARE
  routine text;
  definition text;
  anchor text := $a$AND membership.role = 'owner'$a$;
BEGIN
  FOREACH routine IN ARRAY ARRAY[
    'propose_company_profile_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,text)',
    'confirm_company_profile_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,uuid)',
    'get_company_profile_agent_policy(uuid,uuid,text)',
    'update_company_profile_agent_policy(uuid,uuid,text,text,bigint,uuid)'
  ] LOOP
    definition := pg_get_functiondef(format('%I.%s', current_schema(), routine)::regprocedure);
    IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
      RAISE EXCEPTION '% organization role anchor drifted', routine;
    END IF;
    definition := replace(definition, anchor, $r$AND membership.role IN ('owner', 'admin')$r$);
    EXECUTE definition;
  END LOOP;
END $organization_admins_company_profile$;
