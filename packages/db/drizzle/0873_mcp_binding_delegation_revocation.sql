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
-- treats a cleared delegation list like a visibility change: it requires the
-- same epoch advance, unchanged owners and lifecycle capability, and clears the
-- session's accepted bindings exactly as privatization does, so no binding is
-- left without its delegation (a regranted owner can share the session again
-- and new turns start from an empty selection). A session that stays shared
-- keeps its bindings only when it is becoming shared. Every other write keeps
-- its check.
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
      E'    IF TG_TABLE_NAME = ''sessions'' AND document ->> ''visibility'' IS DISTINCT FROM old_document ->> ''visibility'' THEN\n',
      $patch$    IF TG_TABLE_NAME = 'sessions' AND (document ->> 'visibility' IS DISTINCT FROM old_document ->> 'visibility'
      -- 0873: membership revocation clears delegations under the same capability.
      OR (delegations = '[]'::jsonb
        AND old_document -> 'initial_personal_connection_delegations' IS DISTINCT FROM '[]'::jsonb
        -- Without the capability every other write keeps its original refusal.
        AND EXISTS (
          SELECT 1 FROM session_visibility_write_capabilities capability
          WHERE capability.backend_pid = pg_backend_pid()
            AND capability.transaction_id = pg_current_xact_id()
            AND capability.capability_id = nullif(current_setting('opengeni.session_visibility_write_capability',true),'')::uuid))) THEN
$patch$),
    ('opengeni_private.fence_mcp_account_bindings()',
      E'      bindings := CASE WHEN document ->> ''visibility'' = ''workspace_shared''\n',
      $patch$      bindings := CASE WHEN document ->> 'visibility' = 'workspace_shared'
        AND old_document ->> 'visibility' IS DISTINCT FROM 'workspace_shared'
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
