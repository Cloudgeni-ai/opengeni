-- deployment-mode: rolling
-- Membership fences no longer block foreign-key checks.
--
-- A session row names its owner's organization membership through a foreign
-- key. PostgreSQL re-checks that key, taking FOR KEY SHARE on the membership,
-- whenever a transaction updates a session row it already updated (a turn
-- transition writes its session more than once). Three request paths fenced
-- the caller's membership with FOR UPDATE and then wrote session rows:
-- external identity resolution (every request from a product's own user),
-- session visibility transitions and session forks. FOR UPDATE is the one row
-- lock that conflicts with FOR KEY SHARE, so a fence holding the membership
-- while waiting for a session row, and a turn holding that session row while
-- re-checking its owner key, waited on each other until PostgreSQL aborted one
-- of them with a deadlock (40P01).
--
-- None of these routines deletes the membership or changes its key; they only
-- read it and need it to stay unchanged until commit. FOR NO KEY UPDATE gives
-- exactly that: it still conflicts with every membership writer (a status or
-- role change takes FOR NO KEY UPDATE, a deletion FOR UPDATE) and with other
-- fences, and differs only by letting foreign-key checks through. Signatures
-- and behaviour are otherwise unchanged, so the previous release keeps calling
-- the same functions.
--
-- Each routine is patched from its installed definition. The preflight
-- confirms every anchor matches exactly once; the postflight confirms no
-- patched routine still locks a membership FOR UPDATE.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $preflight$
DECLARE
  target record;
  definition text;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('ensure_external_identity(uuid,text,text)'::regprocedure,
      E'FROM organization_memberships\n    WHERE id = identity_row.organization_membership_id AND account_id = p_account_id FOR UPDATE;'),
    ('transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text,integer)'::regprocedure,
      E'FROM organization_memberships membership\n  WHERE membership.account_id = p_account_id\n    AND membership.subject_id = p_actor_subject_id\n    AND membership.status = ''active''\n  FOR UPDATE;'),
    ('fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer)'::regprocedure,
      E'FROM organization_memberships membership\n  WHERE membership.account_id = p_account_id\n    AND membership.subject_id = p_actor_subject_id\n    AND membership.status = ''active''\n  FOR UPDATE;'),
    ('fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure,
      E'FROM organization_memberships membership\n  WHERE membership.account_id = p_account_id\n    AND membership.subject_id = p_actor_subject_id\n    AND membership.status = ''active''\n  FOR UPDATE;')
  ) AS anchors(routine, anchor) LOOP
    definition := pg_get_functiondef(target.routine);
    IF (length(definition) - length(replace(definition, target.anchor, ''))) / length(target.anchor) <> 1 THEN
      RAISE EXCEPTION 'membership fence rewrite did not match exactly once in %', target.routine;
    END IF;
  END LOOP;
END
$preflight$;

DO $migration$
DECLARE
  target record;
  definition text;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('ensure_external_identity(uuid,text,text)'::regprocedure,
      E'FROM organization_memberships\n    WHERE id = identity_row.organization_membership_id AND account_id = p_account_id FOR UPDATE;',
      E'FROM organization_memberships\n    WHERE id = identity_row.organization_membership_id AND account_id = p_account_id FOR NO KEY UPDATE;'),
    ('transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text,integer)'::regprocedure,
      E'FROM organization_memberships membership\n  WHERE membership.account_id = p_account_id\n    AND membership.subject_id = p_actor_subject_id\n    AND membership.status = ''active''\n  FOR UPDATE;',
      E'FROM organization_memberships membership\n  WHERE membership.account_id = p_account_id\n    AND membership.subject_id = p_actor_subject_id\n    AND membership.status = ''active''\n  FOR NO KEY UPDATE;'),
    ('fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer)'::regprocedure,
      E'FROM organization_memberships membership\n  WHERE membership.account_id = p_account_id\n    AND membership.subject_id = p_actor_subject_id\n    AND membership.status = ''active''\n  FOR UPDATE;',
      E'FROM organization_memberships membership\n  WHERE membership.account_id = p_account_id\n    AND membership.subject_id = p_actor_subject_id\n    AND membership.status = ''active''\n  FOR NO KEY UPDATE;'),
    ('fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure,
      E'FROM organization_memberships membership\n  WHERE membership.account_id = p_account_id\n    AND membership.subject_id = p_actor_subject_id\n    AND membership.status = ''active''\n  FOR UPDATE;',
      E'FROM organization_memberships membership\n  WHERE membership.account_id = p_account_id\n    AND membership.subject_id = p_actor_subject_id\n    AND membership.status = ''active''\n  FOR NO KEY UPDATE;')
  ) AS rewrites(routine, anchor, replacement) LOOP
    definition := replace(pg_get_functiondef(target.routine), target.anchor, target.replacement);
    EXECUTE definition;
  END LOOP;
END
$migration$;

DO $postflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc routine
    WHERE routine.oid IN (
      'ensure_external_identity(uuid,text,text)'::regprocedure,
      'transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text,integer)'::regprocedure,
      'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer)'::regprocedure,
      'fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer,uuid)'::regprocedure
    )
    AND routine.prosrc ~* 'from\s+organization_memberships\M[^;]*\mfor\s+update\M'
  ) THEN
    RAISE EXCEPTION 'a membership fence still blocks foreign-key checks';
  END IF;
END
$postflight$;
