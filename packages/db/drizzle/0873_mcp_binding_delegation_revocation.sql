-- deployment-mode: rolling
-- Removing a workspace member or offboarding an organization member clears the
-- initial personal connection delegations of the sessions they own, advancing
-- each session's authority epoch under the session lifecycle capability that
-- only native lifecycle commands mint. Two session fences refused that
-- revocation whenever the owner had selected a personal connection, so the
-- whole removal failed:
--
-- * prevent_personal_connection_authority_mutation accepted the capability
--   only together with a visibility change;
-- * fence_mcp_account_bindings demanded an exact delegation for every accepted
--   personal MCP account, including the one the revocation had just removed.
--
-- Revocation is the same proven lifecycle write whether or not visibility
-- changes, so the first fence now accepts the capability alone (the cleared
-- value, epoch advance, owner and capability checks are unchanged). The second
-- validates a session's unchanged accepted bindings against the delegations
-- they were accepted with when an update only narrows those delegations.
-- Execution still revalidates live authority, so retained bindings grant
-- nothing without a current delegation. Every other write keeps its check.
-- Patch the installed bodies so later authority checks remain unchanged.
DO $binding_delegation_revocation$
DECLARE
  site record;
  target regprocedure;
  definition text;
  count_of integer;
BEGIN
  FOR site IN SELECT * FROM (VALUES
    ('opengeni_private.prevent_personal_connection_authority_mutation()',
      E'        OR NEW.visibility IS NOT DISTINCT FROM OLD.visibility\n',
      ''),
    ('opengeni_private.fence_mcp_account_bindings()',
      E'  PERFORM opengeni_private.validate_mcp_account_bindings(bindings,delegations);\n',
      $patch$  PERFORM opengeni_private.validate_mcp_account_bindings(bindings,
    CASE WHEN TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'sessions'
      AND bindings IS NOT DISTINCT FROM old_bindings
      AND coalesce(old_document -> 'initial_personal_connection_delegations', '[]'::jsonb)
        @> coalesce(delegations, '[]'::jsonb)
    -- 0873: revocation narrows delegations; accepted bindings stay as evidence.
    THEN old_document -> 'initial_personal_connection_delegations'
    ELSE delegations END);
$patch$)
  ) AS sites(signature, anchor, replacement)
  LOOP
    target := pg_catalog.to_regprocedure(site.signature);
    IF target IS NULL THEN
      RAISE EXCEPTION '0873 % is missing', site.signature USING ERRCODE = '55000';
    END IF;
    definition := pg_catalog.pg_get_functiondef(target);
    count_of := (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, site.anchor, '')))
      / pg_catalog.length(site.anchor);
    IF count_of <> 1 THEN
      RAISE EXCEPTION '0873 % drift', site.signature USING ERRCODE = '55000';
    END IF;
    EXECUTE pg_catalog.replace(definition, site.anchor, site.replacement);
  END LOOP;
END
$binding_delegation_revocation$;
