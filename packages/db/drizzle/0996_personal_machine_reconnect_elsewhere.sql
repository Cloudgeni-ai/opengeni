-- deployment-mode: rolling
-- online-safety-exception: nonconcurrent-index: enrollments holds one row per connected machine, a few per person, so both partial indexes build instantly.
-- contract-step: no release names enrollments_user_pubkey_idx or uses it as a conflict target; the active-only unique index below keeps its live invariant, so the previous release is unaffected.
-- A personal machine that was removed can be connected again from any
-- workspace its owner uses. Before, finalize_scoped_enrollment reused the
-- owner's enrollment for the machine's key wherever it was, removed or not,
-- and a finalize from any other workspace was refused: a machine removed from
-- the workspace it was first connected from could only ever come back there.
--
-- Now an owner has at most one LIVE personal enrollment per key (still
-- refused from other workspaces while it is live, as before), and at most one
-- per key in each workspace. A removed one in another workspace stays as that
-- workspace's history (its sandbox, chats and grants keep pointing at it) and
-- a fresh enrollment is made here. A removed one in this workspace is
-- reactivated as before. Previous binaries call this same function and get
-- the same answers, plus a success where they used to be refused.
SET LOCAL lock_timeout = '5s';
CREATE UNIQUE INDEX enrollments_user_workspace_pubkey_idx
  ON enrollments (account_id, owner_organization_membership_id, pubkey, workspace_id)
  WHERE authority_scope = 'user';
CREATE UNIQUE INDEX enrollments_user_active_pubkey_idx
  ON enrollments (account_id, owner_organization_membership_id, pubkey)
  WHERE authority_scope = 'user' AND status = 'active';
DROP INDEX enrollments_user_pubkey_idx;

DO $repair$
DECLARE
  target regprocedure;
  definition text;
  old_fragment text := $old$      OR (p_scope = 'user'
        AND enrollment.owner_organization_membership_id = owner_membership.id))
  ORDER BY enrollment.created_at DESC LIMIT 1 FOR UPDATE;$old$;
  new_fragment text := $new$      OR (p_scope = 'user'
        AND enrollment.owner_organization_membership_id = owner_membership.id
        -- The owner's live personal machine wherever it is, else one removed
        -- from this workspace. One removed elsewhere is that workspace's history.
        AND (enrollment.status = 'active' OR enrollment.workspace_id = p_workspace_id)))
  ORDER BY (enrollment.status = 'active') DESC, enrollment.created_at DESC
  LIMIT 1 FOR UPDATE;$new$;
BEGIN
  target := pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.finalize_scoped_enrollment(uuid,uuid,text,text,boolean,boolean,text,text,text,boolean)',
    pg_catalog.current_schema()
  ));
  definition := pg_catalog.pg_get_functiondef(target);
  IF target IS NULL OR (length(definition) - length(replace(definition, old_fragment, '')))
      / length(old_fragment) <> 1 THEN
    RAISE EXCEPTION '0996 personal enrollment lookup definition drift' USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, old_fragment, new_fragment);
END $repair$;
