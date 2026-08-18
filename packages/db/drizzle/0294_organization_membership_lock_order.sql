-- deployment-mode: rolling
-- Migration 0294 (OPE-275): correct the organization-membership lifecycle lock
-- order.
--
-- THE BUG
-- -------
-- `prepare_organization_membership_protocol_settlements` (0263), the wrapped
-- `organization_membership_command_0263` (0263), and the
-- `organization_membership_command` wrapper (0275) all opened with
--
--     PERFORM 1 FROM managed_accounts account
--     WHERE account.id = account_id_value FOR UPDATE;
--
-- and only afterwards took the canonical per-workspace prefix
-- (`workspace_inference_controls FOR SHARE` -> `workspaces FOR KEY SHARE`).
-- That is organization-row-first, workspace-row-second.
--
-- Every ordinary workspace writer is forced into the opposite order and cannot
-- avoid it. It locks its `workspaces` row first (AGENTS.md's canonical
-- event-write prefix; `transition_session_visibility` from 0225 takes it
-- `FOR UPDATE`), and then reaches `managed_accounts` IMPLICITLY through the
-- account foreign-key check of a row it inserts - `sessions`, `session_events`,
-- `session_turns`, `session_goals` and `session_system_updates` all reference
-- `managed_accounts`, and an FK check takes `FOR KEY SHARE` on the referenced
-- row. `FOR KEY SHARE` conflicts with `FOR UPDATE`, so the two writers form a
-- textbook cycle:
--
--     transition_session_visibility   holds workspaces       waits managed_accounts
--     prepare_organization_membership holds managed_accounts waits workspaces
--
-- An administrator suspending or offboarding a member concurrently with any
-- ordinary workspace write in the same organization deadlocks (40P01).
--
-- THE FIX
-- -------
-- The organization row lock was doing two unrelated jobs: (a) proving the
-- organization exists and cannot be deleted underneath the command, and (b)
-- serializing concurrent membership commands for the same organization. Only
-- (b) needed `FOR UPDATE`, and (b) does not need a row lock at all.
--
--   * (b) moves to `pg_advisory_xact_lock` keyed on the organization id. Every
--     membership lifecycle entry point takes it, so two membership commands for
--     the same organization still serialize exactly as before. It lives in the
--     advisory lock space, which no ordinary workspace writer touches, so it can
--     never appear in a cycle with a `workspaces`/`managed_accounts` row lock.
--     It is transaction-scoped and re-grantable within one transaction, so the
--     0275 wrapper, the preparation seam, and the wrapped 0263 body all take it
--     reentrantly inside the one `updateOrganizationMember` transaction.
--   * (a) stays as a row lock but downgrades to `FOR KEY SHARE`, which still
--     blocks DELETE and primary-key UPDATE of the organization row while being
--     compatible with the FK `FOR KEY SHARE` that every ordinary workspace
--     writer takes. The lifecycle therefore no longer holds a conflicting lock
--     on `managed_accounts` while it reaches for `workspaces`.
--
-- After this migration the lifecycle's first ROW lock is `workspaces
-- FOR KEY SHARE`, i.e. the canonical prefix AGENTS.md documents, and its
-- `managed_accounts` touch is compatible with every ordinary writer's FK check.
-- This is the same shape migration 0278 already uses for the workspace
-- membership removal seam (advisory fence + canonical workspace prefix, no
-- organization-row `FOR UPDATE`).
--
-- Availability note: the old `FOR UPDATE` also stalled EVERY session/event/turn
-- insert in the whole organization for the duration of a membership command,
-- because each of those inserts needs the account FK check. `FOR KEY SHARE`
-- removes that org-wide write stall as well.
--
-- WHY THIS IS A TEXT PATCH
-- ------------------------
-- The three bodies are ~1,300 lines of proven authority logic (CAS, receipts,
-- FORCE-RLS GUC juggling, per-workspace settlement). Restating them here to
-- change one statement each would fork them and risk a silent transcription
-- error. Instead each body is read back with `pg_get_functiondef` - which
-- reproduces the exact stored source plus the exact current `SET search_path`
-- and `SECURITY DEFINER` posture, and whose `CREATE OR REPLACE` preserves owner,
-- privileges and comments - and exactly one statement is rewritten. Every patch
-- fails closed: an entry point whose body matches none of the three known
-- account-lock spellings, or matches one of them more than once, aborts the
-- migration.
--
-- The three known spellings are tried against every entry point rather than
-- pinned per name, because `organization_membership_command` has two legitimate
-- shapes: the 0275 wrapper (when 0275 has run, with the 0263 body preserved
-- beside it as `organization_membership_command_0263`), or the 0263 body itself
-- (when it has not). The two always-present entry points are required;
-- `organization_membership_command_0263` is patched only when it exists, since
-- its absence simply means the pre-0275 shape.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $membership_lock_order$
DECLARE
  signature text;
  patch record;
  definition text;
  patched text;
  occurrences integer;
  applied integer;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'prepare_organization_membership_protocol_settlements(jsonb)',
    'organization_membership_command_0263(jsonb)',
    'organization_membership_command(jsonb)'
  ] LOOP
    -- Resolve in this deployment's own data schema rather than through the
    -- search_path: a dedicated-schema migration run also carries `public`.
    definition := pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        pg_catalog.quote_ident(pg_catalog.current_schema()) || '.' || signature
      )
    );
    IF definition IS NULL THEN
      IF signature = 'organization_membership_command_0263(jsonb)' THEN
        -- Pre-0275 shape: the 0263 body still lives under its original name and
        -- is patched as `organization_membership_command` below.
        CONTINUE;
      END IF;
      RAISE EXCEPTION
        'organization membership lifecycle function % is missing', signature
        USING ERRCODE = '55000';
    END IF;
    applied := 0;
    FOR patch IN
    SELECT *
    FROM (VALUES
      (
$old_prepare$  PERFORM 1 FROM managed_accounts account
  WHERE account.id = account_id_value FOR UPDATE;
$old_prepare$,
$new_prepare$  -- OPE-275: the organization fence is an advisory lock, not a row lock.
  -- `FOR UPDATE` on managed_accounts conflicts with the FK `FOR KEY SHARE`
  -- every ordinary workspace writer takes, and this seam reaches for
  -- `workspaces` afterwards, so holding it inverted the canonical order.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || account_id_value::text, 0
  ));
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = account_id_value FOR KEY SHARE;
$new_prepare$
      ),
      (
$old_command$  PERFORM 1 FROM managed_accounts account WHERE account.id = account_id_value FOR UPDATE;
$old_command$,
$new_command$  -- OPE-275: advisory organization fence plus a non-conflicting row lock
  -- (see the header: `FOR UPDATE` here inverted the canonical order).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || account_id_value::text, 0
  ));
  PERFORM 1 FROM managed_accounts account WHERE account.id = account_id_value FOR KEY SHARE;
$new_command$
      ),
      (
$old_wrapper$  -- The account row is the organization-lifecycle prefix. It makes the
  -- following non-locking identity reads stable against another command.
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = account_id_value
  FOR UPDATE;
$old_wrapper$,
$new_wrapper$  -- The organization advisory fence is the organization-lifecycle prefix. It
  -- makes the following non-locking identity reads stable against another
  -- membership command without conflicting with the FK `FOR KEY SHARE` that
  -- every ordinary workspace writer takes on this same row (OPE-275).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || account_id_value::text, 0
  ));
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = account_id_value
  FOR KEY SHARE;
$new_wrapper$
      )
    ) AS candidate(old_text, new_text)
    LOOP
      occurrences := (
        pg_catalog.length(definition)
          - pg_catalog.length(pg_catalog.replace(definition, patch.old_text, ''))
      ) / pg_catalog.length(patch.old_text);
      IF occurrences = 0 THEN
        CONTINUE;
      END IF;
      IF occurrences <> 1 THEN
        RAISE EXCEPTION
          'organization membership lifecycle function % has % copies of an '
          'expected account lock prefix (at most one required)',
          signature, occurrences
          USING ERRCODE = '55000';
      END IF;
      patched := pg_catalog.replace(definition, patch.old_text, patch.new_text);
      IF pg_catalog.strpos(patched, patch.new_text) = 0
        OR pg_catalog.strpos(patched, patch.old_text) > 0
      THEN
        RAISE EXCEPTION
          'organization membership lifecycle lock rewrite for % did not apply',
          signature
          USING ERRCODE = '55000';
      END IF;
      applied := applied + 1;
      EXECUTE patched;
    END LOOP;
    IF applied <> 1 THEN
      RAISE EXCEPTION
        'organization membership lifecycle function % matched % known account '
        'lock spellings (exactly one required)', signature, applied
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$membership_lock_order$;

-- Fail closed if any lifecycle entry point still holds a conflicting
-- organization row lock, or lost the advisory fence that replaces it.
DO $membership_lock_order_verification$
DECLARE
  signature text;
  definition text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'prepare_organization_membership_protocol_settlements(jsonb)',
    'organization_membership_command_0263(jsonb)',
    'organization_membership_command(jsonb)'
  ] LOOP
    definition := pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        pg_catalog.quote_ident(pg_catalog.current_schema()) || '.' || signature
      )
    );
    IF definition IS NULL THEN
      IF signature = 'organization_membership_command_0263(jsonb)' THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION
        'organization membership lifecycle function % is missing', signature
        USING ERRCODE = '55000';
    END IF;
    IF pg_catalog.strpos(
      definition,
      'pg_advisory_xact_lock(pg_catalog.hashtextextended('
    ) = 0 OR pg_catalog.strpos(
      definition, '''organization-membership:'' || account_id_value::text'
    ) = 0 THEN
      RAISE EXCEPTION
        'organization membership lifecycle function % lost its advisory organization fence',
        signature USING ERRCODE = '55000';
    END IF;
    IF pg_catalog.strpos(definition, 'FROM managed_accounts account') = 0
      OR definition ~ 'FROM managed_accounts account[^;]*FOR UPDATE'
    THEN
      RAISE EXCEPTION
        'organization membership lifecycle function % still locks the organization row FOR UPDATE',
        signature USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$membership_lock_order_verification$;

COMMENT ON FUNCTION prepare_organization_membership_protocol_settlements(jsonb) IS
  'Locks the exact turns whose pending protocol state a suspend/offboard must settle. '
  'Lock order (OPE-275): advisory organization fence '
  '(hashtextextended(''organization-membership:<organization id>'')) -> managed_accounts '
  'FOR KEY SHARE -> per-workspace workspace_inference_controls FOR SHARE + workspaces '
  'FOR KEY SHARE -> organization_memberships FOR UPDATE -> sessions FOR NO KEY UPDATE -> '
  'session_turns FOR UPDATE -> session_turn_attempts FOR UPDATE. Never take a conflicting '
  'row lock on managed_accounts here: ordinary workspace writers reach that row through an '
  'FK FOR KEY SHARE check while already holding their workspaces row.';

-- Only present in the post-0275 shape.
DO $membership_lock_order_body_comment$
BEGIN
  IF pg_catalog.to_regprocedure(
    pg_catalog.quote_ident(pg_catalog.current_schema())
      || '.organization_membership_command_0263(jsonb)'
  ) IS NOT NULL THEN
    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %I.organization_membership_command_0263(jsonb) IS %L',
      pg_catalog.current_schema(),
      'Migration 0263 organization membership lifecycle body, wrapped by '
      'organization_membership_command since migration 0275. Takes the same advisory '
      'organization fence and managed_accounts FOR KEY SHARE as its wrapper (OPE-275); the '
      'advisory lock is transaction-scoped and re-grantable, so the nested acquisition is a '
      'no-op within one command transaction.'
    );
  END IF;
END
$membership_lock_order_body_comment$;

COMMENT ON FUNCTION organization_membership_command(jsonb) IS
  'Organization membership lifecycle command (invite, accept, revoke_invitation, '
  'change_role, suspend, reactivate, offboard, retention). Mutual exclusion between '
  'concurrent commands for one organization is the advisory fence '
  'hashtextextended(''organization-membership:<organization id>''), not a managed_accounts '
  'row lock (OPE-275). CAS on organization_memberships.authorization_revision and the '
  'operation-receipt idempotency are unchanged.';
