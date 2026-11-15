-- deployment-mode: rolling
-- The saved sandbox of chats that are all archived (docs/compute-backend.md,
-- "Archived chats").
--
-- A sandbox is kept for the chats that work in it. Since #7596 a compute
-- sandbox is deleted a day after every chat of its sandbox group is archived.
-- Other managed backends keep a stopped sandbox as a cold lease with its saved
-- workspace (a tar archive, or a Modal snapshot the checkpoint ledger keeps
-- with no expiry), and nothing released it while its chats stayed archived:
-- only deleting the chats did. So an archived chat's Modal snapshot was kept
-- for good.
--
-- opengeni_private.cold_sandboxes_of_archived_chats_v1(kept_seconds, after
-- workspace, after group, limit) lists, as routing ids only and in key order
-- after the given pair (so a group that cannot be forgotten yet never holds
-- up the rest), the groups of cold non-compute leases whose
-- chats are all archived: each chat archived by the Archive action at least
-- `kept_seconds` ago or stored by the idle archiver, a sub-chat with its root,
-- and none with work under way. The worker then forgets each group's cold
-- lease in the group's workspace RLS context, as deleting the chats does, and
-- the checkpoint ledger deletes the snapshots nothing names any more. The same
-- predicate is checked again there under the lease lock.
--
-- As 0937, 0978 and 1060 explain, the previous release rejects a runtime
-- EXECUTE grant on a definer it doesn't know, so this migration grants
-- nothing. Until a later migration grants it the pass finds nothing (as
-- before).
--
-- Rolling: one read-only definer the previous release never calls.
SET LOCAL lock_timeout = '5s';

DO $sandboxes_of_archived_chats$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.cold_sandboxes_of_archived_chats_v1(
      p_kept_seconds integer, p_after_workspace_id uuid, p_after_sandbox_group_id uuid,
      p_limit integer)
    RETURNS TABLE(account_id uuid, workspace_id uuid, sandbox_group_id uuid)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      SELECT DISTINCT ON (lease.workspace_id, lease.sandbox_group_id)
        lease.account_id, lease.workspace_id, lease.sandbox_group_id
      FROM sandbox_leases lease
      WHERE lease.liveness = 'cold'
        AND lease.backend NOT IN ('compute', 'selfhosted')
        AND (p_after_workspace_id IS NULL
          OR (lease.workspace_id, lease.sandbox_group_id)
            > (p_after_workspace_id, coalesce(p_after_sandbox_group_id,
              '00000000-0000-0000-0000-000000000000'::uuid)))
        AND EXISTS (
          SELECT 1 FROM sessions chat
          WHERE chat.workspace_id = lease.workspace_id
            AND chat.sandbox_group_id = lease.sandbox_group_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM sessions chat
          LEFT JOIN sessions root
            ON root.workspace_id = chat.workspace_id AND root.id = chat.root_session_id
          WHERE chat.workspace_id = lease.workspace_id
            AND chat.sandbox_group_id = lease.sandbox_group_id
            AND (
              chat.status IN ('queued', 'running', 'requires_action', 'recovering',
                'waiting_capacity')
              OR NOT (
                ((chat.archived_at IS NOT NULL OR chat.content_archive_state IS NOT NULL)
                  AND (chat.archived_at IS NULL OR chat.archived_at
                    <= pg_catalog.now() - pg_catalog.make_interval(secs => p_kept_seconds)))
                OR (root.id IS NOT NULL
                  AND (root.archived_at IS NOT NULL OR root.content_archive_state IS NOT NULL)
                  AND (root.archived_at IS NULL OR root.archived_at
                    <= pg_catalog.now() - pg_catalog.make_interval(secs => p_kept_seconds)))
              )
            )
        )
      ORDER BY lease.workspace_id, lease.sandbox_group_id
      LIMIT least(greatest(p_limit, 0), 1000)
    $body$
  $definition$, data_schema);
END
$sandboxes_of_archived_chats$;

REVOKE ALL ON FUNCTION opengeni_private.cold_sandboxes_of_archived_chats_v1(integer, uuid, uuid, integer)
  FROM PUBLIC;
