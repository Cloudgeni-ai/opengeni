-- deployment-mode: rolling
-- Migration 0302: own sessions created in a managed human's OWN personal
-- workspace, and stop the write fence from silently minting a NULL owner when
-- an owner does exist.
--
-- THE DEFECT
-- ----------
-- 0225's `guard_session_authority_write` resolves a new session's owner from
-- the creator's active `organization_memberships` row, but gates that
-- resolution on an `EXISTS (workspace_memberships ...)` row in the session's
-- workspace. A managed human's personal workspace DELIBERATELY has no
-- `workspace_memberships` row: 0219's provisioning capability treats one as a
-- hard error ('managed-human personal workspace already has runtime access',
-- 42501), and docs/organization-tenancy.md states the owner-only access
-- projection is an `AccessContext` grant rather than a durable membership row.
--
-- The EXISTS can therefore never be satisfied in a personal workspace, the
-- `SELECT ... INTO` finds nothing, and the session is written with
-- `owner_organization_membership_id = NULL`. Consequence: a human in the one
-- workspace where they are by construction the ONLY possible member cannot own
-- their own sessions, so those sessions can never become `user_private` and can
-- never carry that human's personal connections or Documents. 0297 already
-- names this exact population ("A MANAGED HUMAN IN THEIR OWN PERSONAL
-- WORKSPACE") and repairs it historically; nothing stopped the mint.
--
-- THE FIX, AND WHY IT IS NOT AN INFERENCE
-- ---------------------------------------
-- Accept `membership.personal_workspace_id = NEW.workspace_id` as an
-- ALTERNATIVE to the `workspace_memberships` EXISTS. This is exactly the shape
-- 0258's `ensure_personal_document_authority` already uses for Documents
-- (`IF member_row.personal_workspace_id IS DISTINCT FROM p_workspace_id THEN`
-- require the workspace membership), and exactly the convergence 0297's
-- backfill uses.
--
-- Phase D forbids inferring user authority from `created_by`, connection
-- attribution, a default workspace, a resource name, or current access. This is
-- none of those: the membership row ITSELF names the workspace in its own
-- `personal_workspace_id` column, written by the 0219 lifecycle capability. It
-- is STATED authority read from the authority table, not derived evidence. The
-- pointer is 1:1 - 0218's unique
-- `organization_memberships_personal_workspace_idx` on
-- (account_id, personal_workspace_id) means at most one membership can name a
-- given workspace, and `organization_memberships_account_subject_idx` means at
-- most one membership exists per (account, subject). There is no second
-- candidate to disambiguate.
--
-- The ordinary shared-workspace path is UNCHANGED. A human with no
-- `workspace_memberships` row in an ordinary workspace still resolves to no
-- owner there, because the new disjunct only fires for the workspace their own
-- membership row points at.
--
-- MAKING THE SILENT MISS LOUD
-- ---------------------------
-- The original `SELECT ... INTO` has no `IF NOT FOUND` handling, so "this
-- session legitimately has no human owner" and "the resolver failed to project
-- an owner that exists" are byte-identical outcomes. That is precisely why the
-- defect above stayed invisible for seven migrations.
--
-- Genuinely-ownerless cases are preserved verbatim and must stay NULL:
--   * `created_by_kind <> 'subject'` (service initiators, the scheduler, the
--     pre-0096 `unattributed-legacy` default) never enters this branch at all;
--   * `api_key:*` / `configured:*` subjects, which 0219 and 0263 gate to
--     `user:%` and which can therefore never acquire an organization anchor;
--   * a `user:` subject with no ACTIVE organization membership;
--   * a `user:` subject with an active membership but no stated authority over
--     an ordinary shared workspace.
--
-- What is now loud instead: a `subject`-kind creator who HAS an active
-- organization membership, inserting into a workspace that is the
-- `personal_workspace_id` of an active membership, that still resolved to no
-- owner. A personal workspace has exactly one possible human owner by
-- construction (the 1:1 unique index above) and deliberately carries no
-- `workspace_memberships` row, so an unowned subject-created session there is a
-- resolver defect, not a legitimate `workspace_shared` session. It raises
-- SQLSTATE 55000 rather than writing NULL.
--
-- This cannot fire on the repaired path: when the creator IS the personal
-- workspace's member the new disjunct resolves them. It fires only when the two
-- durable facts disagree - a subject creating a session inside somebody else's
-- personal workspace, which 0219's access model makes unreachable - or if a
-- future change breaks the resolver again. A SUSPENDED or REVOKED member is
-- excluded from both the resolver and the classifier by the same
-- `status = 'active'` predicate, so their personal-workspace sessions stay
-- ownerless without raising, exactly as before.
--
-- ROLLING SAFETY
-- --------------
-- This migration replaces one function body and nothing else: no column, index,
-- constraint, policy, grant, or trigger definition changes. Old API and worker
-- images keep running against it unchanged - they never name the owner columns
-- on INSERT, which is what makes the derivation branch fire in the first place.
-- The new behaviour is strictly a widening plus an assertion over a population
-- that 0219 makes unreachable. There is no data rewrite here; historical rows
-- remain the shipped `bun run db:backfill-session-ownership` seam's job (0297).

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $session_personal_workspace_ownership$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.guard_session_authority_write()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      resolved_owner_id uuid;
      resolved_owner_subject_id text;
      creator_has_active_membership boolean;
      owner_provenance_supplied boolean :=
        NEW.owner_organization_membership_id IS NOT NULL
        OR NEW.owner_subject_id IS NOT NULL;
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
    BEGIN
      IF TG_OP = 'INSERT'
        AND NEW.owner_organization_membership_id IS NULL
        AND NEW.owner_subject_id IS NULL
      THEN
        IF NEW.parent_session_id IS NOT NULL THEN
          SELECT parent.owner_organization_membership_id, parent.owner_subject_id
          INTO resolved_owner_id, resolved_owner_subject_id
          FROM sessions parent
          WHERE parent.account_id = NEW.account_id
            AND parent.workspace_id = NEW.workspace_id
            AND parent.id = NEW.parent_session_id;
        ELSIF NEW.created_by_kind = 'subject'
          AND NEW.created_by_subject_id IS NOT NULL
        THEN
          PERFORM pg_catalog.set_config(
            'opengeni.organization_tenancy_lifecycle',
            'session_visibility_activation',
            true
          );
          SELECT membership.id, membership.subject_id
          INTO resolved_owner_id, resolved_owner_subject_id
          FROM organization_memberships membership
          WHERE membership.account_id = NEW.account_id
            AND membership.subject_id = NEW.created_by_subject_id
            AND membership.status = 'active'
            AND (
              -- Stated authority, read from the authority row itself: a managed
              -- human's personal workspace has no workspace_memberships row by
              -- design (0219), so the membership's own personal-workspace
              -- pointer is the authority for exactly that one workspace. Same
              -- shape as 0258's personal Document authority.
              --
              -- Restricted to `user:%%` because 0219 and 0263 gate the ENTIRE
              -- managed-human lifecycle - provisioning, invitation, acceptance
              -- - to that prefix. A personal-workspace pointer on an
              -- `api_key:`/`configured:` membership is not a shape any
              -- lifecycle can produce, and 0297's classifier calls that lane
              -- (`external_lane_owns_row`) permanently unrepairable. The write
              -- path must not attribute what the classifier refuses.
              (
                NEW.created_by_subject_id LIKE 'user:%%'
                AND membership.personal_workspace_id = NEW.workspace_id
              )
              OR EXISTS (
                SELECT 1
                FROM workspace_memberships workspace_membership
                WHERE workspace_membership.account_id = NEW.account_id
                  AND workspace_membership.workspace_id = NEW.workspace_id
                  AND workspace_membership.subject_id = membership.subject_id
              )
            );
          IF NOT FOUND THEN
            -- Classify the miss instead of writing an indistinguishable NULL.
            SELECT EXISTS (
              SELECT 1
              FROM organization_memberships creator_membership
              WHERE creator_membership.account_id = NEW.account_id
                AND creator_membership.subject_id = NEW.created_by_subject_id
                AND creator_membership.status = 'active'
                AND NEW.created_by_subject_id LIKE 'user:%%'
            ) INTO creator_has_active_membership;
            IF creator_has_active_membership
              AND EXISTS (
                SELECT 1
                FROM organization_memberships personal_owner
                WHERE personal_owner.account_id = NEW.account_id
                  AND personal_owner.personal_workspace_id = NEW.workspace_id
                  AND personal_owner.status = 'active'
                  AND personal_owner.subject_id LIKE 'user:%%'
              )
            THEN
              RAISE EXCEPTION
                'session owner authority is unresolved in a personal workspace'
                USING ERRCODE = '55000';
            END IF;
            -- Otherwise genuinely ownerless: no active organization membership,
            -- or no stated authority over an ordinary shared workspace.
          END IF;
        END IF;
        NEW.owner_organization_membership_id := resolved_owner_id;
        NEW.owner_subject_id := resolved_owner_subject_id;
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle',
          CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
          true
        );
      END IF;

      IF (NEW.owner_organization_membership_id IS NULL)
          <> (NEW.owner_subject_id IS NULL)
        OR (NEW.visibility = 'user_private'
          AND NEW.owner_organization_membership_id IS NULL)
      THEN
        RAISE EXCEPTION 'session authority owner provenance is incomplete'
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'UPDATE'
        AND (
          NEW.visibility IS DISTINCT FROM OLD.visibility
          OR NEW.owner_organization_membership_id
            IS DISTINCT FROM OLD.owner_organization_membership_id
          OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
          OR NEW.authority_epoch IS DISTINCT FROM OLD.authority_epoch
          OR NEW.forked_from_session_id IS DISTINCT FROM OLD.forked_from_session_id
          OR NEW.forked_from_authority_epoch
            IS DISTINCT FROM OLD.forked_from_authority_epoch
          OR NEW.forked_from_visibility IS DISTINCT FROM OLD.forked_from_visibility
          OR NEW.forked_at IS DISTINCT FROM OLD.forked_at
          OR NEW.forked_by_organization_membership_id
            IS DISTINCT FROM OLD.forked_by_organization_membership_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM session_visibility_write_capabilities capability
          WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
            AND capability.transaction_id = pg_catalog.pg_current_xact_id()
            AND capability.capability_id = nullif(
              pg_catalog.current_setting(
                'opengeni.session_visibility_write_capability', true
              ),
              ''
            )::uuid
        )
      THEN
        RAISE EXCEPTION 'session authority changes require the lifecycle capability'
          USING ERRCODE = '42501';
      END IF;

      IF TG_OP = 'INSERT'
        AND (
          NEW.visibility <> 'workspace_shared'
          OR NEW.authority_epoch <> 1
          OR NEW.forked_from_session_id IS NOT NULL
          OR NEW.forked_from_authority_epoch IS NOT NULL
          OR NEW.forked_from_visibility IS NOT NULL
          OR NEW.forked_at IS NOT NULL
          OR NEW.forked_by_organization_membership_id IS NOT NULL
          OR owner_provenance_supplied
        )
        AND NOT EXISTS (
          SELECT 1
          FROM session_visibility_write_capabilities capability
          WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
            AND capability.transaction_id = pg_catalog.pg_current_xact_id()
            AND capability.capability_id = nullif(
              pg_catalog.current_setting(
                'opengeni.session_visibility_write_capability', true
              ),
              ''
            )::uuid
        )
      THEN
        RAISE EXCEPTION 'non-default session authority requires the lifecycle capability'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'COMMENT ON FUNCTION %I.guard_session_authority_write() IS %L',
    data_schema,
    'Session authority write fence (0225, repaired by 0302). On INSERT it '
      || 'derives the owner pair from the parent session, or from the '
      || 'creator''s active organization membership when that membership '
      || 'states authority over the session workspace - either an explicit '
      || 'workspace_memberships row or the membership''s own '
      || 'personal_workspace_id pointer, which is the only authority a managed '
      || 'human''s membershipless personal workspace has. A subject-created '
      || 'session that resolves to no owner inside an active membership''s '
      || 'personal workspace raises 55000 instead of silently writing NULL.'
  );
END
$session_personal_workspace_ownership$;
