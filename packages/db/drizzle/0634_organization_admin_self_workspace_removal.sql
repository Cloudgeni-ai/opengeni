-- deployment-mode: rolling
-- An organization owner or administrator defines shared-workspace access for
-- every active member, including themself. 0332/0350 already let them grant
-- or change their own access through the organization control plane; this
-- lets the same capability-fenced removal revoke it too. The ordinary
-- workspace route keeps its self-removal guard: only the transaction-local
-- capability opened by the organization route waives it, exactly as it
-- already waives the last-administering-member guard.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $patch$
DECLARE
  definition text;
  anchor text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.assert_workspace_membership_removal_actor(uuid,uuid,text,text)'::regprocedure);
  anchor := E'  IF p_actor_subject = p_target_subject THEN\n'
    || E'    RAISE EXCEPTION ''a member cannot remove their own workspace membership''\n'
    || E'      USING ERRCODE = ''55000'';\n'
    || E'  END IF;\n';
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '0634 self-removal guard drift' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, anchor, '');
  anchor := E'  ) INTO actor_is_organization_administrator;\n';
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '0634 organization administrator anchor drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor, anchor
    || E'  IF p_actor_subject = p_target_subject\n'
    || E'    AND NOT actor_is_organization_administrator\n'
    || E'  THEN\n'
    || E'    RAISE EXCEPTION ''a member cannot remove their own workspace membership''\n'
    || E'      USING ERRCODE = ''55000'';\n'
    || E'  END IF;\n');
END
$patch$;
